"""Logging configuration with secret redaction.

Never log API keys, OAuth tokens or document contents. The redaction filter is
a safety net - code should not pass secrets to the logger in the first place.
"""

from __future__ import annotations

import logging
import re

_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]+"),
    re.compile(r"ya29\.[A-Za-z0-9_\-\.]+"),  # Google access tokens
    re.compile(r"1//[A-Za-z0-9_\-]{20,}"),  # Google refresh tokens
    re.compile(r"(?i)(refresh_token|access_token|client_secret|api[_-]?key|authorization)"
               r"(['\"]?\s*[:=]\s*['\"]?)([^\s'\",]+)"),
]


def redact(text: str, secrets: list[str] | None = None) -> str:
    for s in secrets or []:
        if s and len(s) >= 6:
            text = text.replace(s, "***REDACTED***")
    for p in _PATTERNS:
        if p.groups >= 3:
            text = p.sub(lambda m: f"{m.group(1)}{m.group(2)}***REDACTED***", text)
        else:
            text = p.sub("***REDACTED***", text)
    return text


class RedactingFilter(logging.Filter):
    def __init__(self, secrets: list[str] | None = None) -> None:
        super().__init__()
        self.secrets = [s for s in (secrets or []) if s]

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:  # pragma: no cover
            return True
        record.msg = redact(msg, self.secrets)
        record.args = None
        return True


def setup_logging(level: str = "INFO", secrets: list[str] | None = None) -> None:
    root = logging.getLogger()
    root.setLevel(level.upper())
    for h in list(root.handlers):
        root.removeHandler(h)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    handler.addFilter(RedactingFilter(secrets))
    root.addHandler(handler)
    # googleapiclient logs full URLs at DEBUG; keep third-party libs quiet.
    for noisy in ("googleapiclient", "urllib3", "httpx", "anthropic", "apscheduler"):
        logging.getLogger(noisy).setLevel(max(logging.WARNING, root.level))
