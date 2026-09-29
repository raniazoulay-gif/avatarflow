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
    r"[חע]" + Q + r"[פמ]\s*[:\-]?\s*\d{8,9}",  # ח"פ / ע"מ with gershayim
    r"מספר\s*(?:חברה|עוסק|תאגיד)\s*[:\-]?\s*\d{8,9}", r"עוסקים\s*(?:מס" + Q + r")?\s*\d{8,9}",
    r"בע[\"'״׳]מ(?![\u0590-\u05FF])",  # בע"מ - the quote is required (not "בעמוד")
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

# Documents that look like an invoice (date, amount, company details) but are not
# one. When one of these appears and the document never calls itself an invoice /
# receipt, it is NOT an invoice - whatever the other indicators say.
NON_INVOICE_PATTERNS = [
    r"אישור\s*(?:על\s*)?(?:ביצוע\s*)?תשלום", r"פרמי(?:ה|ית|ת)", r"פוליס(?:ה|ת)",
    r"אישור\s*(?:קיום\s*)?ביטוח", r"הצעת\s*מחיר", r"תעודת\s*משלוח", r"דף\s*חשבון",
    r"תדפיס\s*(?:חשבון|תנועות)", r"תלוש\s*(?:שכר|משכורת)", r"אישור\s*ניכוי",
    r"אישור\s*הזמנה", r"כרטיס\s*(?:טיסה|עלייה|עליה)", r"דרישת\s*תשלום",
    r"payment\s+confirmation", r"proof\s+of\s+payment", r"price\s+quot", r"\bquotation\b",
    r"delivery\s+note", r"packing\s+slip", r"(?:bank|account)\s+statement",
    r"statement\s+of\s+account", r"pay\s*slip", r"order\s+confirmation",
    r"booking\s+confirmation", r"boarding\s+pass", r"\be-?ticket\b",
    r"insurance\s+(?:policy|certificate)", r"certificate\s+of\s+insurance", r"pro-?\s*forma",
]
# The document names itself an invoice / receipt (stronger than a passing mention).
STRONG_INVOICE_PATTERNS = [
    r"חשבוני(?:ת|ות)", r"(?<!ת)קבל(?:ה|ות)", r"invoice", r"receipt", r"credit\s+note",
    r"számla", r"factur", r"fattura", r"faktura", r"rechnung", r"\bbill\b",
]

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
