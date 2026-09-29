"""New-mail detection.

Preferred: Gmail Watch + Google Pub/Sub push (-> POST /gmail/push), which
triggers an immediate poll cycle. Polling always runs as the reliable
fallback. Every cycle is idempotent: messages already in the DB with a final
status are skipped, so each email is processed exactly once.
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, datetime, timedelta

from ..config.settings import Settings
from ..database.repository import Database
from .client import GmailAPI

log = logging.getLogger(__name__)

BASE_QUERY = "-in:sent -in:drafts -in:spam -in:trash -in:chats " \
             "-subject:\"Daily Invoice Automation Report\" " \
             "-subject:\"[Invoice Automation]\""


class Watcher:
    def __init__(self, settings: Settings, db: Database, gmail: GmailAPI, processor,
                 state_prefix: str = "") -> None:
        # state_prefix keeps per-mailbox markers apart ("" = the original account)
        self.prefix = state_prefix
        self.settings = settings
        self.db = db
        self.gmail = gmail
        self.processor = processor
        self._lock = threading.Lock()

    def monitor_start_epoch(self) -> int:
        """Emails older than the first start are only handled via BACKFILL."""
        with self.db.repo() as repo:
            v = repo.get_state(self.prefix + "monitor_start_epoch")
            if v is None:
                v = str(int(time.time()) - 60)
                repo.set_state(self.prefix + "monitor_start_epoch", v)
            return int(v)

    def poll_once(self) -> dict[str, str]:
        if not self._lock.acquire(blocking=False):
            log.debug("Poll already running; skipping")
            return {}
        try:
            lookback = int(time.time()) - self.settings.poll_lookback_hours * 3600
            after = max(self.monitor_start_epoch(), lookback)
            ids = self.gmail.list_message_ids(f"after:{after} {BASE_QUERY}")
            ids.reverse()  # oldest first
            with self.db.repo() as repo:
                todo = [i for i in ids
                        if repo.needs_processing(i, self.settings.max_processing_attempts)]
                repo.set_state(self.prefix + "last_poll", datetime.now(UTC).isoformat())
            if todo:
                log.info("Poll found %d new message(s)", len(todo))
            return self.processor.process_many(todo)
        finally:
            self._lock.release()

    def backfill(self, days: int) -> dict[str, str]:
        if days <= 0:
            return {}
        # Pin the live-monitoring start BEFORE listing, so mail arriving during a
        # long backfill is picked up by polling (overlap is harmless: idempotent).
        self.monitor_start_epoch()
        with self._lock:
            since = datetime.now(UTC) - timedelta(days=days)
            ids = self.gmail.list_message_ids(f"after:{int(since.timestamp())} {BASE_QUERY}",
                                              max_results=5000)
            ids.reverse()
            log.info("Backfill: %d message(s) in last %d day(s)", len(ids), days)
            # is_backfill=True -> forwarder refuses unless BACKFILL_FORWARD_ENABLED=true
            return self.processor.process_many(ids, is_backfill=True)

    def backfill_range(self, start: datetime, end: datetime, progress=None,
                       guard=None) -> dict[str, int]:
        """Scan a range the user picked. Mail from before live monitoring started is
        history (never forwarded); mail from after it is handled exactly as the live
        poll would handle it - so "last hour" / "today" work too.
        progress(done, total) is called as messages are handled; guard() returns a
        context manager held around each Gmail call (shared client, not thread-safe)."""
        from contextlib import nullcontext

        guard = guard or nullcontext
        s_ts, e_ts, live_ts = int(start.timestamp()), int(end.timestamp()), \
            self.monitor_start_epoch()
        with self._lock:
            ids: list[str] = []
            live: set[str] = set()
            if s_ts < min(e_ts, live_ts):
                with guard():
                    part = self.gmail.list_message_ids(
                        f"after:{s_ts} before:{min(e_ts, live_ts)} {BASE_QUERY}",
                        max_results=5000)
                ids += list(reversed(part))
            if e_ts > live_ts:
                with guard():
                    part = self.gmail.list_message_ids(
                        f"after:{max(s_ts, live_ts)} before:{e_ts} {BASE_QUERY}",
                        max_results=5000)
                live = set(part)
                ids += [i for i in reversed(part) if i not in ids]
            with self.db.repo() as repo:
                todo = [i for i in ids
                        if repo.needs_processing(i, self.settings.max_processing_attempts)]
            log.info("Range scan: %d message(s), %d new", len(ids), len(todo))
            if progress:
                progress(0, len(todo))
            results: dict[str, int] = {}
            for k, mid in enumerate(todo, 1):
                with guard():
                    st = self.processor.process_many(
                        [mid], is_backfill=mid not in live).get(mid, "SKIPPED")
                results[st] = results.get(st, 0) + 1
                if progress:
                    progress(k, len(todo))
            return {"found": len(ids), "new": len(todo), **results}

    def start_watch(self) -> str:
        """Register Gmail Watch. Returns a human-readable status."""
        topic = self.settings.gmail_pubsub_topic
        if not topic:
            status = "NOT CONFIGURED (polling fallback active)"
        else:
            try:
                resp = self.gmail.watch(topic)
                exp = datetime.fromtimestamp(int(resp.get("expiration", 0)) / 1000, UTC)
                status = f"REGISTERED (expires {exp.isoformat()}); push delivery NOT VERIFIED " \
                         f"until first notification"
            except Exception as exc:
                status = f"ERROR ({type(exc).__name__}) - polling fallback active"
        with self.db.repo() as repo:
            repo.set_state("watch_status", status)
        log.info("Gmail Watch: %s", status)
        return status

    def on_push_notification(self) -> None:
        with self.db.repo() as repo:
            repo.set_state("watch_status_last_push", datetime.now(UTC).isoformat())
            st = repo.get_state("watch_status") or ""
            if st.startswith("REGISTERED"):
                repo.set_state("watch_status", st.split(";")[0] + "; push delivery VERIFIED")
        threading.Thread(target=self.poll_once, daemon=True).start()
