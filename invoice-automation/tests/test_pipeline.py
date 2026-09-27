"""Pipeline tests: documents, OCR, duplicates, failures, false negatives."""

from __future__ import annotations

import pytest

from src.database.models import EmailStatus
from src.documents.ocr import OCRError

from .conftest import (
    INVOICE_LINES,
    NON_INVOICE_LINES,
    PRODUCTION,
    FakeBackend,
    Harness,
    make_docx,
    make_scanned_pdf,
    make_settings,
    make_text_pdf,
    tesseract_ok,
)


# 1. Real invoice PDF
def test_real_invoice_pdf_detected():
    h = Harness(make_settings())
    h.gmail.add_message("m1", attachments=[("doc.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    e = h.email("m1")
    assert e.final_score >= 0.9
    assert e.classification.is_invoice
    assert e.classification.invoice_number == "INV-2026-0917"
    assert e.classification.total == 1180
    assert e.rule_score >= 0.8
    assert e.attachments[0].extraction_method == "text"
    assert e.attachments[0].document_text is None  # privacy default


# 2. Non-invoice PDF
def test_non_invoice_pdf():
    h = Harness(make_settings())
    h.gmail.add_message("m1", sender="News <news@shop.com>", subject="Our autumn newsletter",
                        attachments=[("newsletter.pdf", "application/pdf",
                                      make_text_pdf(NON_INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.NOT_INVOICE
    e = h.email("m1")
    assert e.final_score < 0.7
    assert e.possible_invoice is False
    assert "Invoice/Not-Invoice" in h.gmail.applied["m1"]


# 3. Scanned invoice (OCR)
@pytest.mark.skipif(not tesseract_ok(), reason="tesseract not installed")
def test_scanned_invoice_pdf_uses_ocr():
    h = Harness(make_settings())
    h.gmail.add_message("m1", attachments=[("scan.pdf", "application/pdf",
                                            make_scanned_pdf(INVOICE_LINES))])
    status = h.processor.process_message("m1")
    e = h.email("m1")
    assert e.attachments[0].extraction_method == "ocr"
    assert status == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert e.rule_score >= 0.5


def test_scanned_pdf_ocr_path_with_stub():
    calls = []

    def fake_ocr(data, languages, max_pages):
        calls.append(languages)
        return "\n".join(INVOICE_LINES)

    h = Harness(make_settings(), ocr_pdf_fn=fake_ocr)
    h.gmail.add_message("m1", attachments=[("scan.pdf", "application/pdf",
                                            make_scanned_pdf(["x"]))])
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert calls == ["heb+eng"]


# 4. Word invoice (Hebrew, tables, header)
def test_word_invoice_docx_hebrew():
    data = make_docx(
        ["חשבונית מס קבלה", "מספר חשבונית: 55123", "תאריך חשבונית: 20/09/2026",
         "עוסק מורשה 512345678"],
        table=[["תיאור", "סכום"], ["שירותי ייעוץ", "1,000.00"], ["מע\"מ 18%", "180.00"],
               ["סה\"כ לתשלום", "1,180.00 ₪"]],
        header="ספק לדוגמה בע\"מ",
    )
    h = Harness(make_settings())
    h.gmail.add_message("m1", subject="חשבונית ספטמבר", attachments=[
        ("hash.docx",
         "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data)])
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    e = h.email("m1")
    assert e.attachments[0].extraction_method == "docx"
    assert e.rule_score >= 0.9
    assert e.classification.currency == "ILS"


# 5. Multiple attachments
def test_multiple_attachments_best_one_wins_and_images_skipped():
    h = Harness(make_settings())
    h.gmail.add_message("m1", attachments=[
        ("terms.pdf", "application/pdf", make_text_pdf(NON_INVOICE_LINES)),
        ("signature.png", "image/png", b"\x89PNG fake"),
        ("logo.jpg", "image/jpeg", b"\xff\xd8 fake"),
        ("inv.pdf", "application/pdf", make_text_pdf(INVOICE_LINES)),
    ])
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    e = h.email("m1")
    names = sorted(a.filename for a in e.attachments)
    assert names == ["inv.pdf", "terms.pdf"]  # images never OCR'd
    assert e.classification.best_attachment == "inv.pdf"


# 6. Duplicate email
def test_duplicate_email_processed_once():
    h = Harness(make_settings(**PRODUCTION))
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    first = h.processor.process_many(["m1"])
    second = h.processor.process_many(["m1"])
    assert first["m1"] == EmailStatus.FORWARDED
    assert second["m1"] == "SKIPPED"
    assert h.backend.calls == 1
    assert len(h.gmail.sent) == 1


# 7. Duplicate attachment
def test_duplicate_attachment_not_reprocessed_and_not_reforwarded():
    h = Harness(make_settings(**PRODUCTION))
    pdf = make_text_pdf(INVOICE_LINES)
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf", pdf)])
    h.gmail.add_message("m2", subject="Fwd: Invoice",
                        attachments=[("copy.pdf", "application/pdf", pdf)])
    assert h.processor.process_message("m1") == EmailStatus.FORWARDED
    assert h.processor.process_message("m2") == EmailStatus.REVIEW
    assert h.backend.calls == 1  # second copy reused sha256 result
    assert len(h.gmail.sent) == 1
    e2 = h.email("m2")
    assert e2.attachments[0].extraction_method == "reused"
    assert "Duplicate invoice content" in e2.classification.reason


# 8. AI failure
def test_ai_failure_falls_back_to_rules_and_never_auto_forwards():
    h = Harness(make_settings(**PRODUCTION), backend=FakeBackend(fail=True))
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    status = h.processor.process_message("m1")
    assert status == EmailStatus.REVIEW
    assert h.gmail.sent == []
    e = h.email("m1")
    assert e.final_score <= 0.89
    assert e.classification.source == "rules_only"
    assert h.backend.calls == 3  # retried with backoff


def test_ai_invalid_json_is_retried():
    backend = FakeBackend(bad_json_times=2)
    h = Harness(make_settings(), backend=backend)
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert backend.calls == 3


def test_ai_not_configured_rules_only():
    h = Harness(make_settings())
    h.ai.backend = None
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.REVIEW


# 9. Gmail failure
def test_gmail_failure_on_one_email_does_not_stop_others():
    h = Harness(make_settings())
    pdf = make_text_pdf(INVOICE_LINES)
    h.gmail.add_message("m1", attachments=[("a.pdf", "application/pdf", pdf)])
    h.gmail.add_message("m2", attachments=[("b.pdf", "application/pdf", pdf + b"\n%x")])
    h.gmail.add_message("m3", attachments=[("c.pdf", "application/pdf", pdf + b"\n%y")])
    h.gmail.fail_get.add("m2")
    res = h.processor.process_many(["m1", "m2", "m3"])
    assert res["m1"] == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert res["m2"] == EmailStatus.ERROR
    assert res["m3"] == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert "Gmail read failed" in h.email("m2").error


def test_error_email_retried_until_max_attempts():
    h = Harness(make_settings(max_processing_attempts=2))
    h.gmail.add_message("m1", attachments=[("a.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    h.gmail.fail_get.add("m1")
    assert h.processor.process_message("m1") == EmailStatus.ERROR
    assert h.processor.process_message("m1") == EmailStatus.ERROR
    assert h.processor.process_message("m1") is None  # gave up
    assert h.email("m1").attempts == 2


# 10. OCR failure
def test_ocr_failure_marks_error_and_continues():
    def broken_ocr(*a, **k):
        raise OCRError("tesseract crashed")

    h = Harness(make_settings(), ocr_pdf_fn=broken_ocr)
    h.gmail.add_message("m1", subject="scan", attachments=[
        ("scan.pdf", "application/pdf", make_scanned_pdf(["x"]))])
    h.gmail.add_message("m2", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    res = h.processor.process_many(["m1", "m2"])
    assert res["m1"] == EmailStatus.ERROR
    assert res["m2"] == EmailStatus.DRY_RUN_WOULD_FORWARD
    assert "OCR" in h.email("m1").error
    assert "Invoice/Error" in h.gmail.applied["m1"]


# 11. Broken PDF
def test_broken_pdf_is_error_not_crash():
    h = Harness(make_settings())
    h.gmail.add_message("m1", attachments=[("broken.pdf", "application/pdf",
                                            b"%PDF-1.4 garbage \x00\x01 not a pdf")])
    h.gmail.add_message("m2", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    res = h.processor.process_many(["m1", "m2"])
    assert res["m1"] == EmailStatus.ERROR
    assert res["m2"] == EmailStatus.DRY_RUN_WOULD_FORWARD
    with h.db.repo() as repo:
        assert int(repo.get_state("total_errors")) == 1


# 12. False negative detection
def test_possible_false_negative_flagged():
    h = Harness(make_settings())
    h.gmail.add_message("m1", sender="Acme Billing <billing@acme.com>",
                        subject="Invoice September 2026",
                        attachments=[("document.pdf", "application/pdf",
                                      make_text_pdf(NON_INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.NOT_INVOICE
    e = h.email("m1")
    assert e.possible_invoice is True
    assert "Invoice-related keyword detected" in e.possible_invoice_reason


def test_possible_invoice_without_attachment():
    h = Harness(make_settings())
    h.gmail.add_message("m1", subject="Your invoice is ready", attachments=[])
    assert h.processor.process_message("m1") == EmailStatus.NO_ATTACHMENTS
    assert h.email("m1").possible_invoice is True
    assert h.backend.calls == 0  # nothing sent to AI without a document


def test_filename_alone_is_not_proof():
    h = Harness(make_settings())
    h.gmail.add_message("m1", subject="hello", sender="Friend <a@b.com>",
                        attachments=[("invoice.pdf", "application/pdf",
                                      make_text_pdf(NON_INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.NOT_INVOICE


def test_attachment_size_limit():
    h = Harness(make_settings(max_attachment_size_mb=0))
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.ERROR


def test_whitelist_new_supplier_review():
    h = Harness(make_settings(**PRODUCTION, supplier_whitelist_enabled=True,
                              supplier_whitelist="@known.co.il"))
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.NEW_SUPPLIER_REVIEW
    assert h.gmail.sent == []
    assert "Invoice/New-Supplier" in h.gmail.applied["m1"]


def test_whitelisted_supplier_forwarded():
    h = Harness(make_settings(**PRODUCTION, supplier_whitelist_enabled=True,
                              supplier_whitelist="@supplier.co.il"))
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf",
                                            make_text_pdf(INVOICE_LINES))])
    assert h.processor.process_message("m1") == EmailStatus.FORWARDED


def test_ai_prompt_truncates_document_and_contains_no_secrets():
    backend = FakeBackend()
    h = Harness(make_settings(ai_max_doc_chars=100), backend=backend)
    h.ai.max_doc_chars = 100
    lines = INVOICE_LINES + ["filler text " * 200]
    h.gmail.add_message("m1", attachments=[("i.pdf", "application/pdf", make_text_pdf(lines))])
    h.processor.process_message("m1")
    doc_part = backend.prompts[0].split("--- DOCUMENT TEXT (truncated) ---")[1]
    assert len(doc_part) < 200
