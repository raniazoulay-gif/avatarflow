"""Deterministic rule engine: scores a document by counting invoice indicators."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import keywords as kw

_TITLE = kw.compile_all(kw.INVOICE_TITLE_PATTERNS)
_NUMBER = kw.compile_all(kw.INVOICE_NUMBER_PATTERNS)
_DATE_KW = kw.compile_all(kw.DATE_KEYWORDS)
_DATE_VAL = kw.compile_all(kw.DATE_VALUE_PATTERNS)
_AMOUNT_KW = kw.compile_all(kw.AMOUNT_KEYWORDS)
_AMOUNT_VAL = re.compile(kw.AMOUNT_VALUE, re.IGNORECASE)
_VAT = kw.compile_all(kw.VAT_PATTERNS)
_SUPPLIER = kw.compile_all(kw.SUPPLIER_PATTERNS)
_CURRENCY = {c: kw.compile_all(p) for c, p in kw.CURRENCY_PATTERNS.items()}
_NON_INVOICE = kw.compile_all(kw.NON_INVOICE_PATTERNS)
_STRONG = kw.compile_all(kw.STRONG_INVOICE_PATTERNS)

# Weights sum to 1.0
WEIGHTS = {
    "invoice_keyword": 0.25,
    "invoice_number": 0.20,
    "date": 0.10,
    "amount": 0.15,
    "vat": 0.15,
    "supplier": 0.15,
}


@dataclass
class RuleResult:
    score: float
    indicators: dict[str, bool]
    invoice_number: str | None = None
    invoice_date: str | None = None
    currency: str | None = None
    matched_keywords: list[str] = field(default_factory=list)
    # e.g. "אישור תשלום" - set only when the document never calls itself an invoice
    non_invoice_doc: str | None = None

    @property
    def reason(self) -> str:
        found = [k for k, v in self.indicators.items() if v]
        text = "Rules found: " + (", ".join(found) if found else "no invoice indicators")
        if self.non_invoice_doc:
            text = f"מסמך מסוג \"{self.non_invoice_doc}\" - לא חשבונית | {text}"
        return text


def _any(patterns: list[re.Pattern[str]], text: str) -> re.Match[str] | None:
    for p in patterns:
        m = p.search(text)
        if m:
            return m
    return None


def _amount_near_keyword(text: str) -> bool:
    for p in _AMOUNT_KW:
        for m in p.finditer(text):
            window = text[max(0, m.start() - 40): m.end() + 60]
            if re.search(r"\d", window) and _AMOUNT_VAL.search(window):
                return True
    return False


_HEBREW = re.compile(r"[\u0590-\u05FF]")
_RECEIPT = re.compile(r"(?<!ת)קבלה|\breceipt\b", re.IGNORECASE)


def evaluate(text: str) -> RuleResult:
    """Some Hebrew PDFs store each line in visual order (reversed), so the text is
    evaluated as extracted and with its Hebrew lines flipped - the better one counts."""
    text = text or ""
    best = _evaluate(text)
    if _HEBREW.search(text) and best.score < 1.0 and not best.non_invoice_doc:
        flipped = "\n".join(line[::-1] if _HEBREW.search(line) else line
                             for line in text.split("\n"))
        alt = _evaluate(flipped)
        if alt.non_invoice_doc:  # the look-alike gate wins in either reading
            return alt
        if alt.score > best.score:
            best = alt
    return best


def _evaluate(text: str) -> RuleResult:
    ind: dict[str, bool] = {}
    matched: list[str] = []

    m = _any(_TITLE, text)
    ind["invoice_keyword"] = bool(m)
    if m:
        matched.append(m.group(0))

    number = None
    for p in _NUMBER:
        nm = p.search(text)
        if nm and re.search(r"\d", nm.group(1)):
            number = nm.group(1).strip()
            break
    ind["invoice_number"] = number is not None

    date_val = _any(_DATE_VAL, text)
    ind["date"] = bool(date_val) and bool(_any(_DATE_KW, text) or date_val)

    ind["amount"] = _amount_near_keyword(text)
    # A receipt (קבלה) is not required to show VAT - it counts as complete here.
    ind["vat"] = bool(_any(_VAT, text)) or bool(m and _RECEIPT.search(text))
    ind["supplier"] = bool(_any(_SUPPLIER, text))

    currency = None
    for cur, pats in _CURRENCY.items():
        if _any(pats, text):
            currency = cur
            break

    score = round(sum(WEIGHTS[k] for k, v in ind.items() if v), 4)
    non_inv = _any(_NON_INVOICE, text)
    non_invoice_doc = non_inv.group(0).strip() if non_inv and not _any(_STRONG, text) else None
    if non_invoice_doc:
        score = min(score, 0.2)
    return RuleResult(
        non_invoice_doc=non_invoice_doc,
        score=min(1.0, score),
        indicators=ind,
        invoice_number=number,
        invoice_date=date_val.group(0) if date_val else None,
        currency=currency,
        matched_keywords=matched,
    )
