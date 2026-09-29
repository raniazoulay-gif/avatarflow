"""Wires all components together (dependency injection root)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from .classification.ai_classifier import AIClassifier, build_ai_classifier
from .config.settings import Settings
from .database.repository import Database
from .documents.extractor import DocumentExtractor
from .gmail.client import GmailAPI, GmailClient
from .gmail.forwarder import Forwarder
from .gmail.labels import LabelManager
from .gmail.watcher import Watcher
from .processor import Processor
from .reports.email_report import generate_daily_report

log = logging.getLogger(__name__)


class AppContext:
    def __init__(self, settings: Settings, *, gmail: GmailAPI | None = None,
                 ai: AIClassifier | None = None, db: Database | None = None,
                 connect_gmail: bool = True) -> None:
        self.settings = settings
        self.db = db or Database(settings.database_url)
        self.db.create_all()
        self.gmail_error: str | None = None
        if gmail is None and connect_gmail and settings.gmail_configured:
            try:
                from .gmail.auth import build_gmail_service

                gmail = GmailClient(build_gmail_service(settings),
                                    max_attempts=settings.retry_max_attempts,
                                    base_delay=settings.retry_base_delay_seconds)
            except Exception as exc:
                from .gmail.auth import describe_auth_error

                self.gmail_error = describe_auth_error(exc)
                log.error("Gmail connection failed: %s", self.gmail_error)
        self.gmail = gmail
        self.ai = ai or build_ai_classifier(settings)
        self.extractor = DocumentExtractor(
            min_text_chars=settings.min_text_chars_for_pdf,
            ocr_languages=settings.ocr_languages, ocr_max_pages=settings.ocr_max_pages,
            retry_attempts=min(3, settings.retry_max_attempts),
            retry_base_delay=settings.retry_base_delay_seconds,
        )
        self.labels = LabelManager(gmail) if gmail else None
        self.forwarder = Forwarder(settings, gmail, self.labels) if gmail else None
        from .reports.notifications import Notifier

        self.notifier = Notifier(settings, gmail) if gmail else None
        self.processor = (Processor(settings, self.db, gmail, self.extractor, self.ai,
                                    self.forwarder, self.labels, self.notifier)
                          if gmail and self.forwarder else None)
        self.watcher = Watcher(settings, self.db, gmail, self.processor) if gmail else None

        # Multi-tenant web app: mailboxes connected by customers.
        from .saas.engine import SaasEngine
        from .saas.security import Vault, resolve_app_secret

        self.app_secret = resolve_app_secret(settings.app_secret_key, self.db)
        self.vault = Vault(self.app_secret)
        self.saas = SaasEngine(settings, self.db, self.ai, self.extractor, self.vault)
        try:
            from .saas.queries import mark_old_duplicates

            with self.db.repo() as repo:
                n = mark_old_duplicates(repo.s)
            if n:
                log.info("Moved %d duplicate email(s) out of the review queue", n)
        except Exception as exc:
            log.warning("Duplicate migration skipped: %s", type(exc).__name__)

    def bootstrap_admin(self) -> None:
        try:
            from .saas.bootstrap import ensure_platform_admin

            log.info("Platform admin: %s", ensure_platform_admin(self.settings, self.db, self.gmail))
        except Exception as exc:
            log.error("Platform admin bootstrap failed: %s", type(exc).__name__)

    def legacy_account_moved(self) -> bool:
        """The env-configured account was connected in the web app: the web app
        engine owns it now, so the original watcher stands down (no double work)."""
        src = (self.settings.source_gmail_account or "").lower()
        if not src:
            return False
        try:
            return src in self.saas.connected_emails()
        except Exception:
            return True  # fail closed: never let the legacy watcher forward by mistake

    def safe_saas_poll(self) -> None:
        try:
            self.saas.poll_all()
        except Exception as exc:
            log.error("Web-app mailbox poll failed: %s", type(exc).__name__)

    # Scheduler-safe wrappers: never raise into the scheduler thread.
    def safe_poll(self) -> None:
        if not self.watcher or self.legacy_account_moved():
            return
        try:
            self.watcher.poll_once()
        except Exception as exc:
            log.error("Poll cycle failed: %s", type(exc).__name__)
            with self.db.repo() as repo:
                repo.set_state("last_error", f"poll: {type(exc).__name__}")
                repo.set_state("last_failed_processing", datetime.now(UTC).isoformat())

    def safe_daily_report(self) -> None:
        try:
            generate_daily_report(self.settings, self.db, self.gmail)
        except Exception as exc:
            log.error("Daily report failed: %s", type(exc).__name__)
            with self.db.repo() as repo:
                repo.set_state("last_error", f"daily_report: {type(exc).__name__}")

    def safe_renew_watch(self) -> None:
        if self.watcher:
            self.watcher.start_watch()
