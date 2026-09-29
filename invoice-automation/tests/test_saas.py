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
from src.saas.bootstrap import create_admin_link, ensure_platform_admin
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
    assert s.verify(raw + "." + mac[:-2] + ("AB" if mac[-2:] != "AB" else "BA")) is None
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
    # without a Gmail to email it from, the link is never logged - the CLI prints it
    assert ensure_platform_admin(ctx.settings, ctx.db, None) == "run admin-link"
    tok = create_admin_link(ctx.settings, ctx.db).split("t=")[1]
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
    # a person can correct the decision later (until the file was sent)
    assert emp.post(f"/api/emails/{ids['a3']}/review", json={"decision": "not_invoice"},
                    headers=H).status_code == 200
    assert emp.post(f"/api/emails/{ids['a3']}/review", json={"decision": "invoice"},
                    headers=H).status_code == 200
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
    # the consent link handed to another browser is useless (no nonce / other session)
    stolen = web(a).get(f"/oauth/google/callback?state={state}&code=abc", follow_redirects=False)
    assert "connect_error=expired" in stolen.headers["location"]
    cb = mgr.get(f"/oauth/google/callback?state={state}&code=abc", follow_redirects=False)
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
    cb2 = other.get(f"/oauth/google/callback?state={st2}&code=abc", follow_redirects=False)
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


def test_hardening_rules(app, monkeypatch):
    ctx, a = app
    admin = _admin_client(ctx, a)
    mgr = _signup(ctx, a, admin)
    with ctx.db.repo() as repo:
        o = repo.s.scalar(select(Organization).where(Organization.name == "Acme"))
        o.production_enabled = True
        oid = o.id
    # changing the accountant address switches production off until re-approved
    assert mgr.put("/api/settings", json={"accountant_email": "evil@x.com"},
                   headers=H).status_code == 200
    with ctx.db.repo() as repo:
        assert repo.s.get(Organization, oid).production_enabled is False
    # the platform admin (joined as a member) cannot be deactivated by a manager
    with ctx.db.repo() as repo:
        adm = repo.s.scalar(select(User).where(User.is_platform_admin.is_(True)))
        adm.org_id = oid
        aid = adm.id
    assert mgr.post(f"/api/team/{aid}/active", json={"active": False},
                    headers=H).status_code == 403
    # logout kills the token itself, not only the browser copy
    cookie = mgr.cookies.get("tr_session")
    assert mgr.post("/api/auth/logout", headers=H).status_code == 200
    replay = web(a)
    replay.cookies.set("tr_session", cookie)
    assert replay.get("/api/me").status_code == 401
    # Excel formulas from email content are neutralised
    assert saas_api.xl_text("=HYPERLINK(1)") == "'=HYPERLINK(1)"
    assert saas_api.xl_text("Acme") == "Acme" and saas_api.xl_text(5) == 5


def test_invite_link_single_use(app):
    ctx, a = app
    admin = _admin_client(ctx, a)
    link = admin.post("/api/admin/signup-link", json={"note": "x"}, headers=H).json()["link"]
    tok = link.split("t=")[1]
    body = {"token": tok, "org_name": "A", "name": "B", "email": "b@a.co.il",
            "password": "boss1234"}
    assert web(a).post("/api/signup", json=body, headers=H).status_code == 200
    body["email"] = "c@a.co.il"
    assert web(a).post("/api/signup", json=body, headers=H).status_code == 404


def test_client_ip_uses_proxy_hop():
    from starlette.requests import Request as SReq

    req = SReq({"type": "http", "headers": [(b"x-forwarded-for", b"1.1.1.1, 9.9.9.9")],
                "client": ("10.0.0.1", 1)})
    assert saas_api.client_ip(req) == "9.9.9.9"


def test_legacy_fails_closed(app, monkeypatch):
    ctx, _ = app

    def boom():
        raise RuntimeError("db down")
    monkeypatch.setattr(ctx.saas, "connected_emails", boom)
    assert ctx.legacy_account_moved()


def _capture_mail(monkeypatch, a):
    """Catches system emails (codes / login details) instead of sending them."""
    sent: list[tuple[str, str]] = []
    import re as _re

    def fake(to, subject, text):
        m = _re.search(r"\b(\d{6})\b", text)
        sent.append((to, m.group(1) if m else text))
        return True
    monkeypatch.setattr(a.state.saas_web, "system_mail", fake)
    return sent


