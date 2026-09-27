"""End-to-end processing of a single Gmail message.

Gmail -> attachments -> extraction/OCR -> rules -> AI -> final confidence ->
decision -> (DRY RUN: simulate | PRODUCTION: guarded forward) -> DB -> labels.

An error on one email never stops processing of the others.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import asdict, dataclass
from datetime import UTC, datetime

from .classification import rule_engine
from .classification.ai_classifier import AIClassification, AIClassifier, ClassificationInput
from .classification.decision_engine import decide, final_confidence
from .classification.false_negative import possible_invoice
from .config.settings import Settings
from .database.models import Email, EmailStatus
from .database.repository import Database, Repository, classification_to_json
from .documents.extractor import DocumentExtractor, ExtractionError, is_relevant
from .gmail.client import GmailAPI
from .gmail.forwarder import Forwarder
from .gmail.labels import LabelManager
from .gmail.reader import AttachmentRef, ParsedEmail, parse_message

log = logging.getLogger(__name__)

INVOICE_STATUSES = {
    EmailStatus.DRY_RUN_WOULD_FORWARD, EmailStatus.FORWARDED, EmailStatus.FORWARD_BLOCKED,
    EmailStatus.NEW_SUPPLIER_REVIEW, EmailStatus.REVIEW,
}


def now_utc() -> datetime:
    return datetime.now(UTC)


@dataclass
class AttachmentOutcome:
    filename: str
    file_type: str | None
    final_score: float
    rule_score: float
    ai_score: float | None
    ai: dict | None
    rules: dict
    error: str | None = None
    reused: bool = False
    sha256: str | None = None


class Processor:
    def __init__(
        self,
        settings: Settings,
        db: Database,
        gmail: GmailAPI,
        extractor: DocumentExtractor,
        ai: AIClassifier,
        forwarder: Forwarder,
        labels: LabelManager | None,
        notifier=None,
    ) -> None:
        self.settings = settings
        self.db = db
        self.gmail = gmail
        self.extractor = extractor
        self.ai = ai
        self.forwarder = forwarder
        self.labels = labels
        self.notifier = notifier

    # ------------------------------------------------------------------
    def process_many(self, message_ids: list[str], *, is_backfill: bool = False) -> dict[str, str]:
        results: dict[str, str] = {}
        for mid in message_ids:
            try:
                results[mid] = self.process_message(mid, is_backfill=is_backfill) or "SKIPPED"
            except Exception as exc:  # absolute last line of defence
                log.exception("Unexpected failure on %s", mid)
                self._record_error(mid, f"Unexpected: {type(exc).__name__}: {exc}")
                results[mid] = EmailStatus.ERROR
        return results

    def process_message(self, message_id: str, *, is_backfill: bool = False) -> str | None:
        with self.db.repo() as repo:
            if not repo.needs_processing(message_id, self.settings.max_processing_attempts):
                return None
            prev = repo.get_email(message_id)
            attempts = (prev.attempts if prev else 0) + 1

        try:
            msg = self.gmail.get_message(message_id)
            parsed = parse_message(msg)
        except Exception as exc:
            self._record_error(message_id, f"Gmail read failed: {type(exc).__name__}",
                               attempts=attempts)
            return EmailStatus.ERROR

        try:
            with self.db.repo() as repo:
                status = self._process_parsed(repo, parsed, attempts, is_backfill)
            return status
        except Exception as exc:
            log.exception("Processing failed for %s", message_id)
            self._record_error(message_id, f"{type(exc).__name__}: {exc}", attempts=attempts,
                               parsed=parsed)
            return EmailStatus.ERROR

    # ------------------------------------------------------------------
    def _process_parsed(self, repo: Repository, p: ParsedEmail, attempts: int,
                        is_backfill: bool) -> str:
        s = self.settings
        dry = not s.forward_switches_on
        e = repo.upsert_email(
            message_id=p.message_id, thread_id=p.thread_id, sender_name=p.sender_name[:500],
            sender_email=p.sender_email[:500], subject=(p.subject or "")[:1000],
            received_at=p.received_at, status=EmailStatus.PENDING, attempts=attempts,
            is_backfill=is_backfill, dry_run=dry, error=None,
        )
        filenames = [a.filename for a in p.attachments]
        relevant = [a for a in p.attachments if is_relevant(a.filename, a.mime_type)]

        if not relevant:
            e.status = EmailStatus.NO_ATTACHMENTS
            e.final_score = 0.0
            e.possible_invoice, e.possible_invoice_reason = possible_invoice(
                p.subject, p.sender_name, p.sender_email, filenames, p.body_text)
            repo.set_classification(e, is_invoice=False, confidence=0.0, source="none",
                                    reason="No PDF/DOC/DOCX attachment")
            return self._finish(repo, e, labels=[])

        outcomes = [self._process_attachment(repo, e, p, a) for a in relevant]
        ok = [o for o in outcomes if o.error is None]
        if not ok:
            e.status = EmailStatus.ERROR
            e.error = "; ".join(f"{o.filename}: {o.error}" for o in outcomes)[:2000]
            e.possible_invoice, e.possible_invoice_reason = possible_invoice(
                p.subject, p.sender_name, p.sender_email, filenames, p.body_text)
            repo.incr_state("total_errors")
            repo.set_state("last_error", f"{p.message_id}: {e.error[:300]}")
            repo.set_state("last_failed_processing", now_utc().isoformat())
            return self._finish(repo, e, labels=["Invoice/Error"], success=False)

        best = max(ok, key=lambda o: o.final_score)
        e.rule_score, e.ai_score, e.final_score = best.rule_score, best.ai_score, best.final_score
        ai = best.ai or {}
        ai_says_invoice = bool(ai.get("is_invoice", True)) if best.ai else True
        decision = decide(best.final_score, p.sender_email, s, is_backfill=is_backfill,
                          is_invoice=ai_says_invoice, has_ai=best.ai is not None)
        is_inv = best.final_score >= s.review_threshold
        reason = " | ".join(x for x in [
            decision.reason,
            ai.get("reason") if best.ai else "AI unavailable - rules only (capped below auto-forward)",
            best.rules.get("reason"),
        ] if x)
        repo.set_classification(
            e, is_invoice=is_inv,
            confidence=best.final_score,
            invoice_type=ai.get("invoice_type"),
            supplier=ai.get("supplier_name") or p.sender_name or p.sender_email,
            invoice_number=ai.get("invoice_number") or best.rules.get("invoice_number"),
            invoice_date=ai.get("invoice_date") or best.rules.get("invoice_date"),
            due_date=ai.get("due_date"),
            subtotal=ai.get("subtotal"), vat=ai.get("vat"), total=ai.get("total"),
            currency=ai.get("currency") or best.rules.get("currency"),
            reason=reason[:2000],
            source="ai+rules" if best.ai else "rules_only",
            best_attachment=best.filename,
        )
        e.status = decision.status
        e.would_forward = decision.would_forward
        if decision.would_forward:
            shas = [o.sha256 for o in ok if o.sha256]
            dup_id = repo.find_forwarded_duplicate(shas, e.id)
            if dup_id is not None:
                # Identical invoice file already (would have been) forwarded from
                # another email - do not send it again; ask for review instead.
                decision.status = e.status = EmailStatus.REVIEW
                decision.labels = ["Invoice/Review"] + (["Invoice/DRY-RUN"] if dry else [])
                decision.would_forward = e.would_forward = False
                reason = f"Duplicate invoice content (sha256) of {dup_id} | {reason}"
                repo.set_classification(e, reason=reason[:2000])
        partial_errors = [o for o in outcomes if o.error]
        if partial_errors:
            e.error = "; ".join(f"{o.filename}: {o.error}" for o in partial_errors)[:2000]

        if decision.status == EmailStatus.FORWARDED:
            result = self.forwarder.forward(e, repo, is_backfill=is_backfill)
            if result.forwarded:
                repo.incr_state("total_forwarded")
            elif result.existing_state == "SENT":
                # Sent in an earlier (interrupted) run - report the true state.
                e.status = EmailStatus.FORWARDED
            else:
                e.status = EmailStatus.FORWARD_BLOCKED
                e.error = ((e.error + "; ") if e.error else "") + result.reason

        if decision.status not in (EmailStatus.DRY_RUN_WOULD_FORWARD, EmailStatus.FORWARDED) \
                and (not is_inv or not ai_says_invoice):
            e.possible_invoice, e.possible_invoice_reason = possible_invoice(
                p.subject, p.sender_name, p.sender_email, filenames, p.body_text)

        if is_inv:
            repo.incr_state("total_invoices")
        if decision.would_forward:
            repo.incr_state("total_would_forward")
        if self.notifier is not None:
            self.notifier.maybe_notify(e)
        return self._finish(repo, e, labels=decision.labels)

    def _finish(self, repo: Repository, e: Email, labels: list[str], success: bool = True) -> str:
        e.processed_at = now_utc()
        repo.incr_state("total_processed")
        if success:
            repo.set_state("last_successful_processing", e.processed_at.isoformat())
        repo.commit()
        if self.labels is not None and labels:
            try:
                self.labels.apply(e.message_id, labels)
            except Exception as exc:
                log.warning("Label update failed for %s: %s", e.message_id, type(exc).__name__)
        log.info("Processed %s -> %s (score=%s)", e.message_id, e.status, e.final_score)
        return e.status

    # ------------------------------------------------------------------
    def _download(self, message_id: str, a: AttachmentRef) -> bytes:
        if a.inline_data is not None:
            return a.inline_data
        if not a.attachment_id:
            raise ExtractionError("Attachment has no data")
        return self.gmail.get_attachment(message_id, a.attachment_id)

    def _process_attachment(self, repo: Repository, e: Email, p: ParsedEmail,
                            a: AttachmentRef) -> AttachmentOutcome:
        s = self.settings
        max_bytes = s.max_attachment_size_mb * 1024 * 1024
        base = dict(attachment_key=a.key[:500], attachment_id=a.attachment_id,
                    filename=a.filename[:1000], mime_type=a.mime_type[:250], size=a.size)
        if a.size and a.size > max_bytes:
            err = f"Attachment exceeds MAX_ATTACHMENT_SIZE_MB ({a.size} bytes)"
            repo.add_attachment(e, **base, processed=True, error=err)
            return AttachmentOutcome(a.filename, None, 0.0, 0.0, None, None, {}, error=err)

        existing = repo.get_attachment(e, a.key[:500])
        try:
            data = self._download(p.message_id, a)
        except Exception as exc:
            err = f"Download failed: {type(exc).__name__}"
            repo.add_attachment(e, **base, processed=False, error=err)
            return AttachmentOutcome(a.filename, None, 0.0, 0.0, None, None, {}, error=err)
        if len(data) > max_bytes:
            err = "Attachment exceeds MAX_ATTACHMENT_SIZE_MB"
            repo.add_attachment(e, **base, processed=True, error=err)
            return AttachmentOutcome(a.filename, None, 0.0, 0.0, None, None, {}, error=err)

        sha = hashlib.sha256(data).hexdigest()
        base.update(sha256=sha, size=len(data))

        # Duplicate attachment: identical content already analysed -> reuse.
        prior = repo.find_processed_by_sha(sha)
        if prior is not None and (
                existing is None or prior.id != existing.id):
            saved = json.loads(prior.classification_json)
            out = AttachmentOutcome(**{**saved, "filename": a.filename, "reused": True,
                                       "sha256": sha})
            repo.add_attachment(e, **base, processed=True, extraction_method="reused",
                                text_chars=prior.text_chars, is_invoice=prior.is_invoice,
                                final_score=prior.final_score, rule_score=prior.rule_score,
                                ai_score=prior.ai_score,
                                classification_json=prior.classification_json, error=None)
            return out

        try:
            ext = self.extractor.extract(data, a.filename, a.mime_type)
        except ExtractionError as exc:
            err = str(exc)[:500]
            repo.add_attachment(e, **base, processed=True, error=err)
            return AttachmentOutcome(a.filename, None, 0.0, 0.0, None, None, {}, error=err)

        rules = rule_engine.evaluate(ext.text)
        rules_dict = {"score": rules.score, "indicators": rules.indicators,
                      "invoice_number": rules.invoice_number, "invoice_date": rules.invoice_date,
                      "currency": rules.currency, "reason": rules.reason}

        ai_result: AIClassification | None = None
        ai_error: str | None = None
        if self.ai.available and ext.text.strip():
            try:
                ai_result = self.ai.classify(ClassificationInput(
                    sender_name=p.sender_name, sender_email=p.sender_email, subject=p.subject,
                    body=p.body_text, filename=a.filename, document_text=ext.text,
                    extraction_method=ext.method))
            except Exception as exc:
                ai_error = f"AI failed: {type(exc).__name__}"
                log.warning("AI classification failed for %s: %s", p.message_id, ai_error)
        score = final_confidence(ai_result, rules, s)
        ai_score = None
        if ai_result is not None:
            ai_score = round(ai_result.confidence if ai_result.is_invoice
                             else 1 - ai_result.confidence, 4)
        if ai_error:
            rules_dict["reason"] = f"{rules_dict['reason']} ({ai_error})"
        out = AttachmentOutcome(
            filename=a.filename, file_type=ext.file_type, final_score=score,
            rule_score=rules.score, ai_score=ai_score,
            ai=ai_result.model_dump() if ai_result else None, rules=rules_dict, sha256=sha,
        )
        saved = asdict(out)
        saved.pop("filename")
        saved.pop("reused")
        saved.pop("error")
        saved.pop("sha256")
        repo.add_attachment(
            e, **base, processed=True, extraction_method=ext.method, text_chars=len(ext.text),
            is_invoice=score >= s.review_threshold, final_score=score, rule_score=rules.score,
            ai_score=ai_score,
            # Only cache the classification when AI succeeded (or isn't configured)
            # so a transient AI failure is retried for duplicates later.
            classification_json=classification_to_json(saved) if not ai_error else None,
            error=None,
            document_text=ext.text if s.store_document_text else None,
        )
        return out

    # ------------------------------------------------------------------
    def _record_error(self, message_id: str, error: str, attempts: int | None = None,
                      parsed: ParsedEmail | None = None) -> None:
        try:
            with self.db.repo() as repo:
                prev = repo.get_email(message_id)
                fields: dict = dict(message_id=message_id, status=EmailStatus.ERROR,
                                    error=error[:2000], processed_at=now_utc(),
                                    attempts=attempts or ((prev.attempts if prev else 0) + 1),
                                    dry_run=not self.settings.forward_switches_on)
                if parsed is not None:
                    fields.update(thread_id=parsed.thread_id, sender_name=parsed.sender_name[:500],
                                  sender_email=parsed.sender_email[:500],
                                  subject=(parsed.subject or "")[:1000],
                                  received_at=parsed.received_at)
                repo.upsert_email(**fields)
                repo.incr_state("total_errors")
                repo.incr_state("total_processed")
                repo.set_state("last_error", f"{message_id}: {error[:300]}")
                repo.set_state("last_failed_processing", now_utc().isoformat())
            if self.labels is not None:
                try:
                    self.labels.apply(message_id, ["Invoice/Error"])
                except Exception:
                    pass
        except Exception:
            log.exception("Could not record error for %s", message_id)
