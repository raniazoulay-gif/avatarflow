"""SQLAlchemy models. SQLite by default; any SQLAlchemy URL (e.g. PostgreSQL)
works via DATABASE_URL. Only metadata is stored - no document text by default.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


class EmailStatus:
    PENDING = "PENDING"
    NO_ATTACHMENTS = "NO_ATTACHMENTS"
    NOT_INVOICE = "NOT_INVOICE"
    REVIEW = "REVIEW"
    NEW_SUPPLIER_REVIEW = "NEW_SUPPLIER_REVIEW"
    DRY_RUN_WOULD_FORWARD = "DRY_RUN_WOULD_FORWARD"
    FORWARD_BLOCKED = "FORWARD_BLOCKED"
    FORWARDED = "FORWARDED"
    ERROR = "ERROR"

    FINAL = {
        NO_ATTACHMENTS, NOT_INVOICE, REVIEW, NEW_SUPPLIER_REVIEW,
        DRY_RUN_WOULD_FORWARD, FORWARD_BLOCKED, FORWARDED,
    }


class Email(Base):
    __tablename__ = "emails"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    message_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    thread_id: Mapped[str | None] = mapped_column(String(128))
    sender_name: Mapped[str | None] = mapped_column(String(512))
    sender_email: Mapped[str | None] = mapped_column(String(512), index=True)
    subject: Mapped[str | None] = mapped_column(String(1024))
    received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    status: Mapped[str] = mapped_column(String(64), default=EmailStatus.PENDING, index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    is_backfill: Mapped[bool] = mapped_column(Boolean, default=False)
    dry_run: Mapped[bool] = mapped_column(Boolean, default=True)
    would_forward: Mapped[bool] = mapped_column(Boolean, default=False)
    possible_invoice: Mapped[bool] = mapped_column(Boolean, default=False)
    possible_invoice_reason: Mapped[str | None] = mapped_column(Text)
    rule_score: Mapped[float | None] = mapped_column(Float)
    ai_score: Mapped[float | None] = mapped_column(Float)
    final_score: Mapped[float | None] = mapped_column(Float)

    attachments: Mapped[list[Attachment]] = relationship(
        back_populates="email", cascade="all, delete-orphan"
    )
    classification: Mapped[Classification | None] = relationship(
        back_populates="email", cascade="all, delete-orphan", uselist=False
    )
    forward: Mapped[Forward | None] = relationship(
        back_populates="email", cascade="all, delete-orphan", uselist=False
    )


class Attachment(Base):
    __tablename__ = "attachments"
    __table_args__ = (UniqueConstraint("email_id", "attachment_key", name="uq_email_attachment"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email_id: Mapped[int] = mapped_column(ForeignKey("emails.id"), index=True)
    # Gmail attachment ids are not stable across API calls, so we key on
    # message part id + filename; sha256 gives content-level dedupe.
    attachment_key: Mapped[str] = mapped_column(String(512))
    attachment_id: Mapped[str | None] = mapped_column(Text)
    filename: Mapped[str | None] = mapped_column(String(1024))
    mime_type: Mapped[str | None] = mapped_column(String(256))
    sha256: Mapped[str | None] = mapped_column(String(64), index=True)
    size: Mapped[int | None] = mapped_column(Integer)
    processed: Mapped[bool] = mapped_column(Boolean, default=False)
    extraction_method: Mapped[str | None] = mapped_column(String(64))
    text_chars: Mapped[int | None] = mapped_column(Integer)
    is_invoice: Mapped[bool | None] = mapped_column(Boolean)
    final_score: Mapped[float | None] = mapped_column(Float)
    rule_score: Mapped[float | None] = mapped_column(Float)
    ai_score: Mapped[float | None] = mapped_column(Float)
    classification_json: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    document_text: Mapped[str | None] = mapped_column(Text)  # only if STORE_DOCUMENT_TEXT

    email: Mapped[Email] = relationship(back_populates="attachments")


class Classification(Base):
    __tablename__ = "classifications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email_id: Mapped[int] = mapped_column(ForeignKey("emails.id"), unique=True)
    is_invoice: Mapped[bool] = mapped_column(Boolean, default=False)
    confidence: Mapped[float | None] = mapped_column(Float)
    invoice_type: Mapped[str | None] = mapped_column(String(64))
    supplier: Mapped[str | None] = mapped_column(String(512))
    invoice_number: Mapped[str | None] = mapped_column(String(128))
    invoice_date: Mapped[str | None] = mapped_column(String(32))
    due_date: Mapped[str | None] = mapped_column(String(32))
    subtotal: Mapped[float | None] = mapped_column(Float)
    vat: Mapped[float | None] = mapped_column(Float)
    total: Mapped[float | None] = mapped_column(Float)
    currency: Mapped[str | None] = mapped_column(String(8))
    reason: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(String(32))  # ai+rules / rules_only
    best_attachment: Mapped[str | None] = mapped_column(String(1024))

    email: Mapped[Email] = relationship(back_populates="classification")


class Forward(Base):
    __tablename__ = "forwards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email_id: Mapped[int] = mapped_column(ForeignKey("emails.id"), unique=True)
    message_id: Mapped[str] = mapped_column(String(128), unique=True, index=True)
    state: Mapped[str] = mapped_column(String(16))  # SENDING / SENT / FAILED
    forwarded: Mapped[bool] = mapped_column(Boolean, default=False)
    forward_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    target_email: Mapped[str | None] = mapped_column(String(512))
    target_message_id: Mapped[str | None] = mapped_column(String(128))
    error: Mapped[str | None] = mapped_column(Text)

    email: Mapped[Email] = relationship(back_populates="forward")


class SystemState(Base):
    """Key/value store for monitoring counters and markers."""

    __tablename__ = "system_state"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