def test_open_signup_with_email_code(app, monkeypatch):
    ctx, a = app
    sent = _capture_mail(monkeypatch, a)
    c = web(a)
    assert c.post("/api/signup/code", json={"email": "office@biz.co.il"}, headers=H).status_code == 200
    code = sent[-1][1]
    body = {"email": "office@biz.co.il", "org_name": "Biz", "name": "Office",
            "password": "offi1234", "code": "000000" if code != "000000" else "111111"}
    assert c.post("/api/signup", json=body, headers=H).status_code == 400  # wrong code
    body["code"] = code
    assert c.post("/api/signup", json=body, headers=H).status_code == 200
    me = c.get("/api/me").json()
    assert me["org"]["name"] == "Biz" and me["user"]["role"] == "manager"
    assert not me["user"]["is_platform_admin"]
    # code cannot be used twice / email taken
    assert web(a).post("/api/signup", json=body, headers=H).status_code == 409


def test_owner_signup_becomes_platform_admin(app, monkeypatch):
    ctx, a = app
    sent = _capture_mail(monkeypatch, a)
    owner = ctx.settings.source_gmail_account
    c = web(a)
    assert c.post("/api/signup/code", json={"email": owner}, headers=H).status_code == 200
    r = c.post("/api/signup", json={"email": owner, "org_name": "TotanRomi", "name": "Ran",
                                    "password": "ran12345", "code": sent[-1][1]}, headers=H)
    assert r.status_code == 200, r.text
    me = c.get("/api/me").json()
    assert me["user"]["is_platform_admin"] and me["org"]["name"] == "TotanRomi"
    assert c.get("/api/admin/orgs").status_code == 200


def test_code_attempts_are_capped(app, monkeypatch):
    ctx, a = app
    sent = _capture_mail(monkeypatch, a)
    c = web(a)
    c.post("/api/signup/code", json={"email": "x@biz.co.il"}, headers=H)
    code = sent[-1][1]
    wrong = "123456" if code != "123456" else "654321"
    body = {"email": "x@biz.co.il", "org_name": "B", "name": "N", "password": "abcd1234"}
    for _ in range(5):
        assert c.post("/api/signup", json={**body, "code": wrong}, headers=H).status_code == 400
    assert c.post("/api/signup", json={**body, "code": code}, headers=H).status_code == 400


def test_employee_temp_password_must_be_changed(app, monkeypatch):
    ctx, a = app
    _capture_mail(monkeypatch, a)
    admin = _admin_client(ctx, a)
    mgr = _signup(ctx, a, admin)
    r = mgr.post("/api/team/add", json={"name": "Dana", "email": "dana@acme.co.il",
                                        "send_email": True}, headers=H)
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["sent"] and d["temp_password"] in d["message"]
    emp = web(a)
    assert emp.post("/api/auth/login", json={"email": "dana@acme.co.il",
                                             "password": d["temp_password"]},
                    headers=H).status_code == 200
    assert emp.get("/api/me").json()["user"]["must_change_password"]
    assert emp.get("/api/dashboard").status_code == 403
    assert emp.post("/api/auth/change-password", json={"current": "nope1234",
                                                       "password": "dana5678"},
                    headers=H).status_code == 400
    assert emp.post("/api/auth/change-password", json={"current": d["temp_password"],
                                                       "password": "dana5678"},
                    headers=H).status_code == 200
    assert emp.get("/api/dashboard").status_code == 200
    # manager resets it: new temporary password, old sessions end
    uid = emp.get("/api/me").json()["user"]["id"]
    r2 = mgr.post(f"/api/team/{uid}/reset-password", json={}, headers=H).json()
    assert emp.get("/api/me").status_code == 401
    e2 = web(a)
    e2.post("/api/auth/login", json={"email": "dana@acme.co.il", "password": r2["temp_password"]},
            headers=H)
    assert e2.get("/api/me").json()["user"]["must_change_password"]


