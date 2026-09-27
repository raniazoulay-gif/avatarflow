"""Application configuration loaded from environment variables / .env.

Safety defaults: DRY_RUN=true, AUTO_FORWARD_ENABLED=false,
PRODUCTION_CONFIRMATION=false. Nothing in this code base ever changes these
values at runtime - switching to production is a manual edit of .env.
"""

from __future__ import annotations

import re
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # Accounts
    source_gmail_account: str = ""
    target_gmail_account: str = ""

    # Gmail OAuth (refresh-token flow, no passwords)
    gmail_client_id: str = ""
    gmail_client_secret: str = ""
    gmail_refresh_token: str = ""

    # Gmail Watch + Pub/Sub (optional; polling is always the fallback)
    gmail_pubsub_topic: str = ""
    pubsub_verification_token: str = ""
    poll_interval_seconds: int = 60
    poll_lookback_hours: int = 48

    # AI
    ai_api_key: str = ""
    ai_model: str = "claude-sonnet-5"
    ai_max_doc_chars: int = 8000
    ai_weight: float = 0.70
    rule_weight: float = 0.30

    # Scheduling
    timezone: str = "Asia/Jerusalem"
    daily_report_time: str = "18:00"

    # SAFETY SWITCHES - all three must be set for any forward to happen
    dry_run: bool = True
    auto_forward_enabled: bool = False
    production_confirmation: bool = False
    dry_run_days: int = 7

    # Thresholds
    invoice_auto_forward_threshold: float = 0.90
    review_threshold: float = 0.70

    # Backfill
    backfill_days: int = 0
    backfill_forward_enabled: bool = False

    # Supplier whitelist
    supplier_whitelist_enabled: bool = False
    supplier_whitelist: str = ""  # comma separated emails or @domains

    # Files / processing
    max_attachment_size_mb: int = 25
    min_text_chars_for_pdf: int = 50
    ocr_languages: str = "heb+eng"
    ocr_max_pages: int = 5
    max_processing_attempts: int = 3

    # Retry
    retry_max_attempts: int = 5
    retry_base_delay_seconds: float = 1.0

    # Storage
    database_url: str = "sqlite:///data/invoices.db"
    reports_dir: str = "reports_out"
    store_document_text: bool = False

    # Server
    public_contact_email: str = ""  # shown on /privacy (defaults to SOURCE_GMAIL_ACCOUNT)
    host: str = "0.0.0.0"
    port: int = Field(default=8080)

    log_level: str = "INFO"

    @field_validator("gmail_client_id", "gmail_client_secret", "gmail_refresh_token",
                     "source_gmail_account", "target_gmail_account", "ai_api_key", mode="before")
    @classmethod
    def _strip(cls, v):
        # Tolerate stray whitespace/newlines from copy-paste into hosting dashboards.
        return v.strip() if isinstance(v, str) else v

    @field_validator("timezone")
    @classmethod
    def _valid_tz(cls, v: str) -> str:
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError(f"Invalid TIMEZONE: {v}") from exc
        return v

    @field_validator("daily_report_time")
    @classmethod
    def _valid_time(cls, v: str) -> str:
        if not re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", v):
            raise ValueError("DAILY_REPORT_TIME must be HH:MM (24h)")
        return v

    # ----- derived helpers -------------------------------------------------
    @property
    def tz(self) -> ZoneInfo:
        return ZoneInfo(self.timezone)

    @property
    def report_hour(self) -> int:
        return int(self.daily_report_time.split(":")[0])

    @property
    def report_minute(self) -> int:
        return int(self.daily_report_time.split(":")[1])

    @property
    def mode(self) -> str:
        return "PRODUCTION" if self.forward_switches_on else "DRY_RUN"

    @property
    def forward_switches_on(self) -> bool:
        """True only when ALL three production switches are explicitly set."""
        return (
            self.dry_run is False
            and self.auto_forward_enabled is True
            and self.production_confirmation is True
        )

    @property
    def gmail_configured(self) -> bool:
        return bool(self.gmail_client_id and self.gmail_client_secret and self.gmail_refresh_token)

    @property
    def ai_configured(self) -> bool:
        return bool(self.ai_api_key)

    @property
    def target_configured(self) -> bool:
        return bool(
            EMAIL_RE.match(self.target_gmail_account or "")
            and self.target_gmail_account.lower() != (self.source_gmail_account or "").lower()
        )

    @property
    def whitelist_entries(self) -> list[str]:
        return [s.strip().lower() for s in self.supplier_whitelist.split(",") if s.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
