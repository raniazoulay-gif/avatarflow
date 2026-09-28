"""Saves detected invoices into the mailbox owner's own Google Drive:

  TotanRomi Invoices / 2026-09 / 2026-09-28_<supplier>_<file>.pdf
  TotanRomi Invoices / לבדיקה / ...                     (review items, optional)

With the drive.file scope the app only ever sees the folders and files it
created itself - never the rest of the customer's Drive.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime

from ..utils.retry import retry_call

log = logging.getLogger(__name__)

ROOT_NAME = "TotanRomi Invoices"
REVIEW_FOLDER = "לבדיקה"
FOLDER_MIME = "application/vnd.google-apps.folder"


def safe_name(s: str, limit: int = 80) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n\t]+', " ", s or "").strip()
    return re.sub(r"\s+", " ", s)[:limit] or "file"


class DriveSaver:
    def __init__(self, service, root_id: str | None = None, on_root=None) -> None:
        self.svc = service
        self.root_id = root_id
        self.on_root = on_root  # callback to persist a newly created root folder id
        self._folders: dict[str, str] = {}

    def _call(self, what: str, fn, attempts: int = 3):
        return retry_call(lambda: fn().execute(num_retries=0), max_attempts=attempts,
                          base_delay=1.0, what=f"Drive {what}")

    def _find_folder(self, name: str, parent: str | None) -> str | None:
        q = f"mimeType='{FOLDER_MIME}' and trashed=false and name='{name.replace(chr(39), '')}'"
        if parent:
            q += f" and '{parent}' in parents"
        res = self._call("files.list", lambda: self.svc.files().list(
            q=q, spaces="drive", fields="files(id)", pageSize=1))
        files = res.get("files", [])
        return files[0]["id"] if files else None

    def _folder(self, name: str, parent: str | None) -> str:
        key = f"{parent}/{name}"
        if key in self._folders:
            return self._folders[key]
        fid = self._find_folder(name, parent)
        if fid is None:
            body: dict = {"name": name, "mimeType": FOLDER_MIME}
            if parent:
                body["parents"] = [parent]
            fid = self._call("files.create", lambda: self.svc.files().create(
                body=body, fields="id"))["id"]
        self._folders[key] = fid
        return fid

    def root(self) -> str:
        if not self.root_id:
            self.root_id = self._folder(ROOT_NAME, None)
            if self.on_root:
                self.on_root(self.root_id)
        return self.root_id

    def save(self, data: bytes, filename: str, mime_type: str, *, received: datetime | None,
             supplier: str, review: bool) -> str:
        from googleapiclient.http import MediaInMemoryUpload

        when = received or datetime.now()
        folder = self._folder(REVIEW_FOLDER if review else when.strftime("%Y-%m"), self.root())
        name = f"{when.strftime('%Y-%m-%d')}_{safe_name(supplier, 40)}_{safe_name(filename)}"
        media = MediaInMemoryUpload(data, mimetype=mime_type or "application/octet-stream",
                                    resumable=False)
        created = self._call("files.create(upload)", lambda: self.svc.files().create(
            body={"name": name, "parents": [folder]}, media_body=media, fields="id"),
            attempts=1)  # an upload is not idempotent - never retry blindly
        return created["id"]


def drive_link(file_id: str) -> str:
    return f"https://drive.google.com/file/d/{file_id}/view"