def test_forgot_password(app, monkeypatch):
    ctx, a = app
    sent = _capture_mail(monkeypatch, a)
    admin = _admin_client(ctx, a)
    _signup(ctx, a, admin)
    c = web(a)
    assert c.post("/api/auth/reset-code", json={"email": "nobody@x.co.il"},
                  headers=H).status_code == 200
    assert not sent  # unknown email: same answer, nothing sent
    c.post("/api/auth/reset-code", json={"email": "boss@acme.co.il"}, headers=H)
    r = c.post("/api/auth/reset", json={"email": "boss@acme.co.il", "code": sent[-1][1],
                                        "password": "newpass99"}, headers=H)
    assert r.status_code == 200
    assert web(a).post("/api/auth/login", json={"email": "boss@acme.co.il",
                                                 "password": "newpass99"},
                       headers=H).status_code == 200


def test_signup_hardening(app, monkeypatch):
    ctx, a = app
    sent = _capture_mail(monkeypatch, a)
    admin = _admin_client(ctx, a)
    mgr = _signup(ctx, a, admin)
    # the owner address cannot be squatted by "adding an employee"
    assert mgr.post("/api/team/add", json={"name": "X", "email": ctx.settings.source_gmail_account},
                    headers=H).status_code == 409
    # any other added-but-unused address is reclaimed by its verified owner
    assert mgr.post("/api/team/add", json={"name": "V", "email": "victim@x.co.il"},
                    headers=H).status_code == 200
    c = web(a)
    assert c.post("/api/signup/code", json={"email": "victim@x.co.il"}, headers=H).status_code == 200
    r = c.post("/api/signup", json={"email": "victim@x.co.il", "org_name": "Own", "name": "V",
                                    "password": "vict1234", "code": sent[-1][1]}, headers=H)
    assert r.status_code == 200, r.text
    assert c.get("/api/me").json()["org"]["name"] == "Own"
    # managers cannot reset another manager's password
    r = mgr.post("/api/team/add", json={"name": "M2", "email": "m2@acme.co.il", "role": "manager"},
                 headers=H)
    with ctx.db.repo() as repo:
        m2 = repo.s.scalar(select(User).where(User.email == "m2@acme.co.il"))
        m2_id = m2.id
        # temporary passwords expire
        from datetime import UTC, datetime, timedelta
        m2.temp_password_expires_at = datetime.now(UTC) - timedelta(minutes=1)
    assert mgr.post(f"/api/team/{m2_id}/reset-password", json={}, headers=H).status_code == 403
    assert web(a).post("/api/auth/login", json={"email": "m2@acme.co.il",
                                                "password": r.json()["temp_password"]},
                       headers=H).status_code == 401


def test_scan_uses_the_dates_the_user_picked(app, monkeypatch):
    ctx, a = app
    admin = _admin_client(ctx, a)
    mgr = _signup(ctx, a, admin)
    assert mgr.post("/api/scan", json={"from": "2026-01-01", "to": "2026-01-31"},
                    headers=H).status_code == 400  # no mailbox yet
    with ctx.db.repo() as repo:
        u = repo.s.scalar(select(User).where(User.email == "boss@acme.co.il"))
        mb = Mailbox(org_id=u.org_id, user_id=u.id, email="boss@acme.co.il", status="active")
        other = Mailbox(org_id=u.org_id, user_id=None, email="x@acme.co.il", status="active")
        repo.s.add_all([mb, other])
        repo.s.flush()
        mid = mb.id
    calls = []
    monkeypatch.setattr(ctx.saas, "scan_range",
                        lambda uid, mids, start, end: calls.append((mids, start, end)) or True)
    assert mgr.post("/api/scan", json={"from": "2026-02-01", "to": "2026-01-01"},
                    headers=H).status_code == 400
    assert mgr.post("/api/scan", json={"from": "2020-01-01", "to": "2026-01-01"},
                    headers=H).status_code == 400  # over two years
    r = mgr.post("/api/scan", json={"from": "2026-03-01", "to": "2026-03-31"}, headers=H)
    assert r.status_code == 200 and r.json()["started"]
    mids, start, end = calls[-1]
    assert mids == [mid]  # only the user's own mailbox
    assert start.date().isoformat() == "2026-03-01" and end.date().isoformat() == "2026-04-01"
    assert mgr.get("/api/scan/status").json() == {"running": False}


