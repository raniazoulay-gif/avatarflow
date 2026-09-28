"""Multi-tenant web app: security, tenant isolation, roles and forwarding safety."""

from __future__ import annotations

import time
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from src.app_context import AppContext
from src.database.models import Classification, Email, EmailStatus
from src.gmail.forwarder import SafetyGuard
from src.saas import api as saas_api
from src.saas.bootstrap import ensure_platform_admin
from src.saas.engine import org_settings
from src.saas.google_oauth import TokenResult
from src.saas.models import Invite, Mailbox, Organization, User
from src.saas.security import Signer, Vault, hash_password, new_link_token, verify_password

from .conftest import INVOICE_LINES, PRODUCTION, FakeGmail, Harness, make_settings, make_text_pdf

H = {"X-Requested-With": "fetch"}


def web(a) -> TestClient:
    # HTTPS, like production (the session cookie is Secure)
    return TestClient(a, base_url="https://testserver")


# ---------------------------------------------------------------- security
def test_password_hash_roundtrip():
    h = hash_password("abc12345")
    assert verify_password("abc12345", h)
    assert not verify_password("abc12346", h)
    assert not verify_password("x", "garbage")


def test_signer_rejects_tamper_and_expiry():
    s = Signer("k" * 40, "session")
    tok = s.sign({"uid": 1}, 60)
    assert s.verify(tok)["uid"] == 1
    raw, mac = tok.rsplit(".", 1)
    assert s.verify(raw + "." + mac[:-2] + "AA") is None
    assert Signer("other" * 10, "session").verify(tok) is None
    assert Signer("k" * 40, "oauth-state").verify(tok) is None  # purpose-bound
    old = s.sign({"uid": 1}, -1)
    assert s.verify(old) is None


def test_vault_roundtrip_and_wrong_key():
    v = Vault("a" * 40)
    enc = v.encrypt("1//refresh")
    assert "1//refresh" not in enc
    assert v.decrypt(enc) == "1//refresh"
    assert Vault("b" * 40).decrypt(enc) is None


# ---------------------------------------------------------------- forwarding safety per org
def _org(**kw):
    o = Organization(name="Acme", accountant_email="cpa@acme.co.il", forward_threshold=0.9,
                     production_enabled=False, notify_detections=False)
    for k, v in kw.items():
        setattr(o, k, v)
    return o


def test_org_not_in_production_is_always_dry_run_even_if_env_is_production():
    s = make_settings(**PRODUCTION)
    ms = org_settings(s, _org(production_enabled=False), "worker@acme.co.il")
    assert ms.dry_run is True and not ms.forward_switches_on
    assert not SafetyGuard(ms).allowed()


def test_org_production_still_needs_global_switches():
    ms = org_settings(make_settings(), _org(production_enabled=True), "worker@acme.co.il")
    assert not SafetyGuard(ms).allowed()


def test_org_production_with_global_switches_forwards_to_org_accountant():
    ms = org_settings(make_settings(**PRODUCTION), _org(production_enabled=True),
                      "worker@acme.co.il")
    assert SafetyGuard(ms).allowed()
    assert ms.target_gmail_account == "cpa@acme.co.il"
    assert ms.source_gmail_account == "worker@acme.co.il"
    assert not SafetyGuard(ms).allowed(is_backfill=True)


def test_org_without_accountant_cannot_forward():
    ms = org_settings(make_settings(**PRODUCTION), _org(production_enabled=True,
                                                        accountant_email=None), "w@acme.co.il")
    assert not SafetyGuard(ms).allowed()


