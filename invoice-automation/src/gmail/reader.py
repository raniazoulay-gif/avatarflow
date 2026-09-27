"""Parse Gmail API message resources into plain data."""

from __future__ import annotations

import base64
import html
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parseaddr
from typing import Any


@dataclass
class AttachmentRef:
    key: str  # stable per message: partId:filename
    attachment_id: str | None
    filename: str
    mime_type: str
    size: int
    inline_data: bytes | None = None


@dataclass
class ParsedEmail:
    message_id: str
    thread_id: str | None
    sender_name: str
    sender_email: str
    subject: str
    received_at: datetime | None
    body_text: str
    attachments: list[AttachmentRef] = field(default_factory=list)


def _headers(payload: dict[str, Any]) -> dict[str, str]:
    return {h["name"].lower(): h["value"] for h in payload.get("headers", [])}


def _b64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _walk(part: dict[str, Any]):
    yield part
    for p in part.get("parts", []) or []:
        yield from _walk(p)


def _strip_html(s: str) -> str:
    s = re.sub(r"(?is)<(script|style).*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def parse_message(msg: dict[str, Any]) -> ParsedEmail:
    payload = msg.get("payload", {}) or {}
    hdr = _headers(payload)
    name, addr = parseaddr(hdr.get("from", ""))
    received = None
    if msg.get("internalDate"):
        received = datetime.fromtimestamp(int(msg["internalDate"]) / 1000, tz=UTC)

    plain: list[str] = []
    htmls: list[str] = []
    attachments: list[AttachmentRef] = []
    for part in _walk(payload):
        body = part.get("body", {}) or {}
        filename = part.get("filename") or ""
        mime = (part.get("mimeType") or "").lower()
        if filename:
            attachments.append(AttachmentRef(
                key=f"{part.get('partId', '')}:{filename}",
                attachment_id=body.get("attachmentId"),
                filename=filename,
                mime_type=mime,
                size=int(body.get("size", 0) or 0),
                inline_data=_b64(body["data"]) if body.get("data") and not body.get("attachmentId")
                else None,
            ))
        elif mime == "text/plain" and body.get("data"):
            plain.append(_b64(body["data"]).decode("utf-8", errors="replace"))
        elif mime == "text/html" and body.get("data"):
            htmls.append(_b64(body["data"]).decode("utf-8", errors="replace"))

    text = "\n".join(plain) if plain else _strip_html("\n".join(htmls))
    return ParsedEmail(
        message_id=msg["id"],
        thread_id=msg.get("threadId"),
        sender_name=name or "",
        sender_email=(addr or "").lower(),
        subject=hdr.get("subject", ""),
        received_at=received,
        body_text=text,
        attachments=attachments,
    )