def test_watcher_backfill_range_query(tmp_path):
    from datetime import UTC, datetime

    from src.gmail.watcher import Watcher

    class G:
        q = None

        def list_message_ids(self, q, max_results=500):
            G.q = q
            return ["b", "a"]

    class P:
        def process_many(self, ids, is_backfill=False):
            assert is_backfill
            return {ids[0]: "DRY_RUN_WOULD_FORWARD"}

    from src.database.repository import Database
    db = Database(f"sqlite:///{tmp_path}/w.db")
    db.create_all()
    w = Watcher(make_settings(), db, G(), P(), state_prefix="mbx1:")
    seen = []
    res = w.backfill_range(datetime(2026, 3, 1, tzinfo=UTC), datetime(2026, 4, 1, tzinfo=UTC),
                           lambda d, t: seen.append((d, t)))
    assert "after:1772323200" in G.q and "before:1775001600" in G.q
    assert res["found"] == 2 and res["DRY_RUN_WOULD_FORWARD"] == 2 and seen[-1] == (2, 2)


def test_refresh_keeps_granted_scopes():
    from src.saas.google_oauth import OAuthClient, build_credentials

    creds = build_credentials(OAuthClient("id", "sec"), "1//r")
    assert not creds.scopes  # never re-requests a permission the user did not tick


def test_no_attachment_mail_listed_only_on_request(app):
    ctx, a = app
    admin = _admin_client(ctx, a)
    mgr = _signup(ctx, a, admin)
    from datetime import UTC, datetime

    from src.database.models import Email, EmailStatus
    with ctx.db.repo() as repo:
        oid = repo.s.scalar(select(Organization.id).where(Organization.name == "Acme"))
        repo.s.add_all([Email(message_id="n1", org_id=oid, status=EmailStatus.NO_ATTACHMENTS,
                              received_at=datetime.now(UTC)),
                        Email(message_id="i1", org_id=oid, status=EmailStatus.NOT_INVOICE,
                              received_at=datetime.now(UTC))])
    assert mgr.get("/api/emails").json()["total"] == 1
    assert mgr.get("/api/emails?bucket=no_attachments").json()["total"] == 1


def test_same_invoice_file_twice_is_a_duplicate_not_review():
    h = Harness(make_settings())
    h.processor.tenant = {"org_id": 7, "mailbox_id": 3}
    pdf = make_text_pdf(INVOICE_LINES)
    h.gmail.add_message("m1", attachments=[("inv.pdf", "application/pdf", pdf)])
    h.gmail.add_message("m2", attachments=[("copy.pdf", "application/pdf", pdf)])
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert h.processor.process_message("m2") == EmailStatus.DUPLICATE
    e2 = h.email("m2")
    assert e2.duplicate_of == "m1" and not e2.would_forward


def test_old_duplicates_leave_the_review_queue(app):
    ctx, a = app
    from src.database.models import Classification, Email, EmailStatus
    from src.saas.queries import mark_old_duplicates
    with ctx.db.repo() as repo:
        e = Email(message_id="d2", org_id=1, status=EmailStatus.REVIEW)
        repo.s.add(e)
        repo.s.flush()
        repo.s.add(Classification(email_id=e.id, reason="Duplicate invoice content (sha256) of "
                                  "d1 | High confidence"))
    with ctx.db.repo() as repo:
        assert mark_old_duplicates(repo.s) == 1
        e = repo.s.scalar(select(Email).where(Email.message_id == "d2"))
        assert e.status == EmailStatus.DUPLICATE and e.duplicate_of == "d1"


