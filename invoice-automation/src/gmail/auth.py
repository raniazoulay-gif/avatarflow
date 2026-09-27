"""Gmail OAuth 2.0 using a stored refresh token (no passwords are stored).

google-auth refreshes the short-lived access token automatically whenever it
expires; we also refresh eagerly at build time so that misconfiguration is
detected on startup instead of on the first email.
"""

from __future__ import annotations

import re

from ..config.settings import Settings
from ..utils.logging_setup import redact

# gmail.modify = read + labels + send. The code never calls delete/trash.
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
TOKEN_URI = "https://oauth2.googleapis.com/token"


class GmailNotConfigured(Exception):
    pass


# Google OAuth error codes -> what to fix. Codes/descriptions contain no secrets.
AUTH_HINTS = {
    "invalid_grant": "refresh token revoked/expired or issued for another client - "
                     "create a new GMAIL_REFRESH_TOKEN in OAuth Playground",
    "invalid_client": "GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET wrong or not from the same OAuth client",
    "unauthorized_client": "refresh token was issued to a different client - in OAuth Playground "
                           "check 'Use your own OAuth credentials' and create a new token",
    "deleted_client": "the OAuth client was deleted in Google Cloud",
}


def credential_format_problems(settings: Settings) -> list[str]:
    """Cheap offline checks for common copy/paste mistakes (never echoes values)."""
    problems = []
    fields = {"GMAIL_CLIENT_ID": settings.gmail_client_id,
              "GMAIL_CLIENT_SECRET": settings.gmail_client_secret,
              "GMAIL_REFRESH_TOKEN": settings.gmail_refresh_token}
    for name, value in fields.items():
        if not value:
            continue
        if any(c in value for c in "<>\"'") or re.search(r"\s", value):
            problems.append(f"{name} contains spaces, quotes or < > characters")
    if settings.gmail_client_id and not settings.gmail_client_id.endswith(
            ".apps.googleusercontent.com"):
        problems.append("GMAIL_CLIENT_ID should end with .apps.googleusercontent.com")
    if settings.gmail_refresh_token and not settings.gmail_refresh_token.startswith("1//"):
        problems.append("GMAIL_REFRESH_TOKEN should start with 1//")
    return problems


def describe_auth_error(exc: BaseException) -> str:
    """Human-readable reason for a Gmail auth failure, safe to log."""
    if isinstance(exc, GmailNotConfigured):
        # Our own messages name fields/problems only, never credential values.
        return f"{type(exc).__name__}: {exc}"
    code = None
    detail = ""
    args: tuple = tuple(getattr(exc, "args", ()))
    if len(args) > 1 and isinstance(args[1], dict):
        code = args[1].get("error")
        detail = str(args[1].get("error_description") or "")
    if not code and args:
        m = re.match(r"\s*([a-z_]+)\s*:", str(args[0]))
        if m:
            code = m.group(1)
            detail = detail or str(args[0])[m.end():].strip()
    name = type(exc).__name__
    if not code:
        return name
    text = f"{name}: {code}"
    if detail:
        text += f" ({redact(detail)[:120]})"
    if code in AUTH_HINTS:
        text += f" -> {AUTH_HINTS[code]}"
    return text


def build_credentials(settings: Settings):
    if not settings.gmail_configured:
        raise GmailNotConfigured(
            "Gmail NOT CONFIGURED: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN"
        )
    problems = credential_format_problems(settings)
    if problems:
        raise GmailNotConfigured("; ".join(problems))
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    creds = Credentials(
        token=None,
        refresh_token=settings.gmail_refresh_token,
        client_id=settings.gmail_client_id,
        client_secret=settings.gmail_client_secret,
        token_uri=TOKEN_URI,
        scopes=SCOPES,
    )
    creds.refresh(Request())
    return creds


def build_gmail_service(settings: Settings):
    from googleapiclient.discovery import build

    return build("gmail", "v1", credentials=build_credentials(settings), cache_discovery=False)
