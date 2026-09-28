"""Runs the invoice engine on every mailbox connected in the web app.

Each mailbox gets its own Gmail client, labels, forwarder and processor, built
from the mailbox's encrypted refresh token. The organisation's settings are
layered on top of the global Settings:

- target (accountant) = organisation.accountant_email
- forwarding needs BOTH the three global safety switches in the environment
  AND organisation.production_enabled (set only by the platform admin).
  Otherwise the per-mailbox Settings copy has dry_run=True, so the unchanged
  SafetyGuard blocks every send.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select

from ..config.settings import Settings
from ..gmail.auth import describe_auth_error
from ..gmail.client import GmailClient
from ..gmail.forwarder import Forwarder
from ..gmail.labels import LabelManager
from ..gmail.watcher import Watcher
from ..processor import Processor
from ..reports.notifications import Notifier
from .drive import DriveSaver
from .google_oauth import OAuthClient, build_credentials
from .models import Mailbox, Organization
from .security import Vault

log = logging.getLogger(__name__)


def org_settings(base: Settings, org: Organization, mailbox_email: str) -> Settings:
    on = bool(org.production_enabled)
    return base.model_copy(update={
        "source_gmail_account": mailbox_email,
        "target_gmail_account": (org.accountant_email or "").strip(),
        "dry_run": base.dry_run if on else True,
        "auto_forward_enabled": base.auto_forward_enabled if on else False,
        "production_confirmation": base.production_confirmation if on else False,
        "invoice_auto_forward_threshold": float(org.forward_threshold or 0.90),
        "notify_detections": "dry_run" if org.notify_detections else "off",
        "backfill_forward_enabled": False,
        "supplier_whitelist_enabled": False,
    })


@dataclass
class Runtime:
    key: tuple
    watcher: Watcher
    processor: Processor


class SaasEngine:
    def __init__(self, settings: Settings, db, ai, extractor, vault: Vault) -> None:
        self.settings = settings
        self.db = db
        self.ai = ai
        self.extractor = extractor
        self.vault = vault
        self._rt: dict[int, Runtime] = {}
        self._lock = threading.Lock()
        # The Gmail/Drive HTTP clients are not thread-safe: one user at a time per mailbox.
        self._mb_locks: dict[int, threading.RLock] = {}
        self._scanning: set[int] = set()

    def mailbox_lock(self, mailbox_id: int) -> threading.RLock:
        with self._lock:
            return self._mb_locks.setdefault(mailbox_id, threading.RLock())

    # ------------------------------------------------------------- oauth apps
    def shared_client(self) -> OAuthClient | None:
        s = self.settings
        if s.gmail_client_id and s.gmail_client_secret:
            return OAuthClient(s.gmail_client_id, s.gmail_client_secret)
        return None

    def org_client(self, org: Organization) -> OAuthClient | None:
        secret = self.vault.decrypt(org.google_client_secret_enc)
        if org.google_client_id and secret:
            return OAuthClient(org.google_client_id.strip(), secret)
        return None

    def client_for(self, org: Organization, oauth_app: str) -> OAuthClient | None:
        return self.org_client(org) if oauth_app == "org" else self.shared_client()

    # ------------------------------------------------------------- runtimes
    def _key(self, mb: Mailbox, org: Organization) -> tuple:
        return (mb.token_version, mb.oauth_app, org.accountant_email, org.forward_threshold,
                org.production_enabled, org.notify_detections, org.save_review_to_drive,
                org.google_client_id)

    def invalidate(self, mailbox_id: int) -> None:
        with self._lock:
            self._rt.pop(mailbox_id, None)

    def runtime(self, mb: Mailbox, org: Organization) -> Runtime:
        key = self._key(mb, org)
        with self._lock:
            rt = self._rt.get(mb.id)
            if rt is not None and rt.key == key:
                return rt
        client = self.client_for(org, mb.oauth_app)
        token = self.vault.decrypt(mb.refresh_token_enc)
        if client is None or not token:
            raise RuntimeError("mailbox not connected (missing Google app or token)")
        from google.auth.transport.requests import Request
        from googleapiclient.discovery import build

        creds = build_credentials(client, token)
        creds.refresh(Request())
        s = self.settings
        gmail = GmailClient(build("gmail", "v1", credentials=creds, cache_discovery=False),
                            max_attempts=s.retry_max_attempts, base_delay=s.retry_base_delay_seconds)
        ms = org_settings(s, org, mb.email)
        labels = LabelManager(gmail)
        forwarder = Forwarder(ms, gmail, labels)
        notifier = Notifier(ms, gmail) if org.notify_detections else None
        saver = None
        if mb.scopes and "drive.file" in mb.scopes:
            drive = DriveSaver(build("drive", "v3", credentials=creds, cache_discovery=False),
                               root_id=mb.drive_root_id,
                               on_root=lambda rid, mid=mb.id: self._store_root(mid, rid))
            saver = self._make_saver(drive, bool(org.save_review_to_drive))
        processor = Processor(ms, self.db, gmail, self.extractor, self.ai, forwarder, labels,
                              notifier, tenant={"org_id": org.id, "mailbox_id": mb.id},
                              saver=saver)
        watcher = Watcher(ms, self.db, gmail, processor, state_prefix=f"mbx{mb.id}:")
        rt = Runtime(key, watcher, processor)
        with self._lock:
            self._rt[mb.id] = rt
        return rt

    def _store_root(self, mailbox_id: int, root_id: str) -> None:
        with self.db.repo() as repo:
            mb = repo.s.get(Mailbox, mailbox_id)
            if mb is not None:
                mb.drive_root_id = root_id

    @staticmethod
    def _make_saver(drive: DriveSaver, save_review: bool):
        def saver(repo, e, parsed, outcomes, review: bool) -> None:
            if review and not save_review:
                return
            c = e.classification
            supplier = (c.supplier if c else None) or e.sender_name or e.sender_email or ""
            for o in outcomes:
                if o.data is None or not o.key:
                    continue
                att = repo.get_attachment(e, o.key)
                if att is None or att.drive_file_id:
                    continue
                att.drive_file_id = drive.save(o.data, o.filename, o.mime_type or "",
                                               received=e.received_at, supplier=supplier,
                                               review=review)
        return saver

    # ------------------------------------------------------------- polling
    def active_mailboxes(self) -> list[tuple[Mailbox, Organization]]:
        with self.db.repo() as repo:
            rows = repo.s.execute(
                select(Mailbox, Organization).join(Organization, Organization.id == Mailbox.org_id)
                .where(Mailbox.status.in_(("active", "error")), Organization.active.is_(True))
            ).all()
            return [(m, o) for m, o in rows]

    def poll_mailbox(self, mb: Mailbox, org: Organization, *, backfill_days: int = 0) -> dict:
        try:
            with self.mailbox_lock(mb.id):
                rt = self.runtime(mb, org)
                res = (rt.watcher.backfill(backfill_days) if backfill_days
                       else rt.watcher.poll_once())
            self._mark(mb.id, "active", None)
            return res
        except Exception as exc:
            reason = describe_auth_error(exc)
            log.error("Mailbox %s poll failed: %s", mb.id, reason)
            self.invalidate(mb.id)
            self._mark(mb.id, "error", reason[:500])
            return {}

    def _mark(self, mailbox_id: int, status: str, error: str | None) -> None:
        with self.db.repo() as repo:
            mb = repo.s.get(Mailbox, mailbox_id)
            if mb is None or mb.status == "paused":
                return
            mb.status = status
            mb.last_error = error
            mb.last_poll_at = datetime.now(UTC)

    def poll_all(self, org_id: int | None = None) -> int:
        n = 0
        for mb, org in self.active_mailboxes():
            if org_id is not None and org.id != org_id:
                continue
            self.poll_mailbox(mb, org)
            n += 1
        return n

    def scan_org(self, org_id: int) -> bool:
        """Manual "scan now": at most one running scan per organization."""
        with self._lock:
            if org_id in self._scanning:
                return False
            self._scanning.add(org_id)

        def run():
            try:
                self.poll_all(org_id)
            except Exception as exc:
                log.error("Manual scan failed: %s", type(exc).__name__)
            finally:
                with self._lock:
                    self._scanning.discard(org_id)
        threading.Thread(target=run, daemon=True).start()
        return True

    def start_initial_scan(self, mailbox_id: int, days: int = 7) -> None:
        """After connecting: look back a few days (never forwards - backfill)."""
        def run():
            for mb, org in self.active_mailboxes():
                if mb.id == mailbox_id:
                    try:
                        with self.mailbox_lock(mb.id):
                            self.runtime(mb, org).processor.labels.ensure_labels()
                    except Exception as exc:
                        log.warning("Label setup failed for mailbox %s: %s", mailbox_id,
                                    type(exc).__name__)
                    self.poll_mailbox(mb, org, backfill_days=days)
                    self.poll_mailbox(mb, org)
        threading.Thread(target=run, daemon=True).start()

    def connected_emails(self) -> set[str]:
        """Every mailbox connected in the web app, whatever its status: once the
        env account is connected there, the org's settings govern it for good."""
        with self.db.repo() as repo:
            return {e.lower() for e in repo.s.scalars(select(Mailbox.email))}
