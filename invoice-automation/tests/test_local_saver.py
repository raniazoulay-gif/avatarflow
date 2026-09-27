"""Tests for the local Invoice Saver (runs on the user's Windows PC)."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "invoice_saver", Path(__file__).resolve().parents[1] / "local_saver" / "invoice_saver.py")
saver_mod = importlib.util.module_from_spec(SPEC)
sys.modules["invoice_saver"] = saver_mod  # dataclasses need the module registered
SPEC.loader.exec_module(saver_mod)


class FakeReader:
    def __init__(self, account="me@example.com"):
        self.account = account
        self.labels = {"Invoice/Detected": "L1", "Invoice/Review": "L2"}
        self.messages: dict[str, dict] = {}
        self.attachments: dict[tuple[str, str], bytes] = {}
        self.label_of: dict[str, list[str]] = {}
        self.added: list[tuple[str, str]] = []
        self.fail_get: set[str] = set()

    def add(self, mid, files, label="L1", sender="Acme Ltd <billing@acme.com>",
            internal_ms=1790000000000):
        parts = []
        for i, (name, data) in enumerate(files, 1):
            aid = f"a{mid}{i}"
            self.attachments[(mid, aid)] = data
            parts.append({"filename": name, "body": {"attachmentId": aid}})
        self.messages[mid] = {"id": mid, "internalDate": str(internal_ms), "labelIds": [label],
                              "payload": {"headers": [{"name": "From", "value": sender}],
                                          "parts": parts}}
        self.label_of.setdefault(label, []).append(mid)

    # protocol
    def profile_email(self):
        return self.account

    def label_ids(self):
        return dict(self.labels)

    def create_label(self, name):
        self.labels[name] = f"L{len(self.labels) + 1}"
        return self.labels[name]

    def list_ids(self, label_id, max_results):
        return list(self.label_of.get(label_id, []))[:max_results]

    def get_message(self, mid):
        if mid in self.fail_get:
            raise ConnectionError("boom")
        return self.messages[mid]

    def get_attachment(self, mid, aid):
        return self.attachments[(mid, aid)]

    def add_label(self, mid, label_id):
        self.added.append((mid, label_id))
        self.messages[mid]["labelIds"].append(label_id)

    # the saver must never have these
    send = forward = delete = trash = None


@pytest.fixture
def cfg(tmp_path, monkeypatch):
    monkeypatch.setattr(saver_mod, "STATE_FILE", tmp_path / "state.json")
    return saver_mod.Config(client_id="x", client_secret="y", refresh_token="1//z",
                            gmail_account="me@example.com", save_dir=tmp_path / "חשבוניות")


def test_saves_invoice_files_into_month_folder_with_clear_names(cfg):
    g = FakeReader()
    g.add("m1", [("Invoice 123.pdf", b"%PDF-1"), ("logo.png", b"img"), ("terms.docx", b"PK")])
    stats = saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()
    assert stats["files"] == 2 and stats["messages"] == 1
    folder = cfg.save_dir / "2026-09"
    names = sorted(p.name for p in folder.iterdir())
    assert names == ["2026-09-21_Acme Ltd_Invoice 123.pdf", "2026-09-21_Acme Ltd_terms.docx"]
    assert (folder / names[0]).read_bytes() == b"%PDF-1"
    assert ("m1", g.labels["Invoice/Saved"]) in g.added  # marked in Gmail


def test_never_saves_twice(cfg):
    g = FakeReader()
    g.add("m1", [("inv.pdf", b"%PDF-1")])
    s = saver_mod.InvoiceSaver(cfg, g, state=set())
    s.run_once()
    second = saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()  # fresh state: label protects
    assert second["files"] == 0
    assert len(list((cfg.save_dir / "2026-09").iterdir())) == 1


def test_same_file_name_from_two_emails_gets_unique_names(cfg):
    g = FakeReader()
    g.add("m1", [("invoice.pdf", b"one")])
    g.add("m2", [("invoice.pdf", b"two")])
    saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()
    names = sorted(p.name for p in (cfg.save_dir / "2026-09").iterdir())
    assert names == ["2026-09-21_Acme Ltd_invoice (2).pdf", "2026-09-21_Acme Ltd_invoice.pdf"]


def test_review_only_when_enabled(cfg):
    g = FakeReader()
    g.add("r1", [("maybe.pdf", b"x")], label="L2")
    assert saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()["files"] == 0
    cfg.save_review = True
    assert saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()["files"] == 1
    assert (cfg.save_dir / "2026-09" / "לבדיקה").is_dir()


def test_wrong_account_refuses_to_run(cfg):
    g = FakeReader(account="other@example.com")
    g.add("m1", [("inv.pdf", b"x")])
    with pytest.raises(SystemExit):
        saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()
    assert not cfg.save_dir.exists()


def test_one_bad_email_does_not_stop_others(cfg):
    g = FakeReader()
    g.add("m1", [("a.pdf", b"a")])
    g.add("m2", [("b.pdf", b"b")])
    g.fail_get.add("m1")
    stats = saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()
    assert stats == {"messages": 1, "files": 1, "skipped": 0, "errors": 1}


def test_windows_unsafe_names_are_cleaned():
    assert saver_mod.safe_name('a<b>:c"d/e\\f|g?h*i') == "a b c d e f g h i"
    assert saver_mod.safe_name("CON") == "_CON"
    assert saver_mod.safe_name("חשבונית מס 55") == "חשבונית מס 55"
    assert saver_mod.safe_name("   ") == "unknown"


def test_config_file_parsing(tmp_path):
    p = tmp_path / "c.env"
    p.write_text('\ufeffGMAIL_CLIENT_ID="1-a.apps.googleusercontent.com"\nGMAIL_CLIENT_SECRET=s\n'
                 "GMAIL_REFRESH_TOKEN=1//t\nGMAIL_ACCOUNT=Me@Example.com\n"
                 "SAVE_DIR=C:\\Users\\Ran\\חשבוניות\n# comment\n", encoding="utf-8")
    c = saver_mod.load_config(p)
    assert c.client_id == "1-a.apps.googleusercontent.com"
    assert c.gmail_account == "me@example.com"
    assert str(c.save_dir).endswith("חשבוניות")
    assert c.save_review is False


def test_state_file_backup(cfg):
    g = FakeReader()
    g.add("m1", [("inv.pdf", b"x")])
    saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()
    assert json.loads(saver_mod.STATE_FILE.read_text()) == ["m1"]


def test_saver_code_has_no_send_or_delete_calls():
    src = (Path(saver_mod.__file__)).read_text(encoding="utf-8")
    for forbidden in (".send(", ".delete(", ".trash(", "removeLabelIds", ".batchDelete("):
        assert forbidden not in src


def test_long_save_dir_keeps_paths_under_windows_limit(tmp_path, monkeypatch):
    monkeypatch.setattr(saver_mod, "STATE_FILE", tmp_path / "state.json")
    long_dir = tmp_path / "OneDrive - Matrix IT Ltd" / "Desktop" / "Drive" / "RAN" / \
        "Claude" / "SKILL" / "GOOD" / "Gmail Invoice Automation" / "חשבוניות"
    cfg = saver_mod.Config(client_id="x", client_secret="y", refresh_token="1//z",
                           gmail_account="me@example.com", save_dir=long_dir)
    g = FakeReader()
    g.add("m1", [("a" * 150 + ".docx", b"x")],
          sender='"Very Long Supplier Name Limited Partnership Ltd" <b@c.com>')
    assert saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()["files"] == 1
    saved = next((long_dir / "2026-09").iterdir())
    folder_len = len(str(long_dir / "2026-09"))
    assert folder_len + 1 + len(saved.name) <= saver_mod.MAX_PATH


def test_interrupted_run_does_not_create_duplicate_copies(cfg):
    g = FakeReader()
    g.add("m1", [("inv.pdf", b"same-bytes")])
    real_add = g.add_label
    g.add_label = lambda mid, lid: (_ for _ in ()).throw(ConnectionError("label failed"))
    saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()  # file written, label failed
    g.add_label = real_add
    saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()  # fresh state, no label yet
    assert len(list((cfg.save_dir / "2026-09").iterdir())) == 1


def test_main_logs_config_errors_instead_of_dying_silently(tmp_path, caplog):
    bad = tmp_path / "c.env"
    bad.write_text("GMAIL_ACCOUNT=me@example.com\n", encoding="utf-8")
    with caplog.at_level("ERROR"):
        rc = saver_mod.main(["--once", "--config", str(bad)])
    assert rc == 1
    assert "Missing in c.env" in caplog.text


def test_hopelessly_long_save_dir_is_reported_not_silent(tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(saver_mod, "STATE_FILE", tmp_path / "state.json")
    cfg = saver_mod.Config(client_id="x", client_secret="y", refresh_token="1//z",
                           gmail_account="me@example.com", save_dir=tmp_path / ("y" * 230))
    g = FakeReader()
    g.add("m1", [("inv.pdf", b"x")])
    with caplog.at_level("ERROR"):
        stats = saver_mod.InvoiceSaver(cfg, g, state=set()).run_once()
    assert stats["errors"] == 1 and "too long" in caplog.text
