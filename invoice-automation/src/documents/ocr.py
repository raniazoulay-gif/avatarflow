"""OCR via Tesseract (Hebrew + English). Requires the `tesseract` binary with
`heb` and `eng` traineddata, plus poppler (`pdftoppm`) for PDF rendering.
"""

from __future__ import annotations

import logging
import shutil

log = logging.getLogger(__name__)


class OCRError(Exception):
    pass


def ocr_available() -> bool:
    return shutil.which("tesseract") is not None and shutil.which("pdftoppm") is not None


def ocr_pdf(data: bytes, languages: str = "heb+eng", max_pages: int = 5, dpi: int = 300) -> str:
    """Render PDF pages to images and OCR them. Raises OCRError on failure."""
    if not ocr_available():
        raise OCRError("OCR NOT CONFIGURED: tesseract/pdftoppm not installed")
    try:
        import pytesseract
        from pdf2image import convert_from_bytes

        images = convert_from_bytes(data, dpi=dpi, first_page=1, last_page=max_pages)
        texts = [pytesseract.image_to_string(img, lang=languages) for img in images]
        return "\n".join(texts)
    except OCRError:
        raise
    except Exception as exc:
        raise OCRError(f"OCR failed: {type(exc).__name__}: {exc}") from exc


def ocr_image(data: bytes, languages: str = "heb+eng") -> str:
    if shutil.which("tesseract") is None:
        raise OCRError("OCR NOT CONFIGURED: tesseract not installed")
    try:
        import io

        import pytesseract
        from PIL import Image

        return pytesseract.image_to_string(Image.open(io.BytesIO(data)), lang=languages)
    except Exception as exc:
        raise OCRError(f"OCR failed: {type(exc).__name__}: {exc}") from exc
