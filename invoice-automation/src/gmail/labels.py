"""Gmail label management. Labels are only ever ADDED, never removed."""

from __future__ import annotations

import logging

from .client import GmailAPI

log = logging.getLogger(__name__)

ALL_LABELS = [
    "Invoice/DRY-RUN",
    "Invoice/Detected",
    "Invoice/Forwarded",
    "Invoice/Review",
    "Invoice/Not-Invoice",
    "Invoice/Error",
    "Invoice/New-Supplier",
]


class LabelManager:
    def __init__(self, gmail: GmailAPI) -> None:
        self.gmail = gmail
        self._ids: dict[str, str] = {}

    def ensure_labels(self) -> dict[str, str]:
        existing = {lbl["name"]: lbl["id"] for lbl in self.gmail.list_labels()}
        if "Invoice" not in existing:
            existing["Invoice"] = self.gmail.create_label("Invoice")["id"]
        for name in ALL_LABELS:
            if name not in existing:
                existing[name] = self.gmail.create_label(name)["id"]
                log.info("Created Gmail label %s", name)
        self._ids = {n: existing[n] for n in ALL_LABELS}
        return self._ids

    def apply(self, message_id: str, names: list[str]) -> None:
        if not names:
            return
        if not self._ids:
            self.ensure_labels()
        ids = [self._ids[n] for n in dict.fromkeys(names) if n in self._ids]
        if ids:
            self.gmail.add_labels(message_id, ids)
