"""Web app HTTP API (JSON under /api) + OAuth callback + the single-page app.

Security model
- Session: HttpOnly, SameSite=Lax cookie holding an HMAC-signed {uid, ver}.
- CSRF: every state-changing /api call must carry "X-Requested-With: fetch"
  (a cross-site form cannot set it) on top of SameSite=Lax.
- Tenancy: all data access goes through queries.Scope (org + role).
- Login throttling: 8 failures per email / 30 per IP in 15 minutes.
"""

from __future__ import annotations

import hmac
import html
import io
import logging
import os
import re
import threading
import time
from collections import defaultdict
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from sqlalchemy import func, select, update
from starlette.concurrency import run_in_threadpool

from ..config.settings import EMAIL_RE
from ..database.models import Email, EmailStatus
from . import queries as Q
from .google_oauth import CALLBACK_PATH, OAuthError, authorization_url, exchange_code
from .models import Invite, Mailbox, Organization, Role, User
from .security import (
    Signer,
    hash_password,
    new_code,
    new_link_token,
    password_problem,
    temp_password,
    token_hash,
    verify_password,
)

log = logging.getLogger(__name__)
COOKIE = "tr_session"
NONCE_COOKIE = "tr_oauth"
SESSION_TTL = 14 * 24 * 3600
CODE_TTL = 15 * 60
CODE_MAX_ATTEMPTS = 5
CODE_DAILY_FAILURES = 10  # wrong codes per email per 24h, across all codes
TEMP_PASSWORD_HOURS = 72
WEB_DIR = Path(__file__).resolve().parent.parent / "web"


# ------------------------------------------------------------------ helpers
class Throttle:
    def __init__(self, limit: int, window: int = 900) -> None:
        self.limit, self.window = limit, window
        self.hits: dict[str, list[float]] = defaultdict(list)
        self.lock = threading.Lock()

    def blocked(self, key: str) -> bool:
        now = time.time()
        with self.lock:
            self.hits[key] = [t for t in self.hits[key] if now - t < self.window]
            return len(self.hits[key]) >= self.limit

    def hit(self, key: str) -> None:
        with self.lock:
            self.hits[key].append(time.time())


def client_ip(request: Request) -> str:
    """The address the (trusted) edge proxy saw - the rightmost X-Forwarded-For hop.
    The leftmost values are whatever the client chose to send."""
    xff = [p.strip() for p in request.headers.get("x-forwarded-for", "").split(",") if p.strip()]
    if xff:
        return xff[-1]
    return request.client.host if request.client else ""


def xl_text(v):
    """Excel must show attacker-controlled text as text, never run it as a formula."""
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return v


def clean_email(v) -> str:
    v = (v or "").strip().lower()
    if not EMAIL_RE.match(v) or len(v) > 320:
        raise HTTPException(400, "כתובת מייל לא תקינה")
    return v


def clean_text(v, field: str, max_len: int = 200) -> str:
    v = re.sub(r"\s+", " ", str(v or "")).strip()
    if not v:
        raise HTTPException(400, f"חסר {field}")
    return v[:max_len]


class Web:
    """Holds the dependencies the routes need."""

    def __init__(self, ctx) -> None:
        self.ctx = ctx
        self.settings = ctx.settings
        self.db = ctx.db
        self.engine = ctx.saas
        self.session_signer = Signer(ctx.app_secret, "session")
        self.state_signer = Signer(ctx.app_secret, "oauth-state")
        self.login_email = Throttle(8)
        self.login_ip = Throttle(30)
        self.code_email = Throttle(3)
        self.code_ip = Throttle(15)
        self.check_ip = Throttle(30)
        self.member_adds = Throttle(30, window=24 * 3600)

    def system_mail(self, to: str, subject: str, text: str) -> bool:
        """Sends from the TotanRomi system Gmail (the env-configured account).
        A fresh client per message: the Google HTTP client is not thread-safe."""
        s = self.settings
        if not s.gmail_configured:
            return False
        try:
            from ..gmail.auth import build_gmail_service
            from ..gmail.client import GmailClient
            from ..reports.notifications import SUBJECT_TAG

            msg = EmailMessage()
            msg["Subject"] = f"{SUBJECT_TAG} {subject}"
            msg["From"] = s.source_gmail_account
            msg["To"] = to
            msg.set_content(text)
            GmailClient(build_gmail_service(s), max_attempts=1).send_raw(msg.as_bytes())
            return True
        except Exception as exc:
            log.warning("System email failed: %s", type(exc).__name__)
            return False

    def base_url(self, request: Request | None = None) -> str:
        s = self.settings
        if s.public_base_url:
            return s.public_base_url.rstrip("/")
        dom = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
        if dom:
            return f"https://{dom}"
        if request is not None:
            proto = request.headers.get("x-forwarded-proto", request.url.scheme)
            host = request.headers.get("x-forwarded-host", request.headers.get("host", ""))
            return f"{proto}://{host}"
        return "http://localhost:8080"

    def secure_cookie(self, request: Request) -> bool:
        return self.base_url(request).startswith("https://")


