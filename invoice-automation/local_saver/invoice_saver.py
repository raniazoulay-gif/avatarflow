"""Invoice Saver - saves detected invoices from Gmail into a local folder.

Runs on YOUR computer (Windows Task Scheduler), next to the cloud service:

  Gmail message labelled "Invoice/Detected" (by the cloud service)
    -> download its PDF / DOC / DOCX attachments
    -> save to  SAVE_DIR\\YYYY-MM\\YYYY-MM-DD_<sender>_<original file name>
    -> add Gmail label "Invoice/Saved" so it is never saved twice

READ-ONLY towards your mail: this script can list/read messages and ADD a
label. It has no code to send, forward, delete or modify emails.

Usage:
  python invoice_saver.py --check      verify config, Gmail login and folder
  python invoice_saver.py --once       save everything pending, then exit
  python invoice_saver.py --loop 600   keep running, every 600 seconds
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parseaddr
from pathlib import Path
from typing import Any, Protocol
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = HERE / "saver_config.env"
STATE_FILE = HERE / "saved_state.json"
LOG_FILE = HERE / "invoice_saver.log"

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
TOKEN_URI = "https://oauth2.googleapis.com/token"
DETECTED_LABEL = "Invoice/Detected"
REVIEW_LABEL = "Invoice/Review"
SAVED_LABEL = "Invoice/Saved"
DOC_EXT = {".pdf", ".doc", ".docx"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".tif", ".tiff"}
INVOICE_NAME_RE = re.compile(r"(invoice|inv[_\-\s]?\d|receipt|bill|חשבונית|קבלה)", re.IGNORECASE)
WINDOWS_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)),
                    *(f"LPT{i}" for i in range(1, 10))}

log = logging.getLogger("invoice_saver")


# ------------------------------------------------------------------ config
@dataclass
class Config:
    client_id: str
    client_secret: str
    refresh_token: str
    gmail_account: str
    save_dir: Path
    save_review: bool = False
    timezone: str = "Asia/Jerusalem"
    max_messages_per_run: int = 200


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        values[key.strip()] = val.strip()
    return values


def load_config(path: Path = DEFAULT_CONFIG) -> Config:
    env = {**_read_env_file(path), **{k: v for k, v in os.environ.items() if k.startswith(
        ("GMAIL_", "SAVE_", "SAVER_"))}}
    missing = [k for k in ("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN",
                           "GMAIL_ACCOUNT", "SAVE_DIR") if not env.get(k)]
    if missing:
        raise SystemExit(f"Missing in {path.name}: {', '.join(missing)}")
    return Config(
        client_id=env["GMAIL_CLIENT_ID"],
        client_secret=env["GMAIL_CLIENT_SECRET"],
        refresh_token=env["GMAIL_REFRESH_TOKEN"],
        gmail_account=env["GMAIL_ACCOUNT"].lower(),
        save_dir=Path(os.path.expandvars(env["SAVE_DIR"])),
        save_review=env.get("SAVE_REVIEW", "false").lower() in ("1", "true", "yes"),
        timezone=env.get("SAVER_TIMEZONE", "Asia/Jerusalem"),
        max_messages_per_run=int(env.get("SAVER_MAX_MESSAGES", "200")),
    )


# ------------------------------------------------------------------ gmail
class GmailReader(Protocol):
    def profile_email(self) -> str: ...
    def label_ids(self) -> dict[str, str]: ...
    def create_label(self, name: str) -> str: ...
    def list_ids(self, label_id: str, max_results: int) -> list[str]: ...
    def get_message(self, message_id: str) -> dict[str, Any]: ...
    def get_attachment(self, message_id: str, attachment_id: str) -> bytes: ...
    def add_label(self, message_id: str, label_id: str) -> None: ...


class GoogleGmail:
    """Minimal Gmail API wrapper: read + add-label only (no send / delete)."""

    def __init__(self, cfg: Config) -> None:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        creds = Credentials(token=None, refresh_token=cfg.refresh_token, client_id=cfg.client_id,
                            client_secret=cfg.client_secret, token_uri=TOKEN_URI, scopes=SCOPES)
        creds.refresh(Request())
        self.svc = build("gmail", "v1", credentials=creds, cache_discovery=False)

    def _run(self, req, attempts: int = 4):
        for i in range(attempts):
            try:
                return req.execute()
            except Exception as exc:
                status = getattr(getattr(exc, "resp", None), "status", None)
                if i == attempts - 1 or (status is not None and int(status) not in (429, 500, 502,
                                                                                      503, 504)):
                    raise
                time.sleep(2 ** i)
        raise RuntimeError("unreachable")

    def profile_email(self) -> str:
        return self._run(self.svc.users().getProfile(userId="me")).get("emailAddress", "")

    def label_ids(self) -> dict[str, str]:
        resp = self._run(self.svc.users().labels().list(userId="me"))
        return {lbl["name"]: lbl["id"] for lbl in resp.get("labels", [])}

    def create_label(self, name: str) -> str:
        body = {"name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show"}
        return self._run(self.svc.users().labels().create(userId="me", body=body))["id"]

    def list_ids(self, label_id: str, max_results: int) -> list[str]:
        ids: list[str] = []
        token = None
        while len(ids) < max_results:
            resp = self._run(self.svc.users().messages().list(
                userId="me", labelIds=[label_id], pageToken=token,
                maxResults=min(100, max_results)))
            ids.extend(m["id"] for m in resp.get("messages", []))
            token = resp.get("nextPageToken")
            if not token:
                break
        return ids[:max_results]

    def get_message(self, message_id: str) -> dict[str, Any]:
        return self._run(self.svc.users().messages().get(userId="me", id=message_id,
                                                         format="full"))

    def get_attachment(self, message_id: str, attachment_id: str) -> bytes:
        resp = self._run(self.svc.users().messages().attachments().get(
            userId="me", messageId=message_id, id=attachment_id))
        return base64.urlsafe_b64decode(resp["data"])

    def add_label(self, message_id: str, label_id: str) -> None:
        self._run(self.svc.users().messages().modify(
            userId="me", id=message_id, body={"addLabelIds": [label_id]}))


# ------------------------------------------------------------------ helpers
def safe_name(text: str, max_len: int = 80) -> str:
    """Windows-safe file-name component (keeps Hebrew)."""
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", text or "")
    text = re.sub(r"\s+", " ", text).strip(" .")
    if text.upper().split(".")[0] in WINDOWS_RESERVED:
        text = "_" + text
    return text[:max_len].strip(" .") or "unknown"


# Windows MAX_PATH is 260 unless LongPathsEnabled; keep a margin for " (NN)" / ".part".
MAX_PATH = 240


def build_target_name(folder: Path, date: str, sender: str, stem: str, ext: str) -> str:
    """File name that keeps the full path under MAX_PATH (the save folder can be long)."""
    budget = MAX_PATH - len(str(folder)) - 1 - len(f"{date}__{ext}") - 10
    if budget < 12:
        raise OSError(f"SAVE_DIR path is too long for Windows ({len(str(folder))} chars)")
    sender_len = min(40, max(4, budget // 3))
    s = safe_name(sender, sender_len)
    st = safe_name(stem, max(4, budget - len(s)))
    return f"{date}_{s}_{st}{ext}"


def find_same_content(folder: Path, name: str, digest: str) -> Path | None:
    """An already-saved identical file (same base name, same bytes), if any."""
    base, ext = Path(name).stem, Path(name).suffix
    for p in folder.glob(f"{glob_escape(base)}*{ext}"):
        try:
            if p.is_file() and hashlib.sha256(p.read_bytes()).hexdigest() == digest:
                return p
        except OSError:
            continue
    return None


def glob_escape(text: str) -> str:
    return re.sub(r"([*?\[])", r"[\1]", text)


def unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    for i in range(2, 1000):
        candidate = path.with_name(f"{path.stem} ({i}){path.suffix}")
        if not candidate.exists():
            return candidate
    raise RuntimeError(f"Too many files named like {path.name}")


def is_invoice_file(filename: str) -> bool:
    ext = Path(filename).suffix.lower()
    if ext in DOC_EXT:
        return True
    return ext in IMAGE_EXT and bool(INVOICE_NAME_RE.search(filename))


def _walk(part: dict[str, Any]):
    yield part
    for p in part.get("parts", []) or []:
        yield from _walk(p)


def _b64(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def load_state() -> set[str]:
    try:
        return set(json.loads(STATE_FILE.read_text(encoding="utf-8")))
    except Exception:
        return set()


def save_state(ids: set[str]) -> None:
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(sorted(ids)), encoding="utf-8")
    tmp.replace(STATE_FILE)


# ------------------------------------------------------------------ core
class InvoiceSaver:
    def __init__(self, cfg: Config, gmail: GmailReader, state: set[str] | None = None) -> None:
        self.cfg = cfg
        self.gmail = gmail
        self.state = state if state is not None else load_state()
        self.tz = ZoneInfo(cfg.timezone)

    def check(self) -> list[str]:
        problems = []
        account = self.gmail.profile_email().lower()
        if account != self.cfg.gmail_account:
            problems.append(f"Logged in as {account}, expected {self.cfg.gmail_account}")
        labels = self.gmail.label_ids()
        if DETECTED_LABEL not in labels:
            problems.append(f"Gmail label {DETECTED_LABEL} not found - is the cloud service running?")
        try:
            self.cfg.save_dir.mkdir(parents=True, exist_ok=True)
            probe = self.cfg.save_dir / ".write_test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink()
        except Exception as exc:
            problems.append(f"Cannot write to {self.cfg.save_dir}: {type(exc).__name__}")
        return problems

    def run_once(self) -> dict[str, int]:
        stats = {"messages": 0, "files": 0, "skipped": 0, "errors": 0}
        if self.gmail.profile_email().lower() != self.cfg.gmail_account:
            raise SystemExit("Gmail account does not match GMAIL_ACCOUNT - refusing to run")
        labels = self.gmail.label_ids()
        saved_id = labels.get(SAVED_LABEL) or self.gmail.create_label(SAVED_LABEL)
        sources: list[tuple[str, str | None]] = [(DETECTED_LABEL, None)]
        if self.cfg.save_review:
            sources.append((REVIEW_LABEL, "לבדיקה"))
        for label_name, subfolder in sources:
            label_id = labels.get(label_name)
            if not label_id:
                log.info("Label %s not found yet - nothing to save", label_name)
                continue
            for mid in self.gmail.list_ids(label_id, self.cfg.max_messages_per_run):
                if mid in self.state:
                    stats["skipped"] += 1
                    continue
                try:
                    msg = self.gmail.get_message(mid)
                    if saved_id in (msg.get("labelIds") or []):
                        self.state.add(mid)
                        stats["skipped"] += 1
                        continue
                    stats["files"] += self._save_message(msg, subfolder)
                    self.state.add(mid)
                    save_state(self.state)  # before the label, so a label failure can't duplicate
                    self.gmail.add_label(mid, saved_id)
                    stats["messages"] += 1
                except Exception as exc:  # one bad email never stops the rest
                    stats["errors"] += 1
                    log.error("Could not save message %s: %s: %s", mid, type(exc).__name__,
                              str(exc)[:300])
        return stats

    def _save_message(self, msg: dict[str, Any], subfolder: str | None) -> int:
        payload = msg.get("payload", {}) or {}
        headers = {h["name"].lower(): h["value"] for h in payload.get("headers", [])}
        name, addr = parseaddr(headers.get("from", ""))
        sender = name or addr.split("@")[0] or "sender"
        ts = datetime.fromtimestamp(int(msg.get("internalDate", "0")) / 1000, tz=UTC)
        local = ts.astimezone(self.tz)
        folder = self.cfg.save_dir / local.strftime("%Y-%m")
        if subfolder:
            folder = folder / subfolder
        folder.mkdir(parents=True, exist_ok=True)

        written = 0
        seen: set[str] = set()
        for part in _walk(payload):
            filename = part.get("filename") or ""
            if not filename or not is_invoice_file(filename):
                continue
            body = part.get("body", {}) or {}
            if body.get("attachmentId"):
                data = self.gmail.get_attachment(msg["id"], body["attachmentId"])
            elif body.get("data"):
                data = _b64(body["data"])
            else:
                continue
            digest = hashlib.sha256(data).hexdigest()
            if digest in seen:
                continue
            seen.add(digest)
            stem, ext = Path(filename).stem, Path(filename).suffix.lower()
            fname = build_target_name(folder, f"{local:%Y-%m-%d}", sender, stem, ext)
            existing = find_same_content(folder, fname, digest)
            if existing is not None:  # saved by an earlier, interrupted run
                log.info("Already saved: %s", existing)
                written += 1
                continue
            target = unique_path(folder / fname)
            tmp = target.with_name(target.name + ".part")
            tmp.write_bytes(data)
            tmp.replace(target)
            log.info("Saved %s", target)
            written += 1
        return written


# ------------------------------------------------------------------ cli
def setup_logging(verbose: bool) -> None:
    handlers: list[logging.Handler] = [logging.FileHandler(LOG_FILE, encoding="utf-8")]
    if sys.stdout is not None:  # None under pythonw.exe (scheduled task)
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.INFO, handlers=handlers,
                        format="%(asctime)s %(levelname)s %(message)s")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Save detected invoices from Gmail to a folder")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--once", action="store_true")
    mode.add_argument("--loop", type=int, metavar="SECONDS")
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args(argv)
    setup_logging(args.verbose)

    try:
        return _run(args)
    except BaseException as exc:  # pythonw has no console: make sure every failure is logged
        if isinstance(exc, KeyboardInterrupt):
            return 130
        log.exception("Invoice Saver stopped: %s", exc)
        return 1


def _run(args) -> int:
    cfg = load_config(args.config)
    try:
        gmail = GoogleGmail(cfg)
    except Exception as exc:
        log.error("Gmail login failed: %s (check GMAIL_CLIENT_ID / SECRET / REFRESH_TOKEN)",
                  type(exc).__name__)
        return 2
    saver = InvoiceSaver(cfg, gmail)

    if args.check:
        problems = saver.check()
        for p in problems:
            log.error("CHECK: %s", p)
        if not problems:
            log.info("CHECK OK: Gmail %s, folder %s", cfg.gmail_account, cfg.save_dir)
        return 1 if problems else 0

    while True:
        stats = saver.run_once()
        log.info("Run finished: %s", stats)
        if not args.loop:
            return 0
        time.sleep(max(60, args.loop))


if __name__ == "__main__":
    sys.exit(main())
