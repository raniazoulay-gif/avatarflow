"""Invoice keyword lists (Hebrew + English, with common variants)."""

from __future__ import annotations

import re

# Hebrew uses both ASCII quote (") and gershayim (״) - also OCR often drops it.
Q = r"[\"'״׳]?"

INVOICE_TITLE_PATTERNS = [
    r"חשבונית\s*מס\s*[/\\-]?\s*קבלה",
    r"חשבונית\s*מס",
    r"חשבונית\s*עסקה",
    r"חשבונית\s*זיכוי",
    r"חשבונית",
    r"קבלה",
    r"tax\s+invoice",
    r"invoice",
    r"receipt",
    r"credit\s+note",
    r"bill\b",
    r"facture",
]

INVOICE_NUMBER_PATTERNS = [
    r"(?:מספר|מס" + Q + r"|מס\.)\s*חשבונית\s*[:#]?\s*([A-Za-z0-9\-/]{2,})",
    r"חשבונית\s*(?:מס\s*)?(?:קבלה\s*)?(?:מס" + Q + r"|מספר|מס\.)?\s*[:#]\s*([A-Za-z0-9\-/]{2,})",
    r"חשבונית\s*(?:מס\s*)?(?:קבלה\s*)?(?:מס" + Q + r"|מספר|מס\.)\s*([0-9][A-Za-z0-9\-/]+)",
    r"invoice\s*(?:no\.?|number|num\.?|#|id)\s*[:#]?\s*([A-Za-z0-9\-/]{2,})",
    r"inv\s*(?:no\.?|#)\s*[:#]?\s*([A-Za-z0-9\-/]{2,})",
    r"receipt\s*(?:no\.?|number|#)\s*[:#]?\s*([A-Za-z0-9\-/]{2,})",
    r"(?:invoice|חשבונית)\s*#\s*([A-Za-z0-9\-/]{2,})",
]

DATE_KEYWORDS = [r"invoice\s+date", r"due\s+date", r"date\s+of\s+issue", r"issue\s+date",
                 r"תאריך\s*חשבונית", r"תאריך\s*הפקה", r"תאריך\s*ערך", r"תאריך", r"date"]
DATE_VALUE_PATTERNS = [
    r"\b\d{1,2}[./\-]\d{1,2}[./\-]\d{2,4}\b",
    r"\b\d{4}[./\-]\d{1,2}[./\-]\d{1,2}\b",
    r"\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}\b",
    r"\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b",
]

AMOUNT_KEYWORDS = [
    r"סה" + Q + r"כ(?:\s*לתשלום)?", r"לתשלום", r"סכום(?:\s*כולל)?", r"total(?:\s+amount)?",
    r"amount\s+due", r"balance\s+due", r"grand\s+total", r"subtotal", r"sub-total",
    r"total\s+due", r"amount\s+payable",
]
AMOUNT_VALUE = r"(?:₪|\$|€|£|ILS|NIS|USD|EUR|ש" + Q + r"ח)?\s*-?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?"

VAT_PATTERNS = [r"מע" + Q + r"מ", r"\bvat\b", r"value\s+added\s+tax", r"\bgst\b", r"\btax\b"]

SUPPLIER_PATTERNS = [
    r"עוסק\s*מורשה", r"עוסק\s*פטור", r"ע\.?\s*מ\.?\s*[:\-]?\s*\d{8,9}",
    r"ח\.?\s*פ\.?\s*[:\-]?\s*\d{8,9}", r"ח\.פ\.", r"ע\.מ\.", r"ת\.?ז\.?\s*\d{9}",
    r"bill\s+to", r"billed\s+to", r"supplier", r"vendor", r"sold\s+by",
    r"vat\s*(?:reg(?:istration)?\.?)?\s*(?:no\.?|number|id)", r"company\s+(?:no|number|reg)",
    r"tax\s+id", r"\bein\b",
]

CURRENCY_PATTERNS = {
    "ILS": [r"₪", r"\bILS\b", r"\bNIS\b", r"ש" + Q + r"ח", r"שקל"],
    "USD": [r"\$", r"\bUSD\b"],
    "EUR": [r"€", r"\bEUR\b"],
    "GBP": [r"£", r"\bGBP\b"],
}

# Lighter signals used for the "possible invoice" false-negative check on
# subject / filename / sender.
HINT_PATTERNS = [
    r"חשבונית", r"קבלה", r"חשבון\s*(?:חודשי|תקופתי)", r"לתשלום", r"מע" + Q + r"מ",
    r"invoice", r"inv[_\-\s]?\d", r"receipt", r"\bbill(?:ing)?\b", r"statement",
    r"payment\s+due", r"amount\s+due", r"tax\s+invoice", r"\bvat\b",
]
HINT_SENDER_PATTERNS = [r"billing", r"invoice", r"accounts?", r"finance", r"receipts?",
                        r"no-?reply.*(?:billing|invoice)", r"payments?", r"הנהלת\s*חשבונות"]


def compile_all(patterns: list[str]) -> list[re.Pattern[str]]:
    return [re.compile(p, re.IGNORECASE) for p in patterns]
