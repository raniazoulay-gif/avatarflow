"""First-run setup of the platform admin (TotanRomi).

No password is ever set from environment variables. Instead, a one-time setup
link is emailed to PLATFORM_ADMIN_EMAIL (default: SOURCE_GMAIL_ACCOUNT) from
that same Gmail account - only the owner of that inbox can create the admin.
"""

from __future__ import annotations

import logging
import os
from datetime import UTC, datetime, timedelta
from email.message import EmailMessage

from sqlalchemy import select

from ..reports.notifications import SUBJECT_TAG
from .models import Invite, User
from .security import new_link_token

log = logging.getLogger(__name__)


def public_base_url(settings) -> str:
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/")
    dom = os.environ.get("RAILWAY_PUBLIC_DOMAIN", "").strip()
    return f"https://{dom}" if dom else ""


def ensure_platform_admin(settings, db, gmail) -> str:
    admin_email = (settings.platform_admin_email or settings.source_gmail_account or "").lower()
    if not admin_email:
        return "no admin email configured"
    base = public_base_url(settings)
    if not base:
        # Without a public address the emailed link would be useless.
        log.warning("Admin setup postponed: set PUBLIC_BASE_URL (or a Railway public domain)")
        return "no public url"
    state = _admin_state(db)
    if state is not None:
        return state
    if gmail is None or settings.source_gmail_account.lower() != admin_email:
        log.warning("Admin setup link not emailed; run: python -m src.main admin-link")
        return "run admin-link"
    tok, th = new_link_token()
    link = f"{base}/setup?t={tok}"
    try:
        msg = EmailMessage()
        msg["Subject"] = f"{SUBJECT_TAG} הקמת חשבון מנהל המערכת"
        msg["From"] = settings.source_gmail_account
        msg["To"] = admin_email
        msg.set_content(
            "שלום,\n\nזה הקישור החד-פעמי להקמת חשבון מנהל המערכת (TotanRomi) "
            f"באפליקציית החשבוניות:\n{link}\n\nהקישור בתוקף ל-7 ימים. אם לא ביקשת, התעלם.")
        gmail.send_raw(msg.as_bytes())
    except Exception as exc:
        # The link itself is never logged: anyone reading logs could become admin.
        log.warning("Could not email the admin setup link (%s); run: python -m src.main "
                    "admin-link", type(exc).__name__)
        return "email failed"
    _store_admin_invite(db, th, admin_email)
    return "setup link sent"


def _admin_state(db) -> str | None:
    now = datetime.now(UTC)
    with db.repo() as repo:
        if repo.s.scalar(select(User.id).where(User.is_platform_admin.is_(True)).limit(1)):
            return "admin exists"
        pending = repo.s.scalar(select(Invite.id).where(
            Invite.kind == "admin", Invite.used_at.is_(None), Invite.expires_at > now).limit(1))
        return "setup link already sent" if pending else None


def _store_admin_invite(db, token_hash: str, email: str) -> None:
    with db.repo() as repo:
        repo.s.add(Invite(token_hash=token_hash, kind="admin", email=email,
                          expires_at=datetime.now(UTC) + timedelta(days=7)))


def create_admin_link(settings, db) -> str:
    """For the CLI (run by whoever has shell access): prints a fresh setup link."""
    admin_email = (settings.platform_admin_email or settings.source_gmail_account or "").lower()
    if not admin_email:
        raise ValueError("no admin email configured")
    with db.repo() as repo:
        if repo.s.scalar(select(User.id).where(User.is_platform_admin.is_(True)).limit(1)):
            raise ValueError("a platform admin already exists")
    tok, th = new_link_token()
    _store_admin_invite(db, th, admin_email)
    base = public_base_url(settings) or "http://localhost:8080"
    return f"{base}/setup?t={tok}"