# ---------------------------------------------------------------- processor tenant + drive
def test_processor_tags_tenant_and_saves_invoice_to_drive():
    h = Harness(make_settings())
    saved = []

    def saver(repo, e, parsed, outcomes, review):
        for o in outcomes:
            saved.append((o.filename, len(o.data or b""), review))
            repo.get_attachment(e, o.key).drive_file_id = "drv1"

    h.processor.tenant = {"org_id": 7, "mailbox_id": 3}
    h.processor.saver = saver
    h.gmail.add_message("m1", attachments=[("inv.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    e = h.email("m1")
    assert (e.org_id, e.mailbox_id) == (7, 3)
    assert saved and saved[0][0] == "inv.pdf" and saved[0][1] > 100 and saved[0][2] is False
    assert e.attachments[0].drive_file_id == "drv1"
    assert not h.gmail.sent  # still DRY RUN


def test_drive_failure_never_fails_the_email():
    h = Harness(make_settings())

    def saver(*a, **k):
        raise RuntimeError("drive down")

    h.processor.saver = saver
    h.gmail.add_message("m1", attachments=[("inv.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD


# ---------------------------------------------------------------- web app
@pytest.fixture
def app():
    s = make_settings(gmail_client_id="cid.apps.googleusercontent.com", gmail_client_secret="sec",
                      public_base_url="https://app.test")
    ctx = AppContext(s, connect_gmail=False)
    from src.api.server import create_app

    return ctx, create_app(ctx)


def _admin_client(ctx, app) -> TestClient:
    assert ensure_platform_admin(ctx.settings, ctx.db, None) == "setup link logged"
    tok, th = new_link_token()
    with ctx.db.repo() as repo:
        inv = repo.s.scalar(select(Invite).where(Invite.kind == "admin"))
        inv.token_hash = th
    c = web(app)
    r = c.post("/api/setup", json={"token": tok, "name": "Ran", "password": "secret123"},
               headers=H)
    assert r.status_code == 200, r.text
    return c


def _signup(ctx, app, admin: TestClient, org_name="Acme", email="boss@acme.co.il"):
    link = admin.post("/api/admin/signup-link", json={"note": org_name}, headers=H).json()["link"]
    tok = link.split("t=")[1]
    c = web(app)
    r = c.post("/api/signup", json={"token": tok, "org_name": org_name, "name": "Boss",
                                    "email": email, "password": "boss1234",
                                    "accountant_email": "cpa@acme.co.il"}, headers=H)
    assert r.status_code == 200, r.text
    # link is single-use
    assert c.post("/api/signup", json={"token": tok, "org_name": "X", "name": "Y",
                                       "email": "y@y.co", "password": "abc12345"},
                  headers=H).status_code == 404
    return c


def _join(app, mgr: TestClient, email="dana@acme.co.il", role="employee") -> TestClient:
    r = mgr.post("/api/team/invite", json={"name": "Dana", "email": email, "role": role},
                 headers=H)
    assert r.status_code == 200, r.text
    tok = r.json()["link"].split("t=")[1]
    c = web(app)
    assert c.post("/api/join", json={"token": tok, "name": "Dana", "password": "dana1234"},
                  headers=H).status_code == 200
    return c


def test_setup_link_is_emailed_to_admin_from_own_gmail():
    s = make_settings(public_base_url="https://app.test")
    ctx = AppContext(s, connect_gmail=False)
    g = FakeGmail()
    assert ensure_platform_admin(s, ctx.db, g) == "setup link sent"
    import email
    import email.policy

    assert len(g.sent) == 1
    msg = email.message_from_bytes(g.sent[0], policy=email.policy.default)
    assert "https://app.test/setup?t=" in msg.get_body().get_content()
    assert msg["To"] == s.source_gmail_account
    assert ensure_platform_admin(s, ctx.db, g) == "setup link already sent"


def test_csrf_header_required(app):
    ctx, a = app
    c = web(a)
    assert c.post("/api/auth/login", json={"email": "x@y.co", "password": "p"}).status_code == 403


def test_login_throttle(app):
    ctx, a = app
    c = web(a)
    for _ in range(8):
        assert c.post("/api/auth/login", json={"email": "no@x.co", "password": "bad"},
                      headers=H).status_code == 401
    assert c.post("/api/auth/login", json={"email": "no@x.co", "password": "bad"},
                  headers=H).status_code == 429


def test_full_flow_roles_and_isolation(app):
    ctx, a = app
    admin = _admin_client(ctx, a)
    assert admin.get("/api/me").json()["user"]["is_platform_admin"]
    mgr = _signup(ctx, a, admin)
    emp = _join(a, mgr)
    other = _signup(ctx, a, admin, org_name="Other", email="boss@other.co.il")

    me = emp.get("/api/me").json()
    assert me["user"]["role"] == "employee" and me["org"]["name"] == "Acme"
    # role limits
    assert emp.get("/api/team").status_code == 403
    assert emp.get("/api/reports").status_code == 403
    assert emp.get("/api/settings").status_code == 403
    assert mgr.get("/api/admin/orgs").status_code == 403
    assert admin.get("/api/admin/orgs").json()["orgs"][0]["name"] == "Acme"

    # data: one mailbox per user, emails attached to mailboxes
    with ctx.db.repo() as repo:
        users = {u.email: u for u in repo.s.scalars(select(User))}
        acme = users["boss@acme.co.il"].org_id
        oth = users["boss@other.co.il"].org_id
        mb_boss = Mailbox(org_id=acme, user_id=users["boss@acme.co.il"].id,
                          email="boss@acme.co.il", status="active")
        mb_dana = Mailbox(org_id=acme, user_id=users["dana@acme.co.il"].id,
                          email="dana@acme.co.il", status="active")
        mb_oth = Mailbox(org_id=oth, user_id=users["boss@other.co.il"].id,
                         email="boss@other.co.il", status="active")
        repo.s.add_all([mb_boss, mb_dana, mb_oth])
        repo.s.flush()
        now = datetime.now(UTC)
        rows = []
        for mid, org, mb, st in [("a1", acme, mb_boss.id, EmailStatus.REVIEW),
                                 ("a2", acme, mb_dana.id, EmailStatus.DRY_RUN_WOULD_FORWARD),
                                 ("a3", acme, mb_dana.id, EmailStatus.REVIEW),
                                 ("o1", oth, mb_oth.id, EmailStatus.REVIEW)]:
            e = Email(message_id=mid, org_id=org, mailbox_id=mb, status=st, received_at=now,
                      processed_at=now, sender_email="s@sup.co.il", subject=f"<b>{mid}</b>",
                      final_score=0.8)
            repo.s.add(e)
            repo.s.flush()
            repo.s.add(Classification(email_id=e.id, supplier="Supplier " + mid, total=100.0,
                                      currency="ILS"))
            rows.append(e)
        ids = {e.message_id: e.id for e in rows}

    mgr_items = mgr.get("/api/emails").json()["items"]
    assert {x["supplier"] for x in mgr_items} == {"Supplier a1", "Supplier a2", "Supplier a3"}
    emp_items = emp.get("/api/emails").json()["items"]
    assert {x["supplier"] for x in emp_items} == {"Supplier a2", "Supplier a3"}
    # cross-tenant and cross-employee access is 404
    assert mgr.get(f"/api/emails/{ids['o1']}").status_code == 404
    assert emp.get(f"/api/emails/{ids['a1']}").status_code == 404
    assert other.get(f"/api/emails/{ids['a2']}").status_code == 404

    dash = mgr.get("/api/dashboard").json()
    assert dash["review_pending"] == 2 and len(dash["team"]) == 2
    assert emp.get("/api/dashboard").json()["review_pending"] == 1

    # review
    assert emp.post(f"/api/emails/{ids['a3']}/review", json={"decision": "invoice"},
                    headers=H).status_code == 200
    assert emp.post(f"/api/emails/{ids['a3']}/review", json={"decision": "invoice"},
                    headers=H).status_code == 409
    assert emp.post(f"/api/emails/{ids['a1']}/review", json={"decision": "invoice"},
                    headers=H).status_code == 404
    with ctx.db.repo() as repo:
        assert repo.get_email("a3").status == EmailStatus.CONFIRMED_INVOICE

    # excel export (manager only) contains only this org
    x = mgr.get("/api/reports/excel")
    assert x.status_code == 200 and x.content[:2] == b"PK"

    # deactivating an employee kills their session
    uid = users["dana@acme.co.il"].id
    assert mgr.post(f"/api/team/{uid}/active", json={"active": False}, headers=H).status_code == 200
    assert emp.get("/api/me").status_code == 401

    # platform admin pauses an org -> its users are locked out
    assert admin.post(f"/api/admin/orgs/{oth}", json={"active": False}, headers=H).status_code == 200
    assert other.get("/api/me").status_code == 403


def test_production_toggle_requires_confirmation(app):
    ctx, a = app
    admin = _admin_client(ctx, a)
    _signup(ctx, a, admin)
    oid = admin.get("/api/admin/orgs").json()["orgs"][0]["id"]
    assert admin.post(f"/api/admin/orgs/{oid}", json={"production_enabled": True},
                      headers=H).status_code == 400
    assert admin.post(f"/api/admin/orgs/{oid}", json={"production_enabled": True,
                                                      "confirm": "PRODUCTION"},
                      headers=H).status_code == 200


def test_oauth_connect_flow(app, monkeypatch):
    ctx, a = app
    admin = _admin_client(ctx, a)
    mgr = _signup(ctx, a, admin)
    r = mgr.get("/oauth/google/start", follow_redirects=False)
    assert r.status_code == 303 and "accounts.google.com" in r.headers["location"]
    state = r.headers["location"].split("state=")[1].split("&")[0]
    from urllib.parse import unquote

    state = unquote(state)
    monkeypatch.setattr(saas_api, "exchange_code",
                        lambda client, code, uri: TokenResult("boss@acme.co.il", "1//tok",
                                                             "gmail.modify drive.file"))
    started = []
    monkeypatch.setattr(ctx.saas, "start_initial_scan", lambda mid, days=7: started.append(mid))
    cb = web(a).get(f"/oauth/google/callback?state={state}&code=abc", follow_redirects=False)
    assert cb.status_code == 303 and "connected=1" in cb.headers["location"]
    with ctx.db.repo() as repo:
        mb = repo.s.scalar(select(Mailbox))
        assert mb.email == "boss@acme.co.il" and mb.status == "active"
        assert "1//tok" not in mb.refresh_token_enc
        assert ctx.vault.decrypt(mb.refresh_token_enc) == "1//tok"
    assert started
    # tampered state is refused
    bad = web(a).get("/oauth/google/callback?state=xx.yy&code=abc", follow_redirects=False)
    assert "connect_error=expired" in bad.headers["location"]
    # the same Gmail cannot be attached to another customer
    other = _signup(ctx, a, admin, org_name="Other", email="boss@other.co.il")
    r2 = other.get("/oauth/google/start", follow_redirects=False)
    st2 = unquote(r2.headers["location"].split("state=")[1].split("&")[0])
    cb2 = web(a).get(f"/oauth/google/callback?state={st2}&code=abc", follow_redirects=False)
    assert "mailbox_in_other_org" in cb2.headers["location"]


def test_legacy_watcher_stands_down_when_account_connected(app):
    ctx, a = app
    with ctx.db.repo() as repo:
        o = Organization(name="Mine")
        repo.s.add(o)
        repo.s.flush()
        repo.s.add(Mailbox(org_id=o.id, email=ctx.settings.source_gmail_account, status="active"))
    assert ctx.legacy_account_moved()


def test_app_page_served(app):
    ctx, a = app
    c = web(a)
    for p in ("/app", "/login", "/signup", "/join", "/setup"):
        r = c.get(p)
        assert r.status_code == 200 and "TotanRomi" in r.text
        assert r.headers["x-frame-options"] == "DENY"


def test_invite_token_expiry(app):
    ctx, a = app
    tok, th = new_link_token()
    with ctx.db.repo() as repo:
        repo.s.add(Invite(token_hash=th, kind="org", expires_at=datetime.fromtimestamp(
            time.time() - 10, UTC)))
    assert web(a).get(f"/api/invite/{tok}").status_code == 404
