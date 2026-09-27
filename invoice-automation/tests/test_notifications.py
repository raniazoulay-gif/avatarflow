"""Per-invoice notification emails."""

from __future__ import annotations

import email
import email.policy

from src.database.models import EmailStatus
from src.gmail.watcher import BASE_QUERY

from .conftest import (
    INVOICE_LINES,
    NON_INVOICE_LINES,
    PRODUCTION,
    FakeBackend,
    Harness,
    make_settings,
    make_text_pdf,
)


def _parse(raw: bytes):
    return email.message_from_bytes(raw, policy=email.policy.default)


def _add_invoice(h, mid="m1", **kw):
    h.gmail.add_message(mid, attachments=[("inv.pdf", "application/pdf",
                                           make_text_pdf(INVOICE_LINES))], **kw)


def test_dry_run_detected_invoice_sends_one_notification_to_owner_only():
    h = Harness(make_settings(), notify=True)
    _add_invoice(h)
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert len(h.gmail.sent) == 1
    msg = _parse(h.gmail.sent[0])
    assert msg["To"] == "me@example.com"
    assert "books@example.com" not in h.gmail.sent[0].decode(errors="replace")
    assert msg["Subject"].startswith("[Invoice Automation] ✅")
    assert "₪1,180.00" in msg["Subject"]
    body = msg.get_body(("plain",)).get_content()
    assert "DRY RUN" in body and "INV-2026-0917" in body
    assert "https://mail.google.com/mail/u/0/#all/m1" in body
    assert not list(msg.iter_attachments())  # never attaches the invoice file
    assert h.email("m1").notified_at is not None


def test_notification_sent_only_once():
    h = Harness(make_settings(max_processing_attempts=3), notify=True)
    _add_invoice(h)
    h.processor.process_message("m1")
    with h.db.repo() as repo:  # force a reprocess of the same email
        repo.get_email("m1").status = EmailStatus.ERROR
    h.processor.process_message("m1")
    assert len(h.gmail.sent) == 1


def test_review_invoice_notifies_with_warning():
    class Unsure(FakeBackend):
        def complete(self, system, user):
            return '{"is_invoice": true, "confidence": 0.75, "reason": "unclear"}'

    h = Harness(make_settings(), backend=Unsure(), notify=True)
    _add_invoice(h)
    assert h.processor.process_message("m1") == EmailStatus.REVIEW
    assert "⚠️ לבדיקה" in _parse(h.gmail.sent[0])["Subject"]


def test_no_notification_for_non_invoice_or_backfill():
    h = Harness(make_settings(), notify=True)
    h.gmail.add_message("n1", sender="News <n@shop.com>", subject="Newsletter",
                        attachments=[("n.pdf", "application/pdf",
                                      make_text_pdf(NON_INVOICE_LINES))])
    _add_invoice(h, "old")
    h.processor.process_message("n1")
    h.processor.process_message("old", is_backfill=True)
    assert h.gmail.sent == []


def test_no_notification_when_source_is_not_authenticated_account():
    h = Harness(make_settings(source_gmail_account="someone-else@example.com"), notify=True)
    _add_invoice(h)
    h.processor.process_message("m1")
    assert h.gmail.sent == []


def test_notify_modes():
    h = Harness(make_settings(**PRODUCTION), notify=True)  # dry_run mode, production on
    _add_invoice(h)
    assert h.processor.process_message("m1") == EmailStatus.FORWARDED
    assert len(h.gmail.sent) == 1  # the forward only, no notification

    h2 = Harness(make_settings(**PRODUCTION, notify_detections="always"), notify=True)
    _add_invoice(h2)
    h2.processor.process_message("m1")
    assert len(h2.gmail.sent) == 2  # forward + notification
    subjects = [_parse(r)["Subject"] for r in h2.gmail.sent]
    assert any(s.startswith("[Invoice Automation]") for s in subjects)

    h3 = Harness(make_settings(notify_detections="off"), notify=True)
    _add_invoice(h3)
    h3.processor.process_message("m1")
    assert h3.gmail.sent == []


def test_notification_failure_does_not_break_processing():
    h = Harness(make_settings(), notify=True)
    h.gmail.fail_send = True
    _add_invoice(h)
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert h.email("m1").notified_at is None


def test_watcher_ignores_own_notification_emails():
    assert '-subject:"[Invoice Automation]"' in BASE_QUERY


def test_existing_database_gets_new_column(tmp_path):
    """Upgrading a DB created before notified_at existed must not crash."""
    import sqlite3

    from src.database.repository import Database

    path = tmp_path / "old.db"
    db = Database(f"sqlite:///{path}")
    db.create_all()
    con = sqlite3.connect(path)
    con.execute("ALTER TABLE emails DROP COLUMN notified_at")
    con.commit()
    con.close()
    Database(f"sqlite:///{path}").create_all()
    cols = [r[1] for r in sqlite3.connect(path).execute("PRAGMA table_info(emails)")]
    assert "notified_at" in cols


def test_supplier_name_with_newline_still_notifies():
    class Weird(FakeBackend):
        def complete(self, system, user):
            return ('{"is_invoice": true, "confidence": 0.97, "supplier_name": "Evil\\r\\nBcc: x@y.z",'
                    ' "total": 10, "currency": "ILS", "reason": "ok"}')

    h = Harness(make_settings(), backend=Weird(), notify=True)
    _add_invoice(h)
    h.processor.process_message("m1")
    assert len(h.gmail.sent) == 1
    msg = _parse(h.gmail.sent[0])
    assert msg["Bcc"] is None and "\n" not in msg["Subject"]


def test_column_migration_tolerates_concurrent_instance(tmp_path, monkeypatch):
    """If another instance adds the column between inspect and ALTER, startup continues."""
    import sqlite3

    from src.database.repository import Database

    path = tmp_path / "race.db"
    Database(f"sqlite:///{path}").create_all()
    con = sqlite3.connect(path)
    con.execute("ALTER TABLE emails DROP COLUMN notified_at")
    con.commit()
    db = Database(f"sqlite:///{path}")
    real_begin = db.engine.begin

    def racing_begin():
        con.execute("ALTER TABLE emails ADD COLUMN notified_at DATETIME")  # the "other" instance
        con.commit()
        return real_begin()

    monkeypatch.setattr(db.engine, "begin", racing_begin)
    db._add_missing_columns()  # must not raise
    con.close()
