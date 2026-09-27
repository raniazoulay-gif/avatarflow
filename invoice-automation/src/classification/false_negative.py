"""Second-opinion check: flag emails that look invoice-related even though the
main pipeline decided they are not invoices ("Possible Invoice")."""

from __future__ import annotations

from . import keywords as kw

_HINTS = kw.compile_all(kw.HINT_PATTERNS)
_SENDER = kw.compile_all(kw.HINT_SENDER_PATTERNS)


def possible_invoice(subject: str, sender_name: str, sender_email: str,
                     filenames: list[str], body: str = "") -> tuple[bool, str]:
    reasons: list[str] = []
    for label, value in (("subject", subject), ("filename", " ".join(filenames)),
                         ("body", (body or "")[:3000])):
        for p in _HINTS:
            m = p.search(value or "")
            if m:
                reasons.append(f"Invoice-related keyword detected in {label}: '{m.group(0)}'")
                break
    sender = f"{sender_name} {sender_email}"
    for p in _SENDER:
        m = p.search(sender)
        if m:
            reasons.append(f"Billing-like sender: '{m.group(0)}'")
            break
    # Body alone is weak (newsletters mention "receipt"); require a stronger field.
    strong = [r for r in reasons if "in body" not in r]
    if strong:
        return True, "; ".join(reasons)
    return False, ""
