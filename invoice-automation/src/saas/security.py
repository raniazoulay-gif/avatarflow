"""Passwords, signed tokens and encryption of stored OAuth refresh tokens.

Standard library + `cryptography` only:
- passwords: PBKDF2-HMAC-SHA256, 310k iterations, random salt
- sessions / OAuth state: HMAC-SHA256 signed, expiring JSON payloads
- refresh tokens: Fernet (AES-128-CBC + HMAC) with a key derived from the
  app secret
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time

from cryptography.fernet import Fernet, InvalidToken

log = logging.getLogger(__name__)

PBKDF2_ITERATIONS = 310_000


# ---------------------------------------------------------------- passwords
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iters, salt, digest = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iters))
        return hmac.compare_digest(dk.hex(), digest)
    except (ValueError, TypeError):
        return False


def password_problem(password: str) -> str | None:
    if len(password) < 8:
        return "הסיסמה צריכה להכיל לפחות 8 תווים"
    if password.isdigit() or password.isalpha():
        return "הסיסמה צריכה לשלב אותיות ומספרים"
    return None


# ---------------------------------------------------------------- tokens
def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class Signer:
    def __init__(self, secret: str, purpose: str) -> None:
        self._key = hashlib.sha256(f"{purpose}:{secret}".encode()).digest()

    def sign(self, payload: dict, ttl_seconds: int) -> str:
        body = dict(payload, exp=int(time.time()) + ttl_seconds)
        raw = _b64e(json.dumps(body, separators=(",", ":")).encode())
        mac = _b64e(hmac.new(self._key, raw.encode(), hashlib.sha256).digest())
        return f"{raw}.{mac}"

    def verify(self, token: str | None) -> dict | None:
        if not token or "." not in token:
            return None
        raw, mac = token.rsplit(".", 1)
        good = _b64e(hmac.new(self._key, raw.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(good, mac):
            return None
        try:
            body = json.loads(_b64d(raw))
        except ValueError:
            return None
        if int(body.get("exp", 0)) < time.time():
            return None
        return body


def new_link_token() -> tuple[str, str]:
    """Random one-time token for invite links; only its hash is stored."""
    tok = secrets.token_urlsafe(32)
    return tok, token_hash(tok)


def new_code() -> str:
    """6-digit code sent by email (signup verification / password reset)."""
    return f"{secrets.randbelow(1_000_000):06d}"


def temp_password() -> str:
    """Readable temporary password (no 0/O, 1/l) - letters and digits, 10 chars."""
    letters, digits = "abcdefghjkmnpqrstuvwxyz", "23456789"
    chars = [secrets.choice(letters + digits) for _ in range(8)]
    chars += [secrets.choice(letters), secrets.choice(digits)]
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


def token_hash(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


# ---------------------------------------------------------------- encryption
class Vault:
    def __init__(self, secret: str) -> None:
        key = base64.urlsafe_b64encode(hashlib.sha256(f"vault:{secret}".encode()).digest())
        self._f = Fernet(key)

    def encrypt(self, value: str) -> str:
        return self._f.encrypt(value.encode()).decode()

    def decrypt(self, value: str | None) -> str | None:
        if not value:
            return None
        try:
            return self._f.decrypt(value.encode()).decode()
        except InvalidToken:
            log.error("Stored secret could not be decrypted (APP_SECRET_KEY changed?)")
            return None


def resolve_app_secret(env_secret: str, db) -> str:
    """APP_SECRET_KEY from the environment when set; otherwise a random key
    generated once and kept in the database (so the service works without any
    manual setup). Setting APP_SECRET_KEY later would invalidate stored tokens,
    so the DB key keeps being used once it exists."""
    with db.repo() as repo:
        stored = repo.get_state("app_secret_key")
        if stored:
            return stored
        if env_secret and len(env_secret) >= 32:
            return env_secret
        stored = secrets.token_urlsafe(48)
        repo.set_state("app_secret_key", stored)
        log.warning("APP_SECRET_KEY not set - generated one and stored it in the database")
        return stored
