"""AI invoice classification (Anthropic Claude API) with strict JSON validation.

Data sent to the AI provider (documented in README): sender name/email,
subject, the first ~2000 chars of the email body, attachment filename and the
first AI_MAX_DOC_CHARS characters of the extracted/OCR text of that attachment.
Nothing is sent for emails without a relevant (PDF/DOC/DOCX) attachment.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field, ValidationError, field_validator

from ..utils.retry import NonRetryableError, retry_call

log = logging.getLogger(__name__)

InvoiceType = Literal[
    "tax_invoice", "tax_invoice_receipt", "receipt", "invoice", "credit_note",
    "proforma", "quote", "statement", "other", "none",
]


class AIClassification(BaseModel):
    is_invoice: bool
    confidence: float = Field(ge=0.0, le=1.0)
    invoice_type: str | None = None
    supplier_name: str | None = None
    invoice_number: str | None = None
    invoice_date: str | None = None
    due_date: str | None = None
    currency: str | None = None
    subtotal: float | None = None
    vat: float | None = None
    total: float | None = None
    reason: str = ""

    @field_validator("subtotal", "vat", "total", mode="before")
    @classmethod
    def _num(cls, v: Any) -> Any:
        if isinstance(v, str):
            cleaned = re.sub(r"[^\d.\-]", "", v.replace(",", ""))
            return float(cleaned) if cleaned not in ("", "-", ".") else None
        return v

    @field_validator("invoice_number", "invoice_date", "due_date", "supplier_name",
                     "currency", "invoice_type", mode="before")
    @classmethod
    def _str(cls, v: Any) -> Any:
        if v is None:
            return None
        return str(v).strip() or None


class AIError(Exception):
    pass


class InvalidAIResponse(AIError):
    pass


@dataclass
class ClassificationInput:
    sender_name: str
    sender_email: str
    subject: str
    body: str
    filename: str
    document_text: str
    extraction_method: str


class LLMBackend(Protocol):
    def complete(self, system: str, user: str) -> str: ...


SYSTEM_PROMPT = """You are an accounts-payable document classifier for an Israeli business.
Decide whether the attached document is a supplier INVOICE or RECEIPT that should be
sent to bookkeeping (חשבונית, חשבונית מס, חשבונית מס קבלה, קבלה, tax invoice, receipt).
Quotes, price offers, order confirmations, marketing, newsletters, contracts, delivery
notes and payment reminders without an invoice document are NOT invoices.
Also NOT invoices, even with an amount, a date and company details: payment confirmations
(אישור תשלום), insurance policies / premium confirmations (פוליסה, פרמיה, אישור ביטוח),
bank / credit-card / account statements (דף חשבון), pay slips (תלוש שכר), tax-withholding
certificates (אישור ניכוי מס), booking confirmations, e-tickets and boarding passes.
A document is an invoice only when it is issued by a supplier AS an invoice or receipt
(it calls itself חשבונית / קבלה / invoice / receipt and has an invoice/receipt number).
For these non-invoice documents answer is_invoice=false with invoice_type "none".

Respond with a single JSON object and NOTHING else, using exactly these keys:
{"is_invoice": bool, "confidence": number 0..1, "invoice_type": one of
"tax_invoice"|"tax_invoice_receipt"|"receipt"|"invoice"|"credit_note"|"proforma"|"quote"|
"statement"|"other"|"none", "supplier_name": string|null, "invoice_number": string|null,
"invoice_date": "YYYY-MM-DD"|null, "due_date": "YYYY-MM-DD"|null, "currency": ISO code|null,
"subtotal": number|null, "vat": number|null, "total": number|null, "reason": short string}
"confidence" is your confidence in the is_invoice decision."""


def build_user_prompt(inp: ClassificationInput, max_doc_chars: int) -> str:
    body = (inp.body or "")[:2000]
    doc = (inp.document_text or "")[:max_doc_chars]
    return (
        f"Sender: {inp.sender_name}\nSender email: {inp.sender_email}\n"
        f"Subject: {inp.subject}\nAttachment filename: {inp.filename}\n"
        f"Text extraction method: {inp.extraction_method}\n\n"
        f"--- EMAIL BODY (truncated) ---\n{body}\n\n"
        f"--- DOCUMENT TEXT (truncated) ---\n{doc}\n\nReturn JSON only."
    )


def parse_response(raw: str) -> AIClassification:
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise InvalidAIResponse("AI response contains no JSON object")
    try:
        data = json.loads(text[start: end + 1])
    except json.JSONDecodeError as exc:
        raise InvalidAIResponse(f"AI returned invalid JSON: {exc.msg}") from exc
    try:
        return AIClassification.model_validate(data)
    except ValidationError as exc:
        raise InvalidAIResponse(f"AI JSON failed validation: {exc.error_count()} errors") from exc


class AnthropicBackend:
    def __init__(self, api_key: str, model: str, timeout: float = 60.0) -> None:
        import anthropic

        self._anthropic = anthropic
        self.client = anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=0)
        self.model = model

    def complete(self, system: str, user: str) -> str:
        try:
            resp = self.client.messages.create(
                model=self.model,
                max_tokens=800,
                system=system,
                messages=[{"role": "user", "content": user}],
            )
        except (self._anthropic.AuthenticationError, self._anthropic.PermissionDeniedError,
                self._anthropic.NotFoundError, self._anthropic.BadRequestError) as exc:
            raise NonRetryableError(f"AI request rejected: {type(exc).__name__}") from exc
        return "".join(getattr(b, "text", "") for b in resp.content)

    def verify(self) -> bool:
        """Cheap authenticated call used by the system check."""
        self.client.models.list(limit=1)
        return True


class AIClassifier:
    def __init__(self, backend: LLMBackend | None, *, max_doc_chars: int = 8000,
                 max_attempts: int = 5, base_delay: float = 1.0) -> None:
        self.backend = backend
        self.max_doc_chars = max_doc_chars
        self.max_attempts = max_attempts
        self.base_delay = base_delay

    @property
    def available(self) -> bool:
        return self.backend is not None

    def classify(self, inp: ClassificationInput) -> AIClassification:
        if self.backend is None:
            raise AIError("AI NOT CONFIGURED")
        backend = self.backend
        user = build_user_prompt(inp, self.max_doc_chars)

        def once() -> AIClassification:
            return parse_response(backend.complete(SYSTEM_PROMPT, user))

        try:
            # Retries cover both transport errors and invalid/malformed JSON.
            return retry_call(once, max_attempts=self.max_attempts, base_delay=self.base_delay,
                              what="AI classification")
        except NonRetryableError as exc:
            raise AIError(str(exc)) from exc
        except InvalidAIResponse:
            raise
        except Exception as exc:
            raise AIError(f"AI classification failed: {type(exc).__name__}") from exc


def build_ai_classifier(settings) -> AIClassifier:
    backend: LLMBackend | None = None
    if settings.ai_configured:
        backend = AnthropicBackend(settings.ai_api_key, settings.ai_model)
    return AIClassifier(backend, max_doc_chars=settings.ai_max_doc_chars,
                        max_attempts=settings.retry_max_attempts,
                        base_delay=settings.retry_base_delay_seconds)
