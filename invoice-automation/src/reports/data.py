"""Builds report rows and summary metrics from the database."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta

from ..config.settings import Settings
from ..database.models import Email, EmailStatus
from ..database.repository import Repository

DETAIL_COLUMNS = [
    "Date", "Time", "Sender", "Sender Email", "Subject", "Message ID", "Has Attachment",
    "Attachment Count", "Attachment Names", "File Type", "Is Invoice", "Confidence",
    "Rule Score", "AI Score", "Final Score", "Supplier", "Invoice Number", "Invoice Date",
    "Invoice Total", "Currency", "Would Forward", "Actually Forwarded", "DRY RUN",
    "Possible Invoice", "Processing Status", "Error", "Reason",
]


@dataclass
class ReportData:
    report_date: date
    dry_run: bool
    rows: list[dict] = field(default_factory=list)
    summary: dict[str, int] = field(default_factory=dict)
    quality: dict[str, float | int | str] = field(default_factory=dict)
    suppliers: list[dict] = field(default_factory=list)


def report_window(d: date, settings: Settings) -> tuple[datetime, datetime]:
    """The 24h ending at DAILY_REPORT_TIME on day d (local TIMEZONE), in UTC.

    Consecutive daily reports tile time without gaps, so emails processed after
    18:00 appear in the next day's report instead of in none.
    """
    end_local = datetime.combine(
        d, time(settings.report_hour, settings.report_minute), tzinfo=settings.tz)
    start_local = datetime.combine(
        d - timedelta(days=1), time(settings.report_hour, settings.report_minute),
        tzinfo=settings.tz)
    return start_local.astimezone(UTC), end_local.astimezone(UTC)


def _file_type(name: str) -> str:
    return name.rsplit(".", 1)[-1].upper() if "." in name else ""


def email_row(e: Email, settings: Settings) -> dict:
    local = e.processed_at.astimezone(settings.tz) if e.processed_at else None
    if local is None and e.received_at:
        local = e.received_at.astimezone(settings.tz)
    names = [a.filename or "" for a in e.attachments]
    c = e.classification
    fwd = e.forward
    actually = bool(fwd and fwd.forwarded)
    actual_txt = "YES" if actually else ("NO – DRY RUN" if e.dry_run and e.would_forward else "NO")
    return {
        "Date": local.strftime("%Y-%m-%d") if local else "",
        "Time": local.strftime("%H:%M:%S") if local else "",
        "Sender": e.sender_name or "",
        "Sender Email": e.sender_email or "",
        "Subject": e.subject or "",
        "Message ID": e.message_id,
        "Has Attachment": "YES" if names else "NO",
        "Attachment Count": len(names),
        "Attachment Names": ", ".join(names),
        "File Type": ", ".join(sorted({_file_type(n) for n in names if _file_type(n)})),
        "Is Invoice": "YES" if (c and c.is_invoice) else "NO",
        "Confidence": c.confidence if c and c.confidence is not None else None,
        "Rule Score": e.rule_score,
        "AI Score": e.ai_score,
        "Final Score": e.final_score,
        "Supplier": (c.supplier if c else "") or "",
        "Invoice Number": (c.invoice_number if c else "") or "",
        "Invoice Date": (c.invoice_date if c else "") or "",
        "Invoice Total": c.total if c else None,
        "Currency": (c.currency if c else "") or "",
        "Would Forward": "YES" if e.would_forward else "NO",
        "Actually Forwarded": actual_txt,
        "DRY RUN": "YES" if e.dry_run else "NO",
        "Possible Invoice": "YES" if e.possible_invoice else "NO",
        "Processing Status": e.status,
        "Error": e.error or "",
        "Reason": "; ".join(x for x in [(c.reason if c else ""), e.possible_invoice_reason or ""]
                            if x),
        "_actually": actually,
    }


def build_report(repo: Repository, d: date, settings: Settings) -> ReportData:
    start, end = report_window(d, settings)
    emails = repo.emails_processed_between(start, end)
    dry = not settings.forward_switches_on
    rows = [email_row(e, settings) for e in emails]

    hi = settings.invoice_auto_forward_threshold
    lo = settings.review_threshold
    # Only relevant (PDF/DOC/DOCX/invoice-named image) attachments are stored.
    with_att = [e for e in emails if e.attachments]
    invoices = [e for e in emails if e.classification and e.classification.is_invoice]
    high = [e for e in emails if (e.final_score or 0) >= hi]
    med = [e for e in emails if lo <= (e.final_score or 0) < hi]
    low = [e for e in emails if e.attachments and (e.final_score or 0) < lo
           and e.status != EmailStatus.ERROR]
    would = [e for e in emails if e.would_forward]
    actual = [e for e in emails if e.forward and e.forward.forwarded]
    possible = [e for e in emails if e.possible_invoice]
    errors = [e for e in emails if e.status == EmailStatus.ERROR]
    review = [e for e in emails if e.status in (EmailStatus.REVIEW,
                                                 EmailStatus.NEW_SUPPLIER_REVIEW)]

    summary = {
        "Total Emails": len(emails),
        "Emails With Attachments": len(with_att),
        "Invoices Detected": len(invoices),
        "High Confidence": len(high),
        "Medium Confidence": len(med),
        "Low Confidence": len(low),
        "Would Be Forwarded": len(would),
        "Actually Forwarded": len(actual),
        "Review Required": len(review),
        "Possible False Negatives": len(possible),
        "Errors": len(errors),
    }

    def pct(n: int, total: int) -> float:
        return round(100.0 * n / total, 1) if total else 0.0

    n_att = len(with_att)
    quality: dict[str, float | int | str] = {
        "Invoice Detection Rate % (of emails with attachments)": pct(len(invoices), n_att),
        "High Confidence % (of invoices)": pct(len(high), len(invoices)),
        "Review % (of invoices)": pct(len(review), len(invoices)),
        "Potential False Negatives": len(possible),
        "Errors % (of all emails)": pct(len(errors), len(emails)),
        "Would Forward": len(would),
        "Actual Forward": len(actual),
        "Mode": "DRY RUN" if dry else "PRODUCTION",
    }

    sup: dict[tuple[str, str], dict] = {}
    for e in emails:
        if not e.attachments:
            continue
        name = (e.classification.supplier if e.classification else None) or e.sender_name or ""
        key = (name, e.sender_email or "")
        r = sup.setdefault(key, {"Supplier": name, "Email": e.sender_email or "", "Invoices": 0,
                                 "High Confidence": 0, "Review": 0, "Would Forward": 0,
                                 "Errors": 0})
        if e.classification and e.classification.is_invoice:
            r["Invoices"] += 1
        if (e.final_score or 0) >= hi:
            r["High Confidence"] += 1
        if e.status in (EmailStatus.REVIEW, EmailStatus.NEW_SUPPLIER_REVIEW):
            r["Review"] += 1
        if e.would_forward:
            r["Would Forward"] += 1
        if e.status == EmailStatus.ERROR:
            r["Errors"] += 1

    return ReportData(report_date=d, dry_run=dry, rows=rows, summary=summary, quality=quality,
                      suppliers=sorted(sup.values(), key=lambda r: (-r["Invoices"], r["Supplier"])))
