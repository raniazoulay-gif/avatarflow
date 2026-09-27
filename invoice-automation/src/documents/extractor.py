"""Attachment type detection and text extraction dispatch."""

from __future__ import annotations

import logging
import os
import re
from collections.abc import Callable
from dataclasses import dataclass

from ..utils.retry import retry_call
from .ocr import OCRError, ocr_image, ocr_pdf
from .pdf import PDFError, extract_pdf_text, meaningful_chars
from .word import WordError, extract_doc_text, extract_docx_text

log = logging.getLogger(__name__)

DOC_MIME = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
}
EXT_TYPES = {".pdf": "pdf", ".doc": "doc", ".docx": "docx"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".tif", ".tiff", ".bmp", ".webp"}
# An image attachment is only OCR'd if its name looks invoice-related;
# signature.png / logo.jpg / tracking.gif are skipped.
INVOICE_NAME_RE = re.compile(
    r"(invoice|inv[_\-\s]?\d|receipt|bill|tax|חשבונית|קבלה|חשבון)", re.IGNORECASE
)


class ExtractionError(Exception):
    pass


@dataclass
class Extraction:
    text: str
    method: str  # text | ocr | docx | doc | image_ocr
    file_type: str


def detect_file_type(filename: str, mime_type: str | None, head: bytes = b"") -> str | None:
    """Return 'pdf' | 'doc' | 'docx' | 'image' | None (irrelevant)."""
    ext = os.path.splitext(filename or "")[1].lower()
    if head.startswith(b"%PDF"):
        return "pdf"
    if ext in EXT_TYPES:
        return EXT_TYPES[ext]
    if mime_type and mime_type.lower() in DOC_MIME:
        return DOC_MIME[mime_type.lower()]
    if ext in IMAGE_EXT or (mime_type or "").startswith("image/"):
        return "image"
    return None


def is_relevant(filename: str, mime_type: str | None) -> bool:
    ftype = detect_file_type(filename, mime_type)
    if ftype in ("pdf", "doc", "docx"):
        return True
    if ftype == "image":
        return bool(INVOICE_NAME_RE.search(filename or ""))
    return False


class DocumentExtractor:
    def __init__(
        self,
        *,
        min_text_chars: int = 50,
        ocr_languages: str = "heb+eng",
        ocr_max_pages: int = 5,
        retry_attempts: int = 3,
        retry_base_delay: float = 1.0,
        ocr_pdf_fn: Callable[..., str] = ocr_pdf,
        ocr_image_fn: Callable[..., str] = ocr_image,
    ) -> None:
        self.min_text_chars = min_text_chars
        self.ocr_languages = ocr_languages
        self.ocr_max_pages = ocr_max_pages
        self.retry_attempts = retry_attempts
        self.retry_base_delay = retry_base_delay
        self._ocr_pdf = ocr_pdf_fn
        self._ocr_image = ocr_image_fn

    def _ocr(self, fn: Callable[[], str]) -> str:
        return retry_call(
            fn, max_attempts=self.retry_attempts, base_delay=self.retry_base_delay,
            retry_on=(OCRError,), what="OCR",
        )

    def extract(self, data: bytes, filename: str, mime_type: str | None) -> Extraction:
        ftype = detect_file_type(filename, mime_type, data[:8])
        try:
            if ftype == "pdf":
                text = extract_pdf_text(data)
                if meaningful_chars(text) >= self.min_text_chars:
                    return Extraction(text, "text", "pdf")
                log.info("PDF has little/no text layer -> OCR (%s)", filename)
                ocr_text = self._ocr(
                    lambda: self._ocr_pdf(data, languages=self.ocr_languages,
                                          max_pages=self.ocr_max_pages)
                )
                return Extraction((text + "\n" + ocr_text).strip(), "ocr", "pdf")
            if ftype == "docx":
                return Extraction(extract_docx_text(data), "docx", "docx")
            if ftype == "doc":
                return Extraction(extract_doc_text(data), "doc", "doc")
            if ftype == "image":
                text = self._ocr(lambda: self._ocr_image(data, languages=self.ocr_languages))
                return Extraction(text, "image_ocr", "image")
        except OCRError as exc:
            msg = str(exc)
            raise ExtractionError(msg if msg.startswith("OCR") else f"OCR failed: {msg}") from exc
        except (PDFError, WordError) as exc:
            raise ExtractionError(str(exc)) from exc
        raise ExtractionError(f"Unsupported attachment type: {filename}")
