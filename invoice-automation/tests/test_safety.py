"""DRY RUN / Safety Guard / Production tests (requirements 4, 13-15, 29, 39, 40)."""

from __future__ import annotations

import pytest

from src.database.models import EmailStatus
from src.gmail.forwarder import ForwardBlocked, SafetyGuard

from .conftest import INVOICE_LINES, PRODUCTION, ForwardAPICalled, Harness, make_settings, make_text_pdf


def _invoice_email(h: Harness, mid: str = "m1") -> None:
    h.gmail.add_message(mid, subject="Invoice September 2026",
                        attachments=[("invoice.pdf", "application/pdf",
                                      make_text_pdf(INVOICE_LINES))])


# ---- 39. CRITICAL DRY RUN TEST ------------------------------------------------
def test_dry_run_forward_function_cannot_send_even_when_called_directly():
    h = Harness(make_settings(dry_run=True))
    h.gmail.forbid_send = True  # any call to the send API raises -> test fails
    _invoice_email(h)
    with h.db.repo() as repo:
        e = repo.upsert_email(message_id="m1", subject="Invoice")
        # Call the forwarder DIRECTLY, bypassing processor/decision engine.
        result = h.forwarder.forward(e, repo)
    assert result.forwarded is False
    assert "DRY_RUN" in result.reason
    assert h.gmail.sent == []
    with h.db.repo() as repo:
        assert repo.get_forward("m1") is None


@pytest.mark.parametrize("flags", [
    dict(dry_run=True, auto_forward_enabled=True, production_confirmation=True),
    dict(dry_run=True, auto_forward_enabled=False, production_confirmation=False),
    dict(dry_run=False, auto_forward_enabled=False, production_confirmation=True),
    dict(dry_run=False, auto_forward_enabled=True, production_confirmation=False),
    dict(dry_run=False, auto_forward_enabled=False, production_confirmation=False),
])
def test_forward_blocked_unless_all_three_switches(flags):
    h = Harness(make_settings(**flags))
    h.gmail.forbid_send = True
    _invoice_email(h)
    with h.db.repo() as repo:
        e = repo.upsert_email(message_id="m1")
        assert h.forwarder.forward(e, repo).forwarded is False
    assert h.gmail.sent == []


def test_dry_run_full_pipeline_never_sends_and_logs_would_forward():
    h = Harness(make_settings(dry_run=True))
    h.gmail.forbid_send = True
    _invoice_email(h)
    status = h.processor.process_message("m1")
    assert status == EmailStatus.DRY_RUN_WOULD_FORWARD
    e = h.email("m1")
    assert e.would_forward is True
    assert e.forward is None
    assert e.dry_run is True
    assert "Invoice/DRY-RUN" in h.gmail.applied["m1"]
    assert "Invoice/Forwarded" not in h.gmail.applied["m1"]


# ---- 40. PRODUCTION SAFETY TEST -------------------------------------------------
def test_production_safety_partial_switches_no_forward():
    h = Harness(make_settings(dry_run=False, auto_forward_enabled=False))
    h.gmail.forbid_send = True
    _invoice_email(h)
    status = h.processor.process_message("m1")
    assert status == EmailStatus.DRY_RUN_WOULD_FORWARD  # still simulated
    assert h.gmail.sent == []


def test_production_all_switches_forward_allowed():
    h = Harness(make_settings(**PRODUCTION))
    _invoice_email(h)
    status = h.processor.process_message("m1")
    assert status == EmailStatus.FORWARDED
    assert len(h.gmail.sent) == 1
    e = h.email("m1")
    assert e.forward.forwarded is True
    assert e.forward.target_email == "books@example.com"
    assert e.forward.target_message_id == "sent-1"
    assert e.forward.forward_timestamp is not None
    assert "Invoice/Forwarded" in h.gmail.applied["m1"]
    sent = h.gmail.sent[0].decode(errors="replace")
    assert "To: books@example.com" in sent
    assert "invoice.pdf" in sent


def test_production_never_forwards_twice():
    h = Harness(make_settings(**PRODUCTION))
    _invoice_email(h)
    h.processor.process_message("m1")
    with h.db.repo() as repo:
        e = repo.get_email("m1")
        again = h.forwarder.forward(e, repo)
    assert again.forwarded is False
    assert len(h.gmail.sent) == 1


def test_production_medium_confidence_not_forwarded():
    from .conftest import FakeBackend

    class Unsure(FakeBackend):
        def complete(self, system, user):
            return ('{"is_invoice": true, "confidence": 0.75, "invoice_type": "invoice", '
                    '"reason": "unclear"}')

    h = Harness(make_settings(**PRODUCTION), backend=Unsure())
    _invoice_email(h)
    assert h.processor.process_message("m1") == EmailStatus.REVIEW
    assert h.gmail.sent == []


def test_backfill_emails_not_forwarded_by_default():
    h = Harness(make_settings(**PRODUCTION))
    h.gmail.forbid_send = True
    _invoice_email(h)
    status = h.processor.process_message("m1", is_backfill=True)
    assert status == EmailStatus.FORWARD_BLOCKED
    assert h.gmail.sent == []


# ---- Safety guard unit tests ------------------------------------------------------
def test_safety_guard_default_settings_block():
    guard = SafetyGuard(make_settings())
    with pytest.raises(ForwardBlocked):
        guard.check()


def test_safety_guard_requires_target():
    guard = SafetyGuard(make_settings(**PRODUCTION, target_gmail_account=""))
    with pytest.raises(ForwardBlocked, match="TARGET"):
        guard.check()


def test_safety_guard_target_same_as_source_blocked():
    guard = SafetyGuard(make_settings(**PRODUCTION, target_gmail_account="me@example.com"))
    assert guard.allowed() is False


def test_safety_guard_allows_only_full_production():
    assert SafetyGuard(make_settings(**PRODUCTION)).allowed() is True


def test_default_settings_are_dry_run(monkeypatch):
    for k in ("DRY_RUN", "AUTO_FORWARD_ENABLED", "PRODUCTION_CONFIRMATION"):
        monkeypatch.delenv(k, raising=False)
    from src.config.settings import Settings

    s = Settings(_env_file=None)
    assert s.dry_run is True
    assert s.auto_forward_enabled is False
    assert s.production_confirmation is False
    assert s.mode == "DRY_RUN"


def test_env_example_defaults_are_safe():
    from src.config.settings import Settings

    s = Settings(_env_file=".env.example")
    assert s.mode == "DRY_RUN"
    assert s.dry_run is True and s.auto_forward_enabled is False


def test_forward_api_error_is_recorded_and_not_retried_blindly():
    h = Harness(make_settings(**PRODUCTION))
    h.gmail.fail_send = True
    _invoice_email(h)
    status = h.processor.process_message("m1")
    assert status == EmailStatus.FORWARD_BLOCKED
    e = h.email("m1")
    assert e.forward.state == "FAILED"
    # A failed/in-doubt forward is never retried automatically.
    h.gmail.fail_send = False
    with h.db.repo() as repo:
        assert h.forwarder.forward(repo.get_email("m1"), repo).forwarded is False
    assert h.gmail.sent == []


def test_forbid_send_helper_really_raises():
    h = Harness(make_settings())
    h.gmail.forbid_send = True
    with pytest.raises(ForwardAPICalled):
        h.gmail.send_raw(b"x")
