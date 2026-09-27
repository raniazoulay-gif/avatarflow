"""Thin wrapper around the official Gmail API with exponential-backoff retry.

This class intentionally exposes NO delete / trash / remove-label / modify-body
operations. The only write operations are: create label, ADD labels, send.
`send_raw` must only be called from gmail.forwarder (guarded) and
reports.email_report (daily report to the source account itself).
"""

from __future__ import annotations

import base64
import logging
from typing import Any, Protocol

from ..utils.retry import NonRetryableError, retry_call

log = logging.getLogger(__name__)


class GmailAPI(Protocol):
    def get_profile(self) -> dict[str, Any]: ...
    def list_message_ids(self, query: str, max_results: int = 500) -> list[str]: ...
    def get_message(self, message_id: str) -> dict[str, Any]: ...
    def get_raw_message(self, message_id: str) -> bytes: ...
    def get_attachment(self, message_id: str, attachment_id: str) -> bytes: ...
    def list_labels(self) -> list[dict[str, Any]]: ...
    def create_label(self, name: str) -> dict[str, Any]: ...
    def add_labels(self, message_id: str, label_ids: list[str]) -> None: ...
    def send_raw(self, raw: bytes, thread_id: str | None = None) -> dict[str, Any]: ...
    def watch(self, topic: str) -> dict[str, Any]: ...


def _is_retryable(exc: Exception) -> bool:
    status = getattr(getattr(exc, "resp", None), "status", None)
    if status is None:
        return True  # network errors etc.
    return int(status) in (429, 500, 502, 503, 504)


class GmailClient:
    def __init__(self, service, *, max_attempts: int = 5, base_delay: float = 1.0) -> None:
        self.svc = service
        self.max_attempts = max_attempts
        self.base_delay = base_delay

    def _call(self, what: str, fn, max_attempts: int | None = None):
        def wrapped():
            try:
                return fn().execute(num_retries=0)
            except Exception as exc:
                if not _is_retryable(exc):
                    raise NonRetryableError(f"{what}: {exc}") from exc
                raise

        return retry_call(wrapped, max_attempts=max_attempts or self.max_attempts,
                          base_delay=self.base_delay, what=f"Gmail {what}")

    def get_profile(self) -> dict[str, Any]:
        return self._call("getProfile", lambda: self.svc.users().getProfile(userId="me"))

    def list_message_ids(self, query: str, max_results: int = 500) -> list[str]:
        ids: list[str] = []
        token = None
        while True:
            resp = self._call("messages.list", lambda t=token: self.svc.users().messages().list(
                userId="me", q=query, pageToken=t, maxResults=min(500, max_results)))
            ids.extend(m["id"] for m in resp.get("messages", []))
            token = resp.get("nextPageToken")
            if not token or len(ids) >= max_results:
                return ids[:max_results]

    def get_message(self, message_id: str) -> dict[str, Any]:
        return self._call("messages.get", lambda: self.svc.users().messages().get(
            userId="me", id=message_id, format="full"))

    def get_raw_message(self, message_id: str) -> bytes:
        resp = self._call("messages.get(raw)", lambda: self.svc.users().messages().get(
            userId="me", id=message_id, format="raw"))
        return base64.urlsafe_b64decode(resp["raw"])

    def get_attachment(self, message_id: str, attachment_id: str) -> bytes:
        resp = self._call("attachments.get", lambda: self.svc.users().messages().attachments().get(
            userId="me", messageId=message_id, id=attachment_id))
        return base64.urlsafe_b64decode(resp["data"])

    def list_labels(self) -> list[dict[str, Any]]:
        return self._call("labels.list", lambda: self.svc.users().labels().list(
            userId="me")).get("labels", [])

    def create_label(self, name: str) -> dict[str, Any]:
        body = {"name": name, "labelListVisibility": "labelShow",
                "messageListVisibility": "show"}
        return self._call("labels.create", lambda: self.svc.users().labels().create(
            userId="me", body=body))

    def add_labels(self, message_id: str, label_ids: list[str]) -> None:
        # addLabelIds only - we never remove labels (incl. INBOX) from the original.
        self._call("messages.modify", lambda: self.svc.users().messages().modify(
            userId="me", id=message_id, body={"addLabelIds": label_ids}))

    def send_raw(self, raw: bytes, thread_id: str | None = None) -> dict[str, Any]:
        body: dict[str, Any] = {"raw": base64.urlsafe_b64encode(raw).decode()}
        if thread_id:
            body["threadId"] = thread_id
        # Single attempt only: sending is not idempotent. Retrying after an
        # ambiguous failure (timeout, 5xx) could deliver the message twice.
        return self._call("messages.send", lambda: self.svc.users().messages().send(
            userId="me", body=body), max_attempts=1)

    def watch(self, topic: str) -> dict[str, Any]:
        body = {"topicName": topic, "labelIds": ["INBOX"], "labelFilterBehavior": "include"}
        return self._call("watch", lambda: self.svc.users().watch(userId="me", body=body))
