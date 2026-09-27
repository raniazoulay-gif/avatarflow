"""Forwarding of detected invoices to TARGET_GMAIL_ACCOUNT.

SAFETY: every check lives INSIDE Forwarder.forward(). Calling it directly,
from any code path, with DRY_RUN=true (or AUTO_FORWARD_ENABLED=false, or
PRODUCTION_CONFIRMATION=false) can never reach the Gmail send API.

The original email is never modified, moved or deleted: we read its raw MIME,
build a NEW message, and send that. Only the "Invoice/Forwarded" label is
added to the original afterwards.
"""

from __future__ import annotations

import email
import email.policy
import logging
from dataclasses import dataclass
from email.message import EmailMessage

from ..config.settings import Settings
from ..database.models import Email
from ..database.repository import Repository
from .client import GmailAPI

log = logging.getLogger(__name__)


class ForwardBlocked(Exception):
    """Raised by the safety guard; never results in a send."""


@dataclass
class ForwardResult:
    forwarded: bool
    reason: str
    target_message_id: str | None = None


class SafetyGuard:
    """Single source of truth for 'may we send a forward right now?'."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def check(self, *, is_backfill: bool = False) -> None:
        s = self.settings
        # Each switch is checked explicitly with identity comparison so that
        # truthy-but-wrong values (e.g. the string "false") never pass.
        if s.dry_run is not False:
            raise ForwardBlocked("DRY_RUN is enabled - forwarding disabled")
        if s.auto_forward_enabled is not True:
            raise ForwardBlocked("AUTO_FORWARD_ENABLED is false - forwarding disabled")
        if s.production_confirmation is not True:
            raise ForwardBlocked("PRODUCTION_CONFIRMATION is not true - forwarding disabled")
        if not s.target_configured:
            raise ForwardBlocked("TARGET_GMAIL_ACCOUNT NOT CONFIGURED (or same as source)")
        if is_backfill and s.backfill_forward_enabled is not True:
            raise ForwardBlocked("Backfill email and BACKFILL_FORWARD_ENABLED is false")

    def allowed(self, *, is_backfill: bool = False) -> bool:
        try:
            self.check(is_backfill=is_backfill)
            return True
        except ForwardBlocked:
            return False


def build_forward_message(raw_original: bytes, source: str, target: str) -> bytes:
    orig = email.message_from_bytes(raw_original, policy=email.policy.default)
    fwd = EmailMessage()
    subject = str(orig.get("Subject", ""))
    fwd["Subject"] = subject if subject.lower().startswith("fwd:") else f"Fwd: {subject}"
    fwd["From"] = source
    fwd["To"] = target
    fwd["X-Invoice-Automation"] = "forwarded"

    body_part = orig.get_body(preferencelist=("plain", "html"))
    body = body_part.get_content() if body_part is not None else ""
    header = (
        "---------- Forwarded message ---------\n"
        f"From: {orig.get('From', '')}\nDate: {orig.get('Date', '')}\n"
        f"Subject: {subject}\nTo: {orig.get('To', '')}\n\n"
    )
    fwd.set_content(header + (body if isinstance(body, str) else ""))

    for part in orig.iter_attachments():
        filename = part.get_filename()
        payload = part.get_payload(decode=True)
        if not filename or payload is None:
            continue
        maintype, _, subtype = part.get_content_type().partition("/")
        fwd.add_attachment(payload, maintype=maintype, subtype=subtype or "octet-stream",
                           filename=filename)
    return fwd.as_bytes()


class Forwarder:
    def __init__(self, settings: Settings, gmail: GmailAPI, labels=None) -> None:
        self.settings = settings
        self.gmail = gmail
        self.labels = labels
        self.guard = SafetyGuard(settings)

    def forward(self, email_row: Email, repo: Repository, *, is_backfill: bool = False
                ) -> ForwardResult:
        # 1) Safety guard - checked HERE, not (only) by callers.
        try:
            self.guard.check(is_backfill=is_backfill)
        except ForwardBlocked as exc:
            log.info("Forward skipped for %s: %s", email_row.message_id, exc)
            return ForwardResult(False, str(exc))

        # 2) Duplicate protection - reserve before sending; never forward twice.
        target = self.settings.target_gmail_account
        reservation = repo.reserve_forward(email_row, target)
        if reservation is None:
            return ForwardResult(False, "Already forwarded (or forward in progress) - skipped")

        # 3) Re-check right before the network call (defence in depth).
        if not self.guard.allowed(is_backfill=is_backfill):
            repo.mark_forward_failed(reservation, "Blocked by safety guard at send time")
            return ForwardResult(False, "Blocked by safety guard at send time")

        try:
            raw = self.gmail.get_raw_message(email_row.message_id)
            msg = build_forward_message(raw, self.settings.source_gmail_account or "me", target)
            sent = self.gmail.send_raw(msg)
        except Exception as exc:
            repo.mark_forward_failed(reservation, f"{type(exc).__name__}: {exc}")
            log.error("Forward failed for %s: %s", email_row.message_id, type(exc).__name__)
            return ForwardResult(False, f"Forward failed: {type(exc).__name__}")

        repo.mark_forward_sent(reservation, sent.get("id"))
        if self.labels is not None:
            try:
                self.labels.apply(email_row.message_id, ["Invoice/Forwarded"])
            except Exception:
                log.warning("Could not add Forwarded label to %s", email_row.message_id)
        log.info("Forwarded %s to target", email_row.message_id)
        return ForwardResult(True, "Forwarded", sent.get("id"))
