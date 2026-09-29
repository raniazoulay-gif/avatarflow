"""Google OAuth "web server" flow for connecting a Gmail mailbox.

Scopes: gmail.modify (read, add labels, send forwards - never delete) and
drive.file (the app can only see files it created itself in the user's Drive).
"""

from __future__ import annotations

import urllib.parse
from dataclasses import dataclass

import requests  # type: ignore[import-untyped]

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
SCOPES = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive.file",
]
CALLBACK_PATH = "/oauth/google/callback"


@dataclass
class OAuthClient:
    client_id: str
    client_secret: str


@dataclass
class TokenResult:
    email: str
    refresh_token: str | None
    scopes: str


class OAuthError(Exception):
    pass


def authorization_url(client: OAuthClient, redirect_uri: str, state: str,
                      login_hint: str | None = None) -> str:
    params = {
        "client_id": client.client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",  # always return a refresh token
        "include_granted_scopes": "true",
        "state": state,
    }
    if login_hint:
        params["login_hint"] = login_hint
    return AUTH_URL + "?" + urllib.parse.urlencode(params)


def exchange_code(client: OAuthClient, code: str, redirect_uri: str,
                  http=requests) -> TokenResult:
    r = http.post(TOKEN_URL, data={
        "code": code, "client_id": client.client_id, "client_secret": client.client_secret,
        "redirect_uri": redirect_uri, "grant_type": "authorization_code"}, timeout=20)
    if r.status_code != 200:
        try:
            err = r.json().get("error", "unknown")
        except ValueError:
            err = f"http {r.status_code}"
        raise OAuthError(f"token exchange failed: {err}")
    tok = r.json()
    scopes = tok.get("scope", "")
    if "gmail.modify" not in scopes:
        raise OAuthError("missing_gmail_permission")
    info = http.get(USERINFO_URL, headers={"Authorization": f"Bearer {tok['access_token']}"},
                    timeout=20)
    if info.status_code != 200:
        raise OAuthError("could not read account email")
    email = (info.json().get("email") or "").lower()
    if not email:
        raise OAuthError("account has no email")
    return TokenResult(email=email, refresh_token=tok.get("refresh_token"), scopes=scopes)


def build_credentials(client: OAuthClient, refresh_token: str):
    from google.oauth2.credentials import Credentials

    # No `scopes`: a refresh then keeps exactly what the user granted. Asking for a
    # fixed list fails with invalid_scope when a permission (e.g. Drive) was not ticked.
    return Credentials(token=None, refresh_token=refresh_token, client_id=client.client_id,
                       client_secret=client.client_secret, token_uri=TOKEN_URL)
