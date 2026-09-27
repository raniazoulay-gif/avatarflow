"""Regression tests for issues found in the safety review."""

from __future__ import annotations

from datetime import UTC, date, datetime

import pytest

from src.classification.decision_engine import decide
from src.database.models import EmailStatus
from src.gmail.client import GmailClient
from src.gmail.watcher import Watcher
from src.reports.data import build_report, report_window
from src.reports.email_report import generate_daily_report

from .conftest import INVOICE_LINES, PRODUCTION, FakeBackend, Harness, make_settings, make_text_pdf


class FailFirstBackend(FakeBackend):
    """AI fails for the first email only."""

    def __init__(self):
        super().__init__()
        self.fail_calls = 3  # = max_attempts for the first email

    def complete(self, system, user):
        if self.fail_calls > 0:
            self.fail_calls -= 1
            self.calls += 1
            raise ConnectionError("AI down")
        return super().complete(system, user)


def test_same_invoice_never_forwarded_twice_even_after_ai_failure():
    h = Harness(make_settings(**PRODUCTION), backend=FailFirstBackend())
    pdf = make_text_pdf(INVOICE_LINES)
    for mid in ("A", "B", "C"):
        h.gmail.add_message(mid, attachments=[("i.pdf", "application/pdf", pdf)])
    res = h.processor.process_many(["A", "B", "C"])
    assert res["A"] == EmailStatus.REVIEW  # AI failed -> rules only
    assert res["B"] == EmailStatus.FORWARDED
    assert res["C"] == EmailStatus.REVIEW  # duplicate of B
    assert len(h.gmail.sent) == 1
    assert "Duplicate invoice content" in h.email("C").classification.reason


def test_dry_run_duplicate_would_forward_only_once():
    h = Harness(make_settings())
    pdf = make_text_pdf(INVOICE_LINES)
    h.gmail.add_message("A", attachments=[("i.pdf", "application/pdf", pdf)])
    h.gmail.add_message("B", attachments=[("i.pdf", "application/pdf", pdf)])
    res = h.processor.process_many(["A", "B"])
    assert res == {"A": EmailStatus.DRY_RUN_WOULD_FORWARD, "B": EmailStatus.REVIEW}


class _Resp:
    status = 503


class _HttpError(Exception):
    resp = _Resp()


class _Req:
    def __init__(self, counter):
        self.counter = counter

    def execute(self, num_retries=0):
        self.counter["n"] += 1
        raise _HttpError("backend error / timeout")


class _Svc:
    def __init__(self, counter):
        self.counter = counter

    def users(self):
        return self

    def messages(self):
        return self

    def send(self, userId, body):
        return _Req(self.counter)

    def get(self, userId, id, format):
        return _Req(self.counter)


def test_send_is_never_retried_but_reads_are():
    counter = {"n": 0}
    client = GmailClient(_Svc(counter), max_attempts=5, base_delay=0)
    with pytest.raises(_HttpError):
        client.send_raw(b"x")
    assert counter["n"] == 1
    counter["n"] = 0
    with pytest.raises(_HttpError):
        client.get_message("m1")
    assert counter["n"] == 5


def test_interrupted_forward_reports_true_state_and_never_resends():
    h = Harness(make_settings(**PRODUCTION))
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.FORWARDED
    # Simulate a crash after the send but before the final status commit.
    with h.db.repo() as repo:
        repo.get_email("m1").status = EmailStatus.ERROR
    assert h.processor.process_message("m1") == EmailStatus.FORWARDED
    assert len(h.gmail.sent) == 1


def test_no_auto_forward_without_ai_even_with_low_threshold():
    s = make_settings(**PRODUCTION, invoice_auto_forward_threshold=0.5, review_threshold=0.3)
    d = decide(0.85, "a@b.com", s, has_ai=False)
    assert d.status == EmailStatus.REVIEW and d.would_forward is False


def test_report_window_uses_local_timezone_and_has_no_gaps():
    s = make_settings(timezone="Asia/Jerusalem", daily_report_time="18:00")
    start, end = report_window(date(2026, 9, 27), s)
    assert start == datetime(2026, 9, 26, 15, 0, tzinfo=UTC)  # 18:00 IDT = 15:00 UTC
    assert end == datetime(2026, 9, 27, 15, 0, tzinfo=UTC)
    assert report_window(date(2026, 9, 28), s)[0] == end


def test_emails_land_in_correct_report_and_times_are_local():
    s = make_settings(timezone="Asia/Jerusalem", daily_report_time="18:00")
    h = Harness(s)
    with h.db.repo() as repo:
        # 01:30 local on 09-27 (22:30 UTC on 09-26) -> report of 09-27
        repo.upsert_email(message_id="early", status=EmailStatus.NOT_INVOICE,
                          processed_at=datetime(2026, 9, 26, 22, 30, tzinfo=UTC))
        # 19:00 local on 09-27 -> after the 18:00 report -> report of 09-28
        repo.upsert_email(message_id="late", status=EmailStatus.NOT_INVOICE,
                          processed_at=datetime(2026, 9, 27, 16, 0, tzinfo=UTC))
    with h.db.repo() as repo:
        r27 = build_report(repo, date(2026, 9, 27), s)
        r28 = build_report(repo, date(2026, 9, 28), s)
    assert [r["Message ID"] for r in r27.rows] == ["early"]
    assert r27.rows[0]["Date"] == "2026-09-27" and r27.rows[0]["Time"] == "01:30:00"
    assert [r["Message ID"] for r in r28.rows] == ["late"]
    with h.db.repo() as repo:
        assert repo.get_email("early").processed_at.tzinfo is not None


def test_report_not_sent_when_source_does_not_match_authenticated_account(tmp_path):
    s = make_settings(reports_dir=str(tmp_path), source_gmail_account="typo@example.com")
    h = Harness(s)
    res = generate_daily_report(s, h.db, h.gmail, date(2026, 9, 27), send=True)
    assert res["sent"] is False
    assert "does not match" in res["send_status"]
    assert h.gmail.sent == []


def test_backfill_pins_monitor_start_before_listing():
    s = make_settings()
    h = Harness(s)
    w = Watcher(s, h.db, h.gmail, h.processor)
    seen = {}
    orig = h.gmail.list_message_ids

    def spy(query, max_results=500):
        with h.db.repo() as repo:
            seen["start"] = repo.get_state("monitor_start_epoch")
        return orig(query, max_results)

    h.gmail.list_message_ids = spy
    w.backfill(7)
    assert seen["start"] is not None


@pytest.mark.parametrize("url,expected", [
    ("postgresql://u:p@host:5432/db", "postgresql+psycopg2://u:p@host:5432/db"),
    ("postgres://u:p@host:5432/db", "postgresql+psycopg2://u:p@host:5432/db"),
    ("postgresql+psycopg2://u:p@h/db", "postgresql+psycopg2://u:p@h/db"),
    ("sqlite:///data/x.db", "sqlite:///data/x.db"),
])
def test_railway_postgres_url_uses_installed_driver(url, expected):
    from src.database.repository import normalize_database_url

    assert normalize_database_url(url) == expected
