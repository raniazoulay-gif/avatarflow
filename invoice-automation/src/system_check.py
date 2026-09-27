"""First-run SYSTEM CHECK. Reports only what was actually verified."""

from __future__ import annotations

from dataclasses import dataclass

from .config.settings import EMAIL_RE, Settings
from .database.repository import Database
from .documents.ocr import ocr_available
from .documents.word import doc_support


@dataclass
class CheckItem:
    name: str
    status: str
    detail: str = ""

    @property
    def ok(self) -> bool:
        return self.status in ("OK", "CONNECTED", "CONFIGURED", "DRY RUN", "PRODUCTION")


def run_system_check(settings: Settings, *, verify_remote: bool = True,
                     gmail_client=None) -> list[CheckItem]:
    items: list[CheckItem] = []

    # Gmail
    if not settings.gmail_configured:
        missing = [n for n, v in (("GMAIL_CLIENT_ID", settings.gmail_client_id),
                                  ("GMAIL_CLIENT_SECRET", settings.gmail_client_secret),
                                  ("GMAIL_REFRESH_TOKEN", settings.gmail_refresh_token)) if not v]
        items.append(CheckItem("Gmail", "NOT CONFIGURED", "missing: " + ", ".join(missing)))
    elif not verify_remote:
        items.append(CheckItem("Gmail", "NOT VERIFIED", "credentials present, not tested"))
    else:
        try:
            if gmail_client is None:
                from .gmail.auth import build_gmail_service
                from .gmail.client import GmailClient

                gmail_client = GmailClient(build_gmail_service(settings), max_attempts=2)
            profile = gmail_client.get_profile()
            addr = profile.get("emailAddress", "")
            detail = f"authenticated as {addr}"
            if settings.source_gmail_account and addr.lower() != settings.source_gmail_account.lower():
                items.append(CheckItem("Gmail", "ERROR",
                                       f"token belongs to {addr}, not SOURCE_GMAIL_ACCOUNT"))
            else:
                items.append(CheckItem("Gmail", "CONNECTED", detail))
        except Exception as exc:
            from .gmail.auth import describe_auth_error

            items.append(CheckItem("Gmail", "ERROR", describe_auth_error(exc)))

    # Source account
    if not EMAIL_RE.match(settings.source_gmail_account or ""):
        items.append(CheckItem("Source Gmail", "NOT CONFIGURED", "set SOURCE_GMAIL_ACCOUNT"))
    else:
        items.append(CheckItem("Source Gmail", "CONFIGURED", settings.source_gmail_account))

    # Database
    try:
        db = Database(settings.database_url)
        db.create_all()
        db.ping()
        items.append(CheckItem("Database", "OK", settings.database_url.split("://")[0]))
    except Exception as exc:
        items.append(CheckItem("Database", "ERROR", type(exc).__name__))

    # AI
    if not settings.ai_configured:
        items.append(CheckItem("AI", "NOT CONFIGURED", "set AI_API_KEY (rules-only mode: nothing "
                                                       "will be auto-forwarded)"))
    elif not verify_remote:
        items.append(CheckItem("AI", "NOT VERIFIED", "key present, not tested"))
    else:
        try:
            from .classification.ai_classifier import AnthropicBackend

            AnthropicBackend(settings.ai_api_key, settings.ai_model).verify()
            items.append(CheckItem("AI", "CONNECTED", f"model {settings.ai_model}"))
        except Exception as exc:
            items.append(CheckItem("AI", "ERROR", type(exc).__name__))

    # Target
    if not settings.target_gmail_account:
        items.append(CheckItem("Target Gmail", "NOT CONFIGURED", "set TARGET_GMAIL_ACCOUNT"))
    elif not settings.target_configured:
        items.append(CheckItem("Target Gmail", "ERROR", "invalid address or same as source"))
    else:
        items.append(CheckItem("Target Gmail", "CONFIGURED",
                               f"{settings.target_gmail_account} (address format only - delivery "
                               f"NOT VERIFIED)"))

    items.append(CheckItem("Timezone", "OK", settings.timezone))
    items.append(CheckItem("Daily report", "OK", f"{settings.daily_report_time} {settings.timezone}"))
    items.append(CheckItem("OCR", "OK" if ocr_available() else "NOT CONFIGURED",
                           "tesseract + pdftoppm" if ocr_available()
                           else "install tesseract-ocr tesseract-ocr-heb poppler-utils"))
    ds = doc_support()
    items.append(CheckItem("Legacy .doc", "OK" if ds != "none" else "LIMITATION",
                           ds if ds != "none" else "install antiword or LibreOffice"))
    items.append(CheckItem("Gmail Watch (Pub/Sub)",
                           "CONFIGURED" if settings.gmail_pubsub_topic else "NOT CONFIGURED",
                           "push NOT VERIFIED until first notification"
                           if settings.gmail_pubsub_topic else "polling fallback will be used"))

    mode = settings.mode
    detail = ("forwarding DISABLED" if mode == "DRY_RUN"
              else "forwarding ENABLED (all 3 switches set)")
    if mode == "DRY_RUN" and (not settings.dry_run) != settings.auto_forward_enabled:
        detail += " - switches partially set; ALL of DRY_RUN=false, AUTO_FORWARD_ENABLED=true, " \
                  "PRODUCTION_CONFIRMATION=true are required"
    items.append(CheckItem("Mode", "DRY RUN" if mode == "DRY_RUN" else "PRODUCTION", detail))
    return items


def format_check(items: list[CheckItem]) -> str:
    lines = ["", "SYSTEM CHECK", "=" * 60]
    for it in items:
        mark = "✔" if it.ok else ("✖" if it.status == "ERROR" else "•")
        lines.append(f"{mark} {it.name + ':':<24} {it.status:<16} {it.detail}")
    lines.append("=" * 60)
    return "\n".join(lines)
