"""Per-invoice notification email ("an invoice was detected").

Sent ONLY to SOURCE_GMAIL_ACCOUNT, and only when that address is the
authenticated Gmail account. Contains metadata and a link to the original
message - never the invoice file itself. Each email is notified at most once
(Email.notified_at), backfilled emails are never notified (they appear in the
daily report instead).
"""

from __future__ import annotations

import html
import logging
from email.message import EmailMessage

from ..config.settings import Settings
from ..database.models import Email, EmailStatus, utcnow
from ..gmail.client import GmailAPI

log = logging.getLogger(__name__)

# Subject tag the watcher uses to ignore our own notification emails.
SUBJECT_TAG = "[Invoice Automation]"

DETECTED = {EmailStatus.DRY_RUN_WOULD_FORWARD, EmailStatus.FORWARDED,
            EmailStatus.FORWARD_BLOCKED}
REVIEW = {EmailStatus.REVIEW, EmailStatus.NEW_SUPPLIER_REVIEW}
CURRENCY_SYMBOL = {"ILS": "₪", "NIS": "₪", "USD": "$", "EUR": "€", "GBP": "£"}


def _money(total: float | None, currency: str | None) -> str:
    if total is None:
        return ""
    sym = CURRENCY_SYMBOL.get((currency or "").upper(), (currency or "") + " ")
    return f"{sym}{total:,.2f}"


def gmail_link(message_id: str) -> str:
    return f"https://mail.google.com/mail/u/0/#all/{message_id}"


def build_notification(e: Email, settings: Settings) -> tuple[str, bytes]:
    c = e.classification
    detected = e.status in DETECTED
    supplier = (c.supplier if c else None) or e.sender_name or e.sender_email or ""
    total = _money(c.total if c else None, c.currency if c else None)
    icon, kind = ("✅", "חשבונית זוהתה") if detected else ("⚠️", "לבדיקה")
    subject = " – ".join(x for x in (f"{SUBJECT_TAG} {icon} {kind}", supplier, total) if x)
    subject = " ".join(subject.split())[:200]  # no CR/LF from untrusted supplier names

    dry = not settings.forward_switches_on
    if e.status == EmailStatus.FORWARDED:
        outcome = f"הועברה אל {settings.target_gmail_account}"
    elif e.status == EmailStatus.DRY_RUN_WOULD_FORWARD:
        outcome = "הייתה מועברת במצב Production – לא הועברה (DRY RUN)"
    elif e.status == EmailStatus.FORWARD_BLOCKED:
        outcome = "זוהתה אך ההעברה נחסמה"
    elif e.status == EmailStatus.NEW_SUPPLIER_REVIEW:
        outcome = "ספק חדש – לא הועברה, דורש בדיקה"
    else:
        outcome = "ודאות בינונית – לא הועברה, דורש בדיקה"

    score = f"{e.final_score:.2f}" if e.final_score is not None else "-"
    rows = [
        ("שולח", f"{e.sender_name or ''} <{e.sender_email or ''}>"),
        ("נושא", e.subject or ""),
        ("קובץ", (c.best_attachment if c else "") or ""),
        ("ספק", supplier),
        ("מספר חשבונית", (c.invoice_number if c else "") or ""),
        ("תאריך חשבונית", (c.invoice_date if c else "") or ""),
        ("סכום כולל", total),
        ("ציון ביטחון", score),
        ("החלטה", outcome),
        ("סיבה", ((c.reason if c else "") or "")[:500]),
    ]
    link = gmail_link(e.message_id)

    text_lines = []
    if dry:
        text_lines += ["⚠ DRY RUN – המייל לא הועבר.", ""]
    text_lines += [f"{k}: {v}" for k, v in rows if v]
    text_lines += ["", f"פתח את המייל המקורי: {link}"]

    rows_html = "".join(
        f"<tr><td style='padding:4px 12px 4px 0;color:#666;white-space:nowrap'>{html.escape(k)}</td>"
        f"<td style='padding:4px 0'>{html.escape(str(v))}</td></tr>" for k, v in rows if v)
    banner = ("<p style='background:#fff2cc;padding:8px 12px;border-radius:6px'>"
              "<b>⚠ DRY RUN</b> – המייל לא הועבר.</p>") if dry else ""
    body_html = (
        "<div dir='rtl' style='font-family:Arial,sans-serif;font-size:14px'>"
        f"{banner}<table>{rows_html}</table>"
        f"<p><a href='{html.escape(link)}'>פתח את המייל המקורי ב-Gmail</a></p></div>")

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = settings.source_gmail_account
    msg["To"] = settings.source_gmail_account
    msg["X-Invoice-Automation"] = "notification"
    msg.set_content("\n".join(text_lines))
    msg.add_alternative(body_html, subtype="html")
    return subject, msg.as_bytes()


class Notifier:
    def __init__(self, settings: Settings, gmail: GmailAPI) -> None:
        self.settings = settings
        self.gmail = gmail
        self._account_ok: bool | None = None

    def enabled(self) -> bool:
        mode = self.settings.notify_detections
        if mode == "always":
            return True
        if mode == "dry_run":
            return not self.settings.forward_switches_on
        return False

    def _recipient_is_owner(self) -> bool:
        if self._account_ok is None:
            addr = self.gmail.get_profile().get("emailAddress", "")
            self._account_ok = bool(self.settings.source_gmail_account) and (
                addr.lower() == self.settings.source_gmail_account.lower())
            if not self._account_ok:
                log.warning("Notifications disabled: SOURCE_GMAIL_ACCOUNT does not match the "
                            "authenticated Gmail account")
        return self._account_ok

    def maybe_notify(self, e: Email) -> bool:
        """Send at most one notification for this email. Never raises."""
        try:
            if (not self.enabled() or e.is_backfill or e.notified_at is not None
                    or e.status not in DETECTED | REVIEW):
                return False
            if not self._recipient_is_owner():
                return False
            _, raw = build_notification(e, self.settings)
            self.gmail.send_raw(raw)
            e.notified_at = utcnow()
            return True
        except Exception as exc:
            log.warning("Detection notification failed for %s: %s", e.message_id,
                        type(exc).__name__)
            return False
