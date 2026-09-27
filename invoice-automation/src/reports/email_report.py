"""Daily report email.

The report is sent ONLY to SOURCE_GMAIL_ACCOUNT (the mailbox owner) and
contains our own Excel file - it never includes supplier emails or invoice
files, so it is allowed in DRY RUN mode. It is not a forward.
"""

from __future__ import annotations

import logging
import os
from datetime import date, datetime
from email.message import EmailMessage

from ..config.settings import Settings
from ..database.repository import Database
from ..gmail.client import GmailAPI
from .data import ReportData, build_report
from .excel import write_excel

log = logging.getLogger(__name__)


class ReportRecipientError(Exception):
    pass


def build_body(data: ReportData, dry_run_day: str | None = None) -> str:
    s = data.summary
    lines = []
    if data.dry_run:
        lines += ["⚠ DRY RUN MODE", "No emails were forwarded.", ""]
        if dry_run_day:
            lines += [dry_run_day, ""]
    lines += [
        "Daily Invoice Processing Report",
        "",
        f"Emails received: {s['Total Emails']}",
        f"Invoices detected: {s['Invoices Detected']}",
        f"Would be forwarded: {s['Would Be Forwarded']}",
        f"Actually forwarded: {s['Actually Forwarded']}",
        f"Review required: {s['Review Required']}",
        f"Possible false negatives: {s['Possible False Negatives']}",
        f"Errors: {s['Errors']}",
        "",
        f"DRY RUN MODE: {'YES' if data.dry_run else 'NO'}",
        "",
        "Quality:",
    ]
    lines += [f"  {k}: {v}" for k, v in data.quality.items()]
    return "\n".join(lines)


def build_report_message(data: ReportData, xlsx_path: str, settings: Settings,
                         dry_run_day: str | None = None) -> bytes:
    msg = EmailMessage()
    msg["Subject"] = f"Daily Invoice Automation Report – {data.report_date.isoformat()}"
    msg["From"] = settings.source_gmail_account
    msg["To"] = settings.source_gmail_account
    msg.set_content(build_body(data, dry_run_day))
    with open(xlsx_path, "rb") as f:
        msg.add_attachment(
            f.read(), maintype="application",
            subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            filename=os.path.basename(xlsx_path),
        )
    return msg.as_bytes()


def dry_run_progress(db: Database, settings: Settings, today: date) -> str | None:
    if settings.forward_switches_on:
        return None
    with db.repo() as repo:
        start = repo.get_state("dry_run_start_date")
        if start is None:
            start = today.isoformat()
            repo.set_state("dry_run_start_date", start)
    day = (today - date.fromisoformat(start)).days + 1
    if day <= settings.dry_run_days:
        return f"Dry-run evaluation day {day} of {settings.dry_run_days}."
    # NEVER switch automatically - only remind.
    return (f"Dry-run evaluation period ({settings.dry_run_days} days) is complete. The system "
            f"REMAINS in DRY RUN. To activate production set DRY_RUN=false, "
            f"AUTO_FORWARD_ENABLED=true, PRODUCTION_CONFIRMATION=true manually.")


def generate_daily_report(settings: Settings, db: Database, gmail: GmailAPI | None,
                          report_date: date | None = None, send: bool = True) -> dict:
    d = report_date or datetime.now(settings.tz).date()
    with db.repo() as repo:
        data = build_report(repo, d, settings)
    path = write_excel(data, settings.reports_dir)
    progress = dry_run_progress(db, settings, d)
    result = {"date": d.isoformat(), "excel": path, "sent": False, "summary": data.summary}

    if send:
        if gmail is None:
            result["send_status"] = "NOT SENT - Gmail NOT CONFIGURED"
        elif not settings.source_gmail_account:
            result["send_status"] = "NOT SENT - SOURCE_GMAIL_ACCOUNT NOT CONFIGURED"
        elif (gmail.get_profile().get("emailAddress", "").lower()
              != settings.source_gmail_account.lower()):
            # The report contains supplier/invoice metadata: only ever send it to
            # the authenticated mailbox owner.
            result["send_status"] = ("NOT SENT - SOURCE_GMAIL_ACCOUNT does not match the "
                                     "authenticated Gmail account")
        else:
            raw = build_report_message(data, path, settings, progress)
            gmail.send_raw(raw)
            result["sent"] = True
            result["send_status"] = f"SENT to {settings.source_gmail_account}"

    with db.repo() as repo:
        repo.set_state("last_daily_report", datetime.now(settings.tz).isoformat())
        repo.set_state("last_daily_report_file", path)
    log.info("Daily report %s: %s", d, result.get("send_status", "not sent"))
    return result