def create_router(ctx) -> tuple[APIRouter, Web]:
    web = Web(ctx)
    r = APIRouter()

    # ------------------------------------------------------------ session deps
    def current_user(request: Request) -> User:
        data = web.session_signer.verify(request.cookies.get(COOKIE))
        if not data:
            raise HTTPException(401, "not logged in")
        with web.db.repo() as repo:
            u = repo.s.get(User, int(data.get("uid", 0)))
            if u is None or not u.active or u.session_version != data.get("ver"):
                raise HTTPException(401, "not logged in")
            if u.org_id is not None:
                org = repo.s.get(Organization, u.org_id)
                if org is None or not org.active:
                    raise HTTPException(403, "החשבון של העסק מושהה")
            repo.s.expunge(u)
            return u

    def csrf(request: Request) -> None:
        if request.method in ("POST", "PUT", "PATCH", "DELETE") and \
                request.headers.get("x-requested-with") != "fetch":
            raise HTTPException(403, "bad request origin")

    def ready(u: User = Depends(current_user)) -> User:
        """Logged in AND not holding a temporary password any more."""
        if u.must_change_password:
            raise HTTPException(403, "יש להחליף את הסיסמה הראשונית לפני שממשיכים")
        return u

    def manager(u: User = Depends(ready)) -> User:
        if u.role != Role.MANAGER or u.org_id is None:
            raise HTTPException(403, "למנהלים בלבד")
        return u

    def member(u: User = Depends(ready)) -> User:
        if u.org_id is None:
            raise HTTPException(403, "מסך של עסק - היכנסו כמנהל עסק")
        return u

    def platform_admin(u: User = Depends(ready)) -> User:
        if not u.is_platform_admin:
            raise HTTPException(403, "למנהל המערכת בלבד")
        return u

    def set_session(resp: Response, request: Request, u: User) -> None:
        tok = web.session_signer.sign({"uid": u.id, "ver": u.session_version}, SESSION_TTL)
        resp.set_cookie(COOKIE, tok, max_age=SESSION_TTL, httponly=True, samesite="lax",
                        secure=web.secure_cookie(request), path="/")

    async def body(request: Request) -> dict:
        try:
            data = await request.json()
        except Exception as exc:
            raise HTTPException(400, "bad json") from exc
        if not isinstance(data, dict):
            raise HTTPException(400, "bad json")
        return data

    # ------------------------------------------------------------ auth
    @r.post("/api/auth/login", dependencies=[Depends(csrf)])
    async def login(request: Request):
        d = await body(request)
        email = (d.get("email") or "").strip().lower()
        ip = client_ip(request)
        if web.login_email.blocked(email) or web.login_ip.blocked(ip):
            raise HTTPException(429, "יותר מדי ניסיונות. נסו שוב בעוד 15 דקות")
        with web.db.repo() as repo:
            u = repo.s.scalar(select(User).where(func.lower(User.email) == email))
            ok = u is not None and u.active and verify_password(str(d.get("password") or ""),
                                                                u.password_hash)
            if not ok:
                web.login_email.hit(email)
                web.login_ip.hit(ip)
                raise HTTPException(401, "אימייל או סיסמה שגויים")
            exp = u.temp_password_expires_at
            if u.must_change_password and exp is not None and exp < datetime.now(UTC):
                raise HTTPException(401, "הסיסמה הראשונית פגה. בקשו מהמנהל סיסמה חדשה")
            u.last_login_at = datetime.now(UTC)
            repo.s.flush()
            repo.s.expunge(u)
        resp = JSONResponse({"ok": True})
        set_session(resp, request, u)
        return resp

    @r.post("/api/auth/logout", dependencies=[Depends(csrf)])
    def logout(request: Request):
        # Invalidate the token itself, not only the browser's copy of it.
        data = web.session_signer.verify(request.cookies.get(COOKIE))
        if data:
            with web.db.repo() as repo:
                u = repo.s.get(User, int(data.get("uid", 0)))
                if u is not None and u.session_version == data.get("ver"):
                    u.session_version += 1
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/")
        return resp

    @r.post("/api/auth/logout-everywhere", dependencies=[Depends(csrf)])
    def logout_all(u: User = Depends(current_user)):
        with web.db.repo() as repo:
            repo.s.get(User, u.id).session_version += 1
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE, path="/")
        return resp

    @r.get("/api/me")
    def me(u: User = Depends(current_user)):
        with web.db.repo() as repo:
            org = repo.s.get(Organization, u.org_id) if u.org_id else None
            mbs = list(repo.s.scalars(select(Mailbox).where(Mailbox.user_id == u.id)))
            out = {
                "user": {"id": u.id, "name": u.name, "email": u.email, "role": u.role,
                         "is_platform_admin": u.is_platform_admin,
                         "must_change_password": bool(u.must_change_password)},
                "org": None,
                "mailboxes": [{"id": m.id, "email": m.email, "status": m.status,
                               "last_error": m.last_error, "drive": bool(m.scopes and
                                                                          "drive.file" in m.scopes),
                               "last_poll_at": m.last_poll_at.isoformat() if m.last_poll_at else None}
                              for m in mbs],
                "global_production": web.settings.forward_switches_on,
            }
            if org:
                out["org"] = {"id": org.id, "name": org.name, "accountant_email": org.accountant_email,
                              "production": bool(org.production_enabled and
                                                 web.settings.forward_switches_on),
                              "google_app": "org" if web.engine.org_client(org) else (
                                  "shared" if web.engine.shared_client() else "none")}
        return out

    # ------------------------------------------------------------ passwords
    @r.post("/api/auth/change-password", dependencies=[Depends(csrf)])
    async def change_password(request: Request, u: User = Depends(current_user)):
        d = await body(request)
        new = str(d.get("password") or "")
        problem = password_problem(new)
        if problem:
            raise HTTPException(400, problem)
        with web.db.repo() as repo:
            me = repo.s.get(User, u.id)
            if not verify_password(str(d.get("current") or ""), me.password_hash):
                raise HTTPException(400, "הסיסמה הנוכחית שגויה")
            if verify_password(new, me.password_hash):
                raise HTTPException(400, "בחרו סיסמה חדשה ששונה מהקודמת")
            me.password_hash = hash_password(new)
            me.must_change_password = False
            me.temp_password_expires_at = None
            me.session_version += 1  # other devices are signed out
            repo.s.flush()
            repo.s.expunge(me)
        resp = JSONResponse({"ok": True})
        set_session(resp, request, me)
        return resp

    def throttle_codes(request: Request, email: str) -> None:
        ip = client_ip(request)
        if web.code_email.blocked(email) or web.code_ip.blocked(ip):
            raise HTTPException(429, "נשלחו כבר כמה קודים. נסו שוב בעוד 15 דקות")
        web.code_email.hit(email)
        web.code_ip.hit(ip)

    def issue_code(kind: str, email: str, subject: str, intro: str) -> bool:
        code = new_code()
        now = datetime.now(UTC)
        with web.db.repo() as repo:
            # only the newest code is valid
            repo.s.execute(update(Invite).where(Invite.kind == kind, Invite.email == email,
                                                Invite.used_at.is_(None)).values(used_at=now))
            repo.s.add(Invite(token_hash=token_hash(f"{kind}:{email}:{code}:{new_code()}"),
                              kind=kind, email=email, note=token_hash(f"{email}:{code}"),
                              attempts=0, expires_at=now + timedelta(seconds=CODE_TTL)))
        return web.system_mail(email, subject, f"שלום,\n\n{intro}\n\nהקוד שלך: {code}\n\n"
                               "הקוד בתוקף ל-15 דקות. אם לא ביקשת, אפשר להתעלם מהמייל.")

    def check_code(request: Request, kind: str, email: str, code: str) -> None:
        """Raises unless `code` is the newest valid code for this email; one use only.
        Wrong guesses are capped per code, per email per day (across new codes, stored
        in the database so a restart does not reset it) and per IP."""
        now = datetime.now(UTC)
        bad = "הקוד שגוי או שפג תוקפו. אפשר לבקש קוד חדש"
        ip = client_ip(request)
        if web.check_ip.blocked(ip):
            raise HTTPException(429, "יותר מדי ניסיונות. נסו שוב בעוד 15 דקות")
        with web.db.repo() as repo:
            failures = repo.s.scalar(select(func.coalesce(func.sum(Invite.attempts), 0)).where(
                Invite.kind == kind, Invite.email == email,
                Invite.created_at > now - timedelta(days=1))) or 0
            if failures >= CODE_DAILY_FAILURES:
                raise HTTPException(429, "יותר מדי קודים שגויים. נסו שוב מחר")
            inv = repo.s.scalar(select(Invite).where(
                Invite.kind == kind, Invite.email == email, Invite.used_at.is_(None),
                Invite.expires_at > now).order_by(Invite.id.desc()).limit(1))
            if inv is None:
                raise HTTPException(400, bad)
            ok = hmac.compare_digest(inv.note or "", token_hash(f"{email}:{code.strip()}"))
            inv_id = inv.id
            if not ok:
                # atomic increment: parallel guesses cannot lose updates
                repo.s.execute(update(Invite).where(Invite.id == inv_id).values(
                    attempts=func.coalesce(Invite.attempts, 0) + 1))
                repo.s.execute(update(Invite).where(
                    Invite.id == inv_id, Invite.attempts >= CODE_MAX_ATTEMPTS,
                    Invite.used_at.is_(None)).values(used_at=now))
        if not ok:  # the counter above is committed; now refuse
            web.check_ip.hit(ip)
            raise HTTPException(400, bad)
        with web.db.repo() as repo:
            res = repo.s.execute(update(Invite).where(Invite.id == inv_id,
                                                      Invite.used_at.is_(None))
                                 .values(used_at=datetime.now(UTC)))
            if res.rowcount != 1:
                raise HTTPException(400, bad)

    @r.post("/api/signup/code", dependencies=[Depends(csrf)])
    async def signup_code(request: Request):
        d = await body(request)
        email = clean_email(d.get("email"))
        with web.db.repo() as repo:
            if claimed_user(repo, email) is not None:
                raise HTTPException(409, "כבר קיים חשבון עם המייל הזה. היכנסו או לחצו על "
                                         "\"שכחתי סיסמה\"")
        throttle_codes(request, email)
        if not await run_in_threadpool(
                issue_code, "verify", email, "קוד אימות להרשמה",
                "זה קוד האימות להרשמת העסק שלך למערכת החשבוניות של TotanRomi."):
            raise HTTPException(503, "לא הצלחנו לשלוח את קוד האימות. נסו שוב בעוד כמה דקות")
        return {"ok": True}

    @r.post("/api/auth/reset-code", dependencies=[Depends(csrf)])
    async def reset_code(request: Request):
        d = await body(request)
        email = clean_email(d.get("email"))
        with web.db.repo() as repo:
            exists = repo.s.scalar(select(User.id).where(func.lower(User.email) == email,
                                                         User.active.is_(True)))
        throttle_codes(request, email)  # same limits whether or not the account exists
        if exists:
            await run_in_threadpool(issue_code, "reset", email, "קוד לאיפוס סיסמה",
                                    "ביקשת לאפס את הסיסמה שלך במערכת החשבוניות של TotanRomi.")
        # same answer either way: the form never reveals who has an account
        return {"ok": True}

    @r.post("/api/auth/reset", dependencies=[Depends(csrf)])
    async def reset_password(request: Request):
        d = await body(request)
        email = clean_email(d.get("email"))
        new = str(d.get("password") or "")
        problem = password_problem(new)
        if problem:
            raise HTTPException(400, problem)
        check_code(request, "reset", email, str(d.get("code") or ""))
        with web.db.repo() as repo:
            u = repo.s.scalar(select(User).where(func.lower(User.email) == email))
            if u is None or not u.active:
                raise HTTPException(400, "החשבון לא פעיל")
            u.password_hash = hash_password(new)
            u.must_change_password = False
            u.temp_password_expires_at = None
            u.session_version += 1
            repo.s.flush()
            repo.s.expunge(u)
        web.login_email.hits.pop(email, None)
        resp = JSONResponse({"ok": True})
        set_session(resp, request, u)
        return resp

    def claimed_user(repo, email: str) -> User | None:
        """The existing account for this email, ignoring one a manager created that was
        never used - otherwise anyone could squat an address by "adding an employee"."""
        u = repo.s.scalar(select(User).where(func.lower(User.email) == email))
        if u is not None and u.must_change_password and u.last_login_at is None \
                and not u.is_platform_admin:
            return None
        return u

    def release_unclaimed(repo, email: str) -> None:
        u = repo.s.scalar(select(User).where(func.lower(User.email) == email))
        if u is not None and claimed_user(repo, email) is None:
            log.info("Verified owner of an unused added account took the address back")
            for mb in repo.s.scalars(select(Mailbox).where(Mailbox.user_id == u.id)):
                mb.user_id = None
            repo.s.delete(u)
            repo.s.flush()

    def is_admin_email(email: str) -> bool:
        admin = (web.settings.platform_admin_email or web.settings.source_gmail_account or "")
        return bool(admin) and email == admin.strip().lower()

    # ------------------------------------------------------------ invites / signup
    def load_invite(repo, tok: str, kind: str | None = None) -> Invite:
        inv = repo.s.scalar(select(Invite).where(Invite.token_hash == token_hash(tok or "")))
        if inv is None or inv.used_at is not None or inv.expires_at < datetime.now(UTC) or (
                kind and inv.kind != kind):
            raise HTTPException(404, "הקישור לא תקף או שכבר נוצל. בקשו קישור חדש")
        return inv

    def consume_invite(repo, inv: Invite) -> None:
        """Atomic: two parallel requests can never both use the same link."""
        res = repo.s.execute(update(Invite).where(Invite.id == inv.id, Invite.used_at.is_(None))
                             .values(used_at=datetime.now(UTC)))
        if res.rowcount != 1:
            raise HTTPException(404, "הקישור לא תקף או שכבר נוצל. בקשו קישור חדש")

    @r.get("/api/invite/{tok}")
    def invite_info(tok: str):
        with web.db.repo() as repo:
            inv = load_invite(repo, tok)
            org = repo.s.get(Organization, inv.org_id) if inv.org_id else None
            return {"kind": inv.kind, "email": inv.email, "name": inv.name, "role": inv.role,
                    "org_name": org.name if org else None}

    def create_user(repo, *, org_id, email, name, role, password, admin=False) -> User:
        problem = password_problem(password)
        if problem:
            raise HTTPException(400, problem)
        if repo.s.scalar(select(User).where(func.lower(User.email) == email)) is not None:
            raise HTTPException(409, "כבר קיים משתמש עם המייל הזה")
        u = User(org_id=org_id, email=email, name=name, role=role, is_platform_admin=admin,
                 password_hash=hash_password(password))
        repo.s.add(u)
        repo.s.flush()
        return u

    @r.post("/api/setup", dependencies=[Depends(csrf)])
    async def setup_admin(request: Request):
        d = await body(request)
        with web.db.repo() as repo:
            inv = load_invite(repo, d.get("token", ""), "admin")
            u = create_user(repo, org_id=None, email=inv.email, name=clean_text(d.get("name"), "שם"),
                            role=Role.MANAGER, password=str(d.get("password") or ""), admin=True)
            consume_invite(repo, inv)
            repo.s.expunge(u)
        resp = JSONResponse({"ok": True})
        set_session(resp, request, u)
        return resp

    @r.post("/api/signup", dependencies=[Depends(csrf)])
    async def signup(request: Request):
        d = await body(request)
        if not d.get("token"):
            return await open_signup(request, d)
        with web.db.repo() as repo:
            inv = load_invite(repo, d.get("token", ""), "org")
            acc = d.get("accountant_email")
            org = Organization(name=clean_text(d.get("org_name"), "שם העסק"),
                               accountant_email=clean_email(acc) if acc else None)
            repo.s.add(org)
            repo.s.flush()
            u = create_user(repo, org_id=org.id, email=clean_email(d.get("email")),
                            name=clean_text(d.get("name"), "שם"), role=Role.MANAGER,
                            password=str(d.get("password") or ""))
            consume_invite(repo, inv)
            inv.org_id = org.id
            repo.s.expunge(u)
        resp = JSONResponse({"ok": True})
        set_session(resp, request, u)
        return resp

    async def open_signup(request: Request, d: dict):
        """Anyone with the app link: the email is proven by the emailed code."""
        email = clean_email(d.get("email"))
        org_name = clean_text(d.get("org_name"), "שם העסק")
        name = clean_text(d.get("name"), "שם")
        acc = (d.get("accountant_email") or "").strip()
        acc_email = clean_email(acc) if acc else None
        problem = password_problem(str(d.get("password") or ""))
        if problem:
            raise HTTPException(400, problem)
        with web.db.repo() as repo:
            if claimed_user(repo, email) is not None:
                raise HTTPException(409, "כבר קיים חשבון עם המייל הזה")
        check_code(request, "verify", email, str(d.get("code") or ""))
        with web.db.repo() as repo:
            release_unclaimed(repo, email)  # the code proved this person owns the inbox
            org = Organization(name=org_name, accountant_email=acc_email)
            repo.s.add(org)
            repo.s.flush()
            # The TotanRomi owner (verified by the code sent to that inbox) is also the
            # platform admin, as long as no platform admin exists yet.
            admin = is_admin_email(email) and not repo.s.scalar(
                select(User.id).where(User.is_platform_admin.is_(True)).limit(1))
            u = create_user(repo, org_id=org.id, email=email, name=name, role=Role.MANAGER,
                            password=str(d.get("password")), admin=bool(admin))
            org_id = org.id
            repo.s.expunge(u)
        log.info("New organisation %s signed up", org_id)
        resp = JSONResponse({"ok": True})
        set_session(resp, request, u)
        return resp

    @r.post("/api/join", dependencies=[Depends(csrf)])
    async def join(request: Request):
        d = await body(request)
        with web.db.repo() as repo:
            inv = load_invite(repo, d.get("token", ""), "user")
            u = create_user(repo, org_id=inv.org_id, email=inv.email,
                            name=clean_text(d.get("name") or inv.name, "שם"),
                            role=inv.role if inv.role in Role.ALL else Role.EMPLOYEE,
                            password=str(d.get("password") or ""))
            consume_invite(repo, inv)
            repo.s.expunge(u)
        resp = JSONResponse({"ok": True})
        set_session(resp, request, u)
        return resp

    # ------------------------------------------------------------ mailbox connect (OAuth)
    @r.get("/oauth/google/start")
    def oauth_start(request: Request, app: str = "auto", u: User = Depends(member)):
        with web.db.repo() as repo:
            org = repo.s.get(Organization, u.org_id)
            org_client = web.engine.org_client(org)
        chosen = "org" if (app == "org" or (app == "auto" and org_client)) else "shared"
        client = org_client if chosen == "org" else web.engine.shared_client()
        if client is None:
            return RedirectResponse("/app?connect_error=no_google_app#settings", status_code=303)
        # The state is bound to this browser (nonce cookie) and to this session's user,
        # so a consent link cannot be handed to someone else to attach their mailbox.
        nonce, nonce_hash = new_link_token()
        state = web.state_signer.sign({"uid": u.id, "org": u.org_id, "app": chosen,
                                       "n": nonce_hash}, 900)
        resp = RedirectResponse(authorization_url(client, web.base_url(request) + CALLBACK_PATH,
                                                  state, login_hint=u.email), status_code=303)
        resp.set_cookie(NONCE_COOKIE, nonce, max_age=900, httponly=True, samesite="lax",
                        secure=web.secure_cookie(request), path=CALLBACK_PATH)
        return resp

    @r.get(CALLBACK_PATH)
    def oauth_callback(request: Request, state: str = "", code: str = "", error: str = ""):
        resp = _oauth_callback(request, state, code, error)
        resp.delete_cookie(NONCE_COOKIE, path=CALLBACK_PATH)
        return resp

    def _oauth_callback(request: Request, state: str, code: str, error: str) -> Response:
        st = web.state_signer.verify(state)
        nonce = request.cookies.get(NONCE_COOKIE) or ""
        if not st or not nonce or not hmac.compare_digest(token_hash(nonce), str(st.get("n"))):
            return RedirectResponse("/app?connect_error=expired", status_code=303)
        try:
            me = current_user(request)
        except HTTPException:
            return RedirectResponse("/login", status_code=303)
        if me.id != st.get("uid"):
            return RedirectResponse("/app?connect_error=user", status_code=303)
        if error or not code:
            return RedirectResponse(f"/app?connect_error={html.escape(error or 'cancelled')}",
                                    status_code=303)
        with web.db.repo() as repo:
            u = repo.s.get(User, st["uid"])
            org = repo.s.get(Organization, st["org"])
            if u is None or org is None or not u.active or u.org_id != org.id:
                return RedirectResponse("/app?connect_error=user", status_code=303)
            client = web.engine.client_for(org, st["app"])
        if client is None:
            return RedirectResponse("/app?connect_error=no_google_app", status_code=303)
        try:
            tok = exchange_code(client, code, web.base_url(request) + CALLBACK_PATH)
        except OAuthError as exc:
            log.warning("OAuth exchange failed: %s", exc)
            return RedirectResponse(f"/app?connect_error={html.escape(str(exc)[:60])}",
                                    status_code=303)
        if not tok.refresh_token:
            return RedirectResponse("/app?connect_error=no_refresh_token", status_code=303)
        with web.db.repo() as repo:
            mb = repo.s.scalar(select(Mailbox).where(func.lower(Mailbox.email) == tok.email))
            if mb is not None and mb.org_id != org.id:
                return RedirectResponse("/app?connect_error=mailbox_in_other_org", status_code=303)
            if mb is None:
                mb = Mailbox(org_id=org.id, user_id=u.id, email=tok.email)
                repo.s.add(mb)
            mb.user_id = mb.user_id or u.id
            mb.oauth_app = st["app"]
            mb.refresh_token_enc = ctx.vault.encrypt(tok.refresh_token)
            mb.scopes = tok.scopes
            mb.status = "active"
            mb.last_error = None
            mb.token_version = (mb.token_version or 0) + 1
            repo.s.flush()
            mailbox_id = mb.id
            if tok.email == (web.settings.source_gmail_account or "").lower():
                Q.link_legacy_emails(repo.s, org.id, mailbox_id)
        web.engine.invalidate(mailbox_id)
        web.engine.start_initial_scan(mailbox_id, days=7)
        return RedirectResponse("/app?connected=1", status_code=303)

    @r.post("/api/mailboxes/{mid}/pause", dependencies=[Depends(csrf)])
    async def pause_mailbox(mid: int, request: Request, u: User = Depends(member)):
        d = await body(request)
        with web.db.repo() as repo:
            mb = repo.s.get(Mailbox, mid)
            if mb is None or mb.org_id != u.org_id or (u.role != Role.MANAGER and mb.user_id != u.id):
                raise HTTPException(404, "not found")
            mb.status = "paused" if d.get("paused") else "active"
        web.engine.invalidate(mid)
        return {"ok": True}

    @r.post("/api/scan", dependencies=[Depends(csrf)])
    def scan(u: User = Depends(member)):
        return {"ok": True, "started": web.engine.scan_org(u.org_id)}

    # ------------------------------------------------------------ data
    def scope(repo, u: User) -> Q.Scope:
        return Q.Scope.for_user(repo.s, u)

    @r.get("/api/dashboard")
    def dashboard(u: User = Depends(member)):
        with web.db.repo() as repo:
            org = repo.s.get(Organization, u.org_id)
            return Q.dashboard(repo.s, scope(repo, u), web.settings.tz, org.minutes_per_document)

    @r.get("/api/emails")
    def emails(bucket: str = "", q: str = "", offset: int = 0, u: User = Depends(member)):
        with web.db.repo() as repo:
            rows, total = Q.list_emails(repo.s, scope(repo, u), bucket or None, q or None,
                                        limit=50, offset=max(0, offset))
            return {"items": rows, "total": total}

    @r.get("/api/emails/{eid}")
    def email_detail(eid: int, u: User = Depends(member)):
        with web.db.repo() as repo:
            sc = scope(repo, u)
            e = Q.get_email(repo.s, sc, eid)
            if e is None:
                raise HTTPException(404, "not found")
            return Q.email_detail(repo.s, sc, e)

    @r.post("/api/emails/{eid}/review", dependencies=[Depends(csrf)])
    async def review(eid: int, request: Request, u: User = Depends(member)):
        d = await body(request)
        decision = d.get("decision")
        if decision not in ("invoice", "not_invoice"):
            raise HTTPException(400, "bad decision")
        with web.db.repo() as repo:
            e = Q.get_email(repo.s, scope(repo, u), eid)
            if e is None:
                raise HTTPException(404, "not found")
            if e.status not in Q.REVIEW:
                raise HTTPException(409, "המסמך כבר טופל")
            e.status = EmailStatus.CONFIRMED_INVOICE if decision == "invoice" \
                else EmailStatus.NOT_INVOICE
            e.reviewed_by, e.reviewed_at = u.id, datetime.now(UTC)
            mailbox_id, message_id = e.mailbox_id, e.message_id
        # Mirror the decision as a Gmail label (best effort, labels are only added).
        label = "Invoice/Detected" if decision == "invoice" else "Invoice/Not-Invoice"
        threading.Thread(target=_label_async, args=(mailbox_id, message_id, label),
                         daemon=True).start()
        return {"ok": True}

    def _label_async(mailbox_id, message_id, label) -> None:
        for mb, org in web.engine.active_mailboxes():
            if mb.id == mailbox_id:
                try:
                    with web.engine.mailbox_lock(mb.id):
                        web.engine.runtime(mb, org).processor.labels.apply(message_id, [label])
                except Exception as exc:
                    log.warning("Review label failed: %s", type(exc).__name__)

    @r.get("/api/invoices")
    def invoices(u: User = Depends(member)):
        with web.db.repo() as repo:
            return {"months": Q.invoices_by_month(repo.s, scope(repo, u), web.settings.tz)}

    @r.get("/api/suppliers")
    def suppliers(u: User = Depends(member)):
        with web.db.repo() as repo:
            return {"items": Q.suppliers(repo.s, scope(repo, u))}

    @r.get("/api/reports")
    def reports(u: User = Depends(manager)):
        with web.db.repo() as repo:
            return Q.reports(repo.s, scope(repo, u), web.settings.tz)

    @r.get("/api/reports/excel")
    def reports_excel(u: User = Depends(manager)):
        from openpyxl import Workbook

        with web.db.repo() as repo:
            sc = scope(repo, u)
            org = repo.s.get(Organization, u.org_id)
            owners = Q.mailbox_owner_map(repo.s, u.org_id)
            docs = Q.documents(repo.s, sc)
            rows = [Q.email_card(e, owners) for e in docs]
        wb = Workbook()
        ws = wb.active
        ws.title = "חשבוניות"
        ws.sheet_view.rightToLeft = True
        head = ["תאריך", "ספק", "מספר חשבונית", "סכום", "מטבע", "סטטוס", "ודאות AI %", "עובד/ת",
                "קישור ל-Drive"]
        ws.append(head)
        names = {"invoice": "חשבונית", "review": "לבדיקה", "not_invoice": "לא חשבונית",
                 "error": "שגיאה", "pending": "בתהליך"}
        for x in rows:
            ws.append([(x["received_at"] or "")[:10], xl_text(x["supplier"]),
                       xl_text(x["invoice_number"] or ""),
                       x["total"], xl_text(x["currency"] or ""),
                       names.get(x["bucket"], x["bucket"]), x["score"], xl_text(x["owner"]),
                       f"https://drive.google.com/file/d/{x['drive_file_id']}/view"
                       if x["drive_file_id"] else ""])
        buf = io.BytesIO()
        wb.save(buf)
        fname = f"invoices_{datetime.now(web.settings.tz).strftime('%Y-%m-%d')}.xlsx"
        return Response(buf.getvalue(), media_type="application/vnd.openxmlformats-officedocument."
                        "spreadsheetml.sheet",
                        headers={"Content-Disposition": f'attachment; filename="{fname}"',
                                 "X-Org": str(org.id)})

    # ------------------------------------------------------------ team (manager)
    @r.get("/api/team")
    def team(request: Request, u: User = Depends(manager)):
        with web.db.repo() as repo:
            now = datetime.now(web.settings.tz)
            m0 = Q.month_start(now).astimezone(UTC)
            day0 = now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
            members = Q.team_stats(repo.s, u.org_id, m0, day0)
            invites = list(repo.s.scalars(select(Invite).where(
                Invite.org_id == u.org_id, Invite.kind == "user", Invite.used_at.is_(None),
                Invite.expires_at > datetime.now(UTC))))
            users = {x.id: x for x in repo.s.scalars(select(User).where(User.org_id == u.org_id))}
            for m in members:
                m["email"] = users[m["user_id"]].email
            return {"members": members,
                    "pending_invites": [{"id": i.id, "email": i.email, "name": i.name, "role": i.role,
                                         "expires_at": i.expires_at.isoformat()} for i in invites]}

    @r.post("/api/team/invite", dependencies=[Depends(csrf)])
    async def invite(request: Request, u: User = Depends(manager)):
        d = await body(request)
        email = clean_email(d.get("email"))
        name = clean_text(d.get("name"), "שם")
        role = d.get("role") if d.get("role") in Role.ALL else Role.EMPLOYEE
        tok, th = new_link_token()
        with web.db.repo() as repo:
            if repo.s.scalar(select(User).where(func.lower(User.email) == email)) is not None:
                raise HTTPException(409, "כבר קיים משתמש עם המייל הזה")
            repo.s.add(Invite(token_hash=th, kind="user", org_id=u.org_id, email=email, name=name,
                              role=role, created_by=u.id,
                              expires_at=datetime.now(UTC) + timedelta(days=7)))
            org = repo.s.get(Organization, u.org_id)
        link = f"{web.base_url(request)}/join?t={tok}"
        sent = (await run_in_threadpool(send_invite_email, u, org.name, email, name, link)
                if d.get("send_email") else False)
        return {"link": link, "sent": sent}

    @r.post("/api/team/add", dependencies=[Depends(csrf)])
    async def add_member(request: Request, u: User = Depends(manager)):
        d = await body(request)
        email = clean_email(d.get("email"))
        name = clean_text(d.get("name"), "שם")
        role = d.get("role") if d.get("role") in Role.ALL else Role.EMPLOYEE
        if is_admin_email(email):
            raise HTTPException(409, "כבר קיים חשבון עם המייל הזה")
        if web.member_adds.blocked(str(u.org_id)):
            raise HTTPException(429, "הגעתם למספר ההוספות היומי. נסו שוב מחר")
        web.member_adds.hit(str(u.org_id))
        pw = temp_password()
        with web.db.repo() as repo:
            t = create_user(repo, org_id=u.org_id, email=email, name=name, role=role, password=pw)
            t.must_change_password = True
            t.temp_password_expires_at = datetime.now(UTC) + timedelta(hours=TEMP_PASSWORD_HOURS)
            org_name = repo.s.get(Organization, u.org_id).name
        login = f"{web.base_url(request)}/login"
        text = login_details_text(name, u.name, org_name, login, email, pw)
        sent = (await run_in_threadpool(send_member_email, u, email,
                                        f"הצטרפת למערכת החשבוניות של {org_name}", text)
                if d.get("send_email") else False)
        return {"login_url": login, "email": email, "temp_password": pw, "sent": sent,
                "message": text}

    @r.post("/api/team/{uid}/reset-password", dependencies=[Depends(csrf)])
    async def reset_member_password(uid: int, request: Request, u: User = Depends(manager)):
        pw = temp_password()
        with web.db.repo() as repo:
            t = repo.s.get(User, uid)
            if t is None or t.org_id != u.org_id or t.id == u.id or t.is_platform_admin:
                raise HTTPException(404, "not found")
            if t.role == Role.MANAGER:
                # a manager resets their own password by email code, never by a colleague
                raise HTTPException(403, "מנהל מאפס סיסמה בעצמו דרך \"שכחתי סיסמה\"")
            t.password_hash = hash_password(pw)
            t.must_change_password = True
            t.temp_password_expires_at = datetime.now(UTC) + timedelta(hours=TEMP_PASSWORD_HOURS)
            t.session_version += 1
            email, name = t.email, t.name
            org_name = repo.s.get(Organization, u.org_id).name
        login = f"{web.base_url(request)}/login"
        return {"login_url": login, "email": email, "temp_password": pw,
                "message": login_details_text(name, u.name, org_name, login, email, pw)}

    def login_details_text(name, sender, org_name, login, email, pw) -> str:
        return (f"שלום {name},\n\n{sender} פתח/ה לך חשבון במערכת החשבוניות של {org_name}.\n\n"
                f"כניסה: {login}\nאימייל: {email}\nסיסמה ראשונית: {pw}\n\n"
                "בכניסה הראשונה המערכת תבקש לבחור סיסמה חדשה, ואחר כך לחבר את תיבת ה-Gmail.")

    def send_member_email(sender: User, to: str, subject: str, text: str) -> bool:
        """From the manager's own connected Gmail when there is one, else from the
        TotanRomi system address."""
        for mb, org in web.engine.active_mailboxes():
            if mb.user_id == sender.id and mb.status == "active":
                try:
                    lock = web.engine.mailbox_lock(mb.id)
                    msg = EmailMessage()
                    msg["Subject"] = subject
                    msg["From"] = mb.email
                    msg["To"] = to
                    msg.set_content(text)
                    if lock.acquire(timeout=15):
                        try:
                            web.engine.runtime(mb, org).processor.gmail.send_raw(msg.as_bytes())
                        finally:
                            lock.release()
                        return True
                except Exception as exc:
                    log.warning("Member email via manager mailbox failed: %s",
                                type(exc).__name__)
                break
        return web.system_mail(to, subject, text)

    def send_invite_email(sender: User, org_name: str, to: str, name: str, link: str) -> bool:
        """Sends the invitation from the manager's own connected Gmail (if any)."""
        for mb, org in web.engine.active_mailboxes():
            if mb.user_id == sender.id and mb.status == "active":
                try:
                    lock = web.engine.mailbox_lock(mb.id)
                    msg = EmailMessage()
                    msg["Subject"] = f"[Invoice Automation] הוזמנת ל-{org_name}"
                    msg["From"] = mb.email
                    msg["To"] = to
                    text = (f"שלום {name},\n\n{sender.name} הזמין/ה אותך למערכת החשבוניות של "
                            f"{org_name}.\nלהצטרפות: {link}\n\nהקישור בתוקף ל-7 ימים.")
                    msg.set_content(text)
                    # A long scan may hold the mailbox; the manager can still copy the link.
                    if not lock.acquire(timeout=15):
                        return False
                    try:
                        web.engine.runtime(mb, org).processor.gmail.send_raw(msg.as_bytes())
                    finally:
                        lock.release()
                    return True
                except Exception as exc:
                    log.warning("Invite email failed: %s", type(exc).__name__)
                    return False
        return False

    @r.post("/api/team/{uid}/active", dependencies=[Depends(csrf)])
    async def set_active(uid: int, request: Request, u: User = Depends(manager)):
        d = await body(request)
        with web.db.repo() as repo:
            t = repo.s.get(User, uid)
            if t is None or t.org_id != u.org_id or t.id == u.id:
                raise HTTPException(404, "not found")
            if t.is_platform_admin:
                raise HTTPException(403, "אי אפשר להשבית את מנהל המערכת")
            t.active = bool(d.get("active"))
            t.session_version += 1
            for mb in repo.s.scalars(select(Mailbox).where(Mailbox.user_id == t.id)):
                mb.status = "active" if t.active and mb.refresh_token_enc else "paused"
                web.engine.invalidate(mb.id)
        return {"ok": True}

    @r.post("/api/team/invites/{iid}/cancel", dependencies=[Depends(csrf)])
    def cancel_invite(iid: int, u: User = Depends(manager)):
        with web.db.repo() as repo:
            inv = repo.s.get(Invite, iid)
            if inv is None or inv.org_id != u.org_id:
                raise HTTPException(404, "not found")
            inv.used_at = datetime.now(UTC)
        return {"ok": True}

    # ------------------------------------------------------------ settings (manager)
    @r.get("/api/settings")
    def get_settings_(request: Request, u: User = Depends(manager)):
        with web.db.repo() as repo:
            o = repo.s.get(Organization, u.org_id)
            return {"name": o.name, "accountant_email": o.accountant_email or "",
                    "forward_threshold": round(o.forward_threshold * 100),
                    "notify_detections": o.notify_detections,
                    "save_review_to_drive": o.save_review_to_drive,
                    "minutes_per_document": o.minutes_per_document,
                    "google_client_id": o.google_client_id or "",
                    "google_client_secret_set": bool(o.google_client_secret_enc),
                    "redirect_uri": web.base_url(request) + CALLBACK_PATH,
                    "production": bool(o.production_enabled and web.settings.forward_switches_on),
                    "shared_app_available": web.engine.shared_client() is not None}

    @r.put("/api/settings", dependencies=[Depends(csrf)])
    async def put_settings(request: Request, u: User = Depends(manager)):
        d = await body(request)
        with web.db.repo() as repo:
            o = repo.s.get(Organization, u.org_id)
            if "name" in d:
                o.name = clean_text(d["name"], "שם העסק")
            if "accountant_email" in d:
                acc = (d.get("accountant_email") or "").strip()
                new_acc = clean_email(acc) if acc else None
                if new_acc != o.accountant_email and o.production_enabled:
                    # Forwarding was approved for the previous address only.
                    o.production_enabled = False
                    log.warning("Org %s changed the accountant address; production switched "
                                "off until the platform admin approves again", o.id)
                o.accountant_email = new_acc
            if "forward_threshold" in d:
                t = int(d["forward_threshold"])
                if not 80 <= t <= 99:
                    raise HTTPException(400, "הסף חייב להיות בין 80% ל-99%")
                o.forward_threshold = t / 100
            for k in ("notify_detections", "save_review_to_drive"):
                if k in d:
                    setattr(o, k, bool(d[k]))
            if "minutes_per_document" in d:
                o.minutes_per_document = max(0.5, min(60.0, float(d["minutes_per_document"])))
            if "google_client_id" in d:
                cid = (d.get("google_client_id") or "").strip()
                if cid and not cid.endswith(".apps.googleusercontent.com"):
                    raise HTTPException(400, "Client ID צריך להסתיים ב-.apps.googleusercontent.com")
                o.google_client_id = cid or None
            if d.get("google_client_secret"):
                sec = str(d["google_client_secret"]).strip()
                if re.search(r"\s", sec) or len(sec) < 10:
                    raise HTTPException(400, "Client Secret לא תקין")
                o.google_client_secret_enc = ctx.vault.encrypt(sec)
            ids = list(repo.s.scalars(select(Mailbox.id).where(Mailbox.org_id == o.id)))
        for mid in ids:
            web.engine.invalidate(mid)
        return {"ok": True}

    # ------------------------------------------------------------ platform admin
    @r.get("/api/admin/orgs")
    def admin_orgs(u: User = Depends(platform_admin)):
        with web.db.repo() as repo:
            out = []
            m0 = Q.month_start(datetime.now(web.settings.tz)).astimezone(UTC)
            for o in repo.s.scalars(select(Organization).order_by(Organization.created_at)):
                users = repo.s.scalar(select(func.count(User.id)).where(User.org_id == o.id))
                mbs = list(repo.s.scalars(select(Mailbox).where(Mailbox.org_id == o.id)))
                docs = repo.s.scalar(select(func.count(Email.id)).where(
                    Email.org_id == o.id, Email.status != EmailStatus.NO_ATTACHMENTS,
                    Email.received_at >= m0))
                mgr = repo.s.scalar(select(User).where(User.org_id == o.id,
                                                       User.role == Role.MANAGER).limit(1))
                out.append({"id": o.id, "name": o.name, "manager": mgr.name if mgr else "",
                            "manager_email": mgr.email if mgr else "", "users": users,
                            "mailboxes": len(mbs),
                            "mailbox_errors": sum(1 for m in mbs if m.status == "error"),
                            "month_documents": docs, "active": o.active,
                            "production_enabled": o.production_enabled,
                            "google_app": "org" if o.google_client_id else "shared",
                            "created_at": o.created_at.isoformat()})
            invites = [{"id": i.id, "note": i.note, "expires_at": i.expires_at.isoformat()}
                       for i in repo.s.scalars(select(Invite).where(
                           Invite.kind == "org", Invite.used_at.is_(None),
                           Invite.expires_at > datetime.now(UTC)))]
            return {"orgs": out, "pending_signups": invites,
                    "global_production": web.settings.forward_switches_on}

    @r.post("/api/admin/my-org", dependencies=[Depends(csrf)])
    async def admin_my_org(request: Request, u: User = Depends(platform_admin)):
        """Lets the platform admin run their own business in the app as well."""
        d = await body(request)
        with web.db.repo() as repo:
            me_ = repo.s.get(User, u.id)
            if me_.org_id is not None:
                raise HTTPException(409, "כבר יש לך עסק")
            acc = d.get("accountant_email")
            org = Organization(name=clean_text(d.get("name"), "שם העסק"),
                               accountant_email=clean_email(acc) if acc else None)
            repo.s.add(org)
            repo.s.flush()
            me_.org_id, me_.role = org.id, Role.MANAGER
        return {"ok": True}

    @r.post("/api/admin/signup-link", dependencies=[Depends(csrf)])
    async def admin_signup_link(request: Request, u: User = Depends(platform_admin)):
        d = await body(request)
        tok, th = new_link_token()
        with web.db.repo() as repo:
            repo.s.add(Invite(token_hash=th, kind="org", note=str(d.get("note") or "")[:300],
                              created_by=u.id, expires_at=datetime.now(UTC) + timedelta(days=14)))
        return {"link": f"{web.base_url(request)}/signup?t={tok}"}

    @r.post("/api/admin/orgs/{oid}", dependencies=[Depends(csrf)])
    async def admin_org_update(oid: int, request: Request, u: User = Depends(platform_admin)):
        d = await body(request)
        with web.db.repo() as repo:
            o = repo.s.get(Organization, oid)
            if o is None:
                raise HTTPException(404, "not found")
            if "active" in d:
                o.active = bool(d["active"])
            if "production_enabled" in d:
                want = bool(d["production_enabled"])
                if want and d.get("confirm") != "PRODUCTION":
                    raise HTTPException(400, "כדי להפעיל העברה אמיתית יש להקליד PRODUCTION")
                if want and not o.accountant_email:
                    raise HTTPException(400, "לעסק אין כתובת רואה חשבון")
                o.production_enabled = want
                log.warning("Org %s production_enabled=%s by admin %s", oid, want, u.id)
            ids = list(repo.s.scalars(select(Mailbox.id).where(Mailbox.org_id == o.id)))
        for mid in ids:
            web.engine.invalidate(mid)
        return {"ok": True}

    return r, web


# ---------------------------------------------------------------- mounting
def mount(app: FastAPI, ctx) -> None:
    router, web = create_router(ctx)
    app.include_router(router)
    app.state.saas_web = web

    index = WEB_DIR / "app.html"

    def page() -> HTMLResponse:
        return HTMLResponse(index.read_text(encoding="utf-8"),
                            headers={"Cache-Control": "no-store",
                                     "X-Frame-Options": "DENY",
                                     "Referrer-Policy": "same-origin"})

    for path in ("/app", "/login", "/signup", "/join", "/setup", "/forgot"):
        app.add_api_route(path, page, methods=["GET"], response_class=HTMLResponse,
                          include_in_schema=False)
