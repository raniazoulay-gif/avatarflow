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
                self.gmail_error = f"{type(exc).__name__}"
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
        self.processor = (Processor(settings, self.db, gmail, self.extractor, self.ai,
                                    self.forwarder, self.labels)
                          if gmail and self.forwarder else None)
        self.watcher = Watcher(settings, self.db, gmail, self.processor) if gmail else None

    # Scheduler-safe wrappers: never raise into the scheduler thread.
    def safe_poll(self) -> None:
        if not self.watcher:
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
