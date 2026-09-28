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
    now = datetime.now(UTC)
    with db.repo() as repo:
        if repo.s.scalar(select(User.id).where(User.is_platform_admin.is_(True)).limit(1)):
            return "admin exists"
        pending = repo.s.scalar(select(Invite).where(
            Invite.kind == "admin", Invite.used_at.is_(None), Invite.expires_at > now))
        if pending is not None:
            return "setup link already sent"
        tok, th = new_link_token()
        repo.s.add(Invite(token_hash=th, kind="admin", email=admin_email,
                          expires_at=now + timedelta(days=7)))
    link = f"{base}/setup?t={tok}"
    sent = False
    if gmail is not None and settings.source_gmail_account.lower() == admin_email:
        try:
            msg = EmailMessage()
            msg["Subject"] = f"{SUBJECT_TAG} הקמת חשבון מנהל המערכת"
            msg["From"] = settings.source_gmail_account
            msg["To"] = admin_email
            msg.set_content(
                "שלום,\n\nזה הקישור החד-פעמי להקמת חשבון מנהל המערכת (TotanRomi) "
                f"באפליקציית החשבוניות:\n{link}\n\nהקישור בתוקף ל-7 ימים. אם לא ביקשת, התעלם.")
            gmail.send_raw(msg.as_bytes())
            sent = True
        except Exception as exc:
            log.warning("Could not email the admin setup link: %s", type(exc).__name__)
    if not sent:
        log.warning("Platform admin setup link (valid 7 days): %s", link)
    return "setup link sent" if sent else "setup link logged"
