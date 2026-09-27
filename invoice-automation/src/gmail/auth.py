"""Gmail OAuth 2.0 using a stored refresh token (no passwords are stored).

google-auth refreshes the short-lived access token automatically whenever it
expires; we also refresh eagerly at build time so that misconfiguration is
detected on startup instead of on the first email.
"""

from __future__ import annotations

from ..config.settings import Settings

# gmail.modify = read + labels + send. The code never calls delete/trash.
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
TOKEN_URI = "https://oauth2.googleapis.com/token"


class GmailNotConfigured(Exception):
    pass


def build_credentials(settings: Settings):
    if not settings.gmail_configured:
        raise GmailNotConfigured(
            "Gmail NOT CONFIGURED: set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN"
        )
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