def test_payment_confirmation_is_not_an_invoice():
    from src.classification import rule_engine
    aig = ("AIG תאריך 29/09/2026 לכבוד אזולאי סימה הנדון: אישור תשלום פרמית ביטוח לפוליסה "
           "180038021826 הרינו מתכבדים לאשר בזאת כי החל מיום 04/10/2026 הפקנו עבורכם פוליסת "
           "ביטוח בפרמיה כוללת ע\"ס 58.28 $ יתרת הפרמיה לתשלום 0 $ מחלקת שירות לקוחות")
    r = rule_engine.evaluate(aig)
    assert r.non_invoice_doc and r.score <= 0.2
    wizz = ("INVOICE / SZÁMLA Invoice number 195023100Z Invoice date 2026.09.09 Supplier name "
            "Wizz Air Flight ticket TOTAL 76,60 EUR VAT 0.00 %")
    assert rule_engine.evaluate(wizz).non_invoice_doc is None
    # a receipt for an insurance payment is still a receipt
    assert rule_engine.evaluate("קבלה מס' 5512 אישור תשלום פרמיה סה\"כ 100 ש\"ח").non_invoice_doc \
        is None


def test_payment_confirmation_never_becomes_invoice_even_if_ai_says_so():
    h = Harness(make_settings())
    lines = ["AIG", "אישור תשלום פרמית ביטוח לפוליסה 180038021826", "תאריך 29/09/2026",
             "פרמיה כוללת 58.28 $", "ח.פ. 520040379"]
    h.gmail.add_message("m1", attachments=[("aig.pdf", "application/pdf", make_text_pdf(lines))])
    assert h.processor.process_message("m1") == EmailStatus.NOT_INVOICE


def test_gate_keeps_real_invoices():
    from src.classification import rule_engine
    for t in ["El Al e-ticket Invoices InvoiceNo 123 total 500",
              "חשבוניות מס e-ticket סה\"כ 300", "Payment Confirmation receipts total 20",
              "פוליסה 55 חשבונית מס 1001 סה\"כ 200"]:
        assert rule_engine.evaluate(t).non_invoice_doc is None, t
    assert rule_engine.evaluate("ההעברה התקבלה - אישור תשלום 500 ש\"ח").non_invoice_doc


def test_seen_flag_file_view_and_hidden_ai_reasons(app, monkeypatch):
    ctx, a = app
    admin = _admin_client(ctx, a)
    mgr = _signup(ctx, a, admin)
    emp = _join(a, mgr)
    from src.database.models import Attachment, Classification, Email, EmailStatus
    with ctx.db.repo() as repo:
        emp_u = repo.s.scalar(select(User).where(User.role == "employee"))
        mb = Mailbox(org_id=emp_u.org_id, user_id=emp_u.id, email="dana@acme.co.il",
                     status="active")
        repo.s.add(mb)
        repo.s.flush()
        e = Email(message_id="f1", org_id=emp_u.org_id, mailbox_id=mb.id,
                  status=EmailStatus.DRY_RUN_WOULD_FORWARD)
        repo.s.add(e)
        repo.s.flush()
        repo.s.add(Classification(email_id=e.id, reason="High confidence | secret AI reason",
                                  best_attachment="inv.pdf"))
        repo.s.add(Attachment(email_id=e.id, attachment_key="1:inv.pdf", filename="inv.pdf",
                              mime_type="application/pdf"))
        repo.s.add(Attachment(email_id=e.id, attachment_key="2:x.html", filename="x.html",
                              mime_type="text/html"))
        eid = e.id
    assert emp.get("/api/emails").json()["items"][0]["seen"] is False
    d = emp.get(f"/api/emails/{eid}").json()
    assert d["reasons"] == []  # employees never see the AI reasoning
    assert mgr.get(f"/api/emails/{eid}").json()["reasons"]
    assert emp.get("/api/emails").json()["items"][0]["seen"] is True
    ids = {x["filename"]: x["id"] for x in d["attachments"]}
    monkeypatch.setattr(ctx.saas, "fetch_attachment",
                        lambda mid, msg, key: (b"%PDF-1.4 x" if key.endswith("pdf")
                                               else b"<script>x</script>", "text/html"
                                               if key.endswith("html") else "application/pdf"))
    r = emp.get(f"/api/files/{ids['inv.pdf']}")
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("inline")
    h = emp.get(f"/api/files/{ids['x.html']}")
    assert h.headers["content-type"] == "application/octet-stream"
    assert h.headers["content-disposition"].startswith("attachment")
    assert "sandbox" in h.headers["content-security-policy"]
    other = _signup(ctx, a, admin, org_name="Other", email="boss@other.co.il")
    assert other.get(f"/api/files/{ids['inv.pdf']}").status_code == 404
