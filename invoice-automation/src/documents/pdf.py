"""PDF text extraction (text layer first, OCR fallback for scanned PDFs)."""

from __future__ import annotations

import io
import logging

log = logging.getLogger(__name__)


class PDFError(Exception):
    pass


def extract_pdf_text(data: bytes, max_pages: int = 20) -> str:
    """Extract the embedded text layer. Raises PDFError for broken files."""
    if not data.lstrip()[:5].startswith(b"%PDF"):
        raise PDFError("Not a valid PDF (missing %PDF header)")
    try:
        import pdfplumber

        parts: list[str] = []
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            for page in pdf.pages[:max_pages]:
                parts.append(page.extract_text() or "")
        return "\n".join(parts)
    except Exception as first_exc:
        # Fall back to pypdf, which is more tolerant of some malformed files.
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            return "\n".join((p.extract_text() or "") for p in reader.pages[:max_pages])
        except Exception as exc:
            raise PDFError(f"Broken/unreadable PDF: {type(first_exc).__name__}") from exc


def meaningful_chars(text: str) -> int:
    return sum(1 for ch in text if ch.isalnum())
