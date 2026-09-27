"""Combines AI + rule scores and decides what should happen to an email.

The decision engine only *decides*. It never sends anything. Actual sending is
done exclusively by gmail.forwarder.Forwarder, which re-checks every safety
switch itself.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config.settings import Settings
from ..database.models import EmailStatus
from .ai_classifier import AIClassification
from .rule_engine import RuleResult

HIGH = "HIGH"
MEDIUM = "MEDIUM"
LOW = "LOW"

# Without an AI opinion a document can reach REVIEW at most - never auto-forward.
RULES_ONLY_CAP = 0.89


def ai_invoice_probability(ai: AIClassification) -> float:
    """Map (is_invoice, confidence) to P(invoice)."""
    return ai.confidence if ai.is_invoice else 1.0 - ai.confidence


def final_confidence(ai: AIClassification | None, rules: RuleResult, settings: Settings) -> float:
    if ai is None:
        return round(min(rules.score, RULES_ONLY_CAP), 4)
    wa, wr = settings.ai_weight, settings.rule_weight
    total = (wa + wr) or 1.0
    return round((wa * ai_invoice_probability(ai) + wr * rules.score) / total, 4)


def band(score: float, settings: Settings) -> str:
    if score >= settings.invoice_auto_forward_threshold:
        return HIGH
    if score >= settings.review_threshold:
        return MEDIUM
    return LOW


def supplier_whitelisted(sender_email: str, settings: Settings) -> bool:
    s = (sender_email or "").lower()
    domain = s.split("@")[-1] if "@" in s else ""
    for entry in settings.whitelist_entries:
        if entry.startswith("@") and domain == entry[1:]:
            return True
        if entry == s or entry == domain:
            return True
    return False


@dataclass
class Decision:
    status: str
    band: str
    would_forward: bool  # what production mode WOULD do
    labels: list[str]
    reason: str


def decide(score: float, sender_email: str, settings: Settings, *, is_backfill: bool = False,
           is_invoice: bool = True) -> Decision:
    b = band(score, settings)
    dry = not settings.forward_switches_on

    if b == HIGH and is_invoice:
        if settings.supplier_whitelist_enabled and not supplier_whitelisted(sender_email, settings):
            return Decision(EmailStatus.NEW_SUPPLIER_REVIEW, b, False,
                            ["Invoice/Detected", "Invoice/New-Supplier", "Invoice/Review"]
                            + (["Invoice/DRY-RUN"] if dry else []),
                            "High confidence but supplier not in whitelist")
        if dry:
            return Decision(EmailStatus.DRY_RUN_WOULD_FORWARD, b, True,
                            ["Invoice/Detected", "Invoice/DRY-RUN"],
                            "High confidence - DRY RUN, not forwarded")
        if is_backfill and not settings.backfill_forward_enabled:
            return Decision(EmailStatus.FORWARD_BLOCKED, b, True,
                            ["Invoice/Detected"], "Backfill email - BACKFILL_FORWARD_ENABLED=false")
        # Production: the forwarder performs the send (and re-checks all switches).
        return Decision(EmailStatus.FORWARDED, b, True, ["Invoice/Detected"],
                        "High confidence - eligible for forward")
    if b in (HIGH, MEDIUM):
        return Decision(EmailStatus.REVIEW, MEDIUM, False,
                        ["Invoice/Review"] + (["Invoice/DRY-RUN"] if dry else []),
                        "Medium confidence - manual review required")
    return Decision(EmailStatus.NOT_INVOICE, LOW, False, ["Invoice/Not-Invoice"],
                    "Low confidence - not an invoice")
