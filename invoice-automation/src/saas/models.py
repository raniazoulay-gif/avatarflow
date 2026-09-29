"""Tenant tables. Every row that belongs to a customer carries org_id, and
every query in saas/queries.py filters on it - one business never sees
another business's data."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from ..database.models import Base, UTCDateTime, utcnow


class Role:
    MANAGER = "manager"
    EMPLOYEE = "employee"
    ALL = (MANAGER, EMPLOYEE)


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    accountant_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    forward_threshold: Mapped[float] = mapped_column(Float, default=0.90)
    # Set only by the platform admin (TotanRomi). Forwarding additionally needs
    # the three global safety switches in the environment - see engine.py.
    production_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_detections: Mapped[bool] = mapped_column(Boolean, default=False)
    save_review_to_drive: Mapped[bool] = mapped_column(Boolean, default=True)
    minutes_per_document: Mapped[float] = mapped_column(Float, default=3.0)
    # Optional: the customer's own Google OAuth client ("route 2"). Secret is encrypted.
    google_client_id: Mapped[str | None] = mapped_column(String(300), nullable=True)
    google_client_secret_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    # NULL org_id = platform admin (TotanRomi)
    org_id: Mapped[int | None] = mapped_column(ForeignKey("organizations.id"), index=True,
                                               nullable=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20))
    is_platform_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    password_hash: Mapped[str] = mapped_column(String(300))
    session_version: Mapped[int] = mapped_column(Integer, default=1)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # Set when a manager created the account with a temporary password.
    must_change_password: Mapped[bool | None] = mapped_column(Boolean, nullable=True,
                                                              default=False)
    # A temporary password stops working after this time (see TEMP_PASSWORD_HOURS).
    temp_password_expires_at: Mapped[datetime | None] = mapped_column(UTCDateTime(),
                                                                      nullable=True)


class Mailbox(Base):
    __tablename__ = "mailboxes"
    __table_args__ = (UniqueConstraint("email", name="uq_mailbox_email"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int] = mapped_column(ForeignKey("organizations.id"), index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), index=True, nullable=True)
    provider: Mapped[str] = mapped_column(String(20), default="gmail")
    email: Mapped[str] = mapped_column(String(320))
    # "shared" = TotanRomi's Google app, "org" = the customer's own Google app
    oauth_app: Mapped[str] = mapped_column(String(10), default="shared")
    refresh_token_enc: Mapped[str | None] = mapped_column(Text, nullable=True)
    scopes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")  # pending/active/error/paused
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_poll_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    monitor_start_epoch: Mapped[int | None] = mapped_column(Integer, nullable=True)
    drive_root_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class Invite(Base):
    """One-time links: kind='org' creates a new customer (manager signs up),
    kind='user' adds an employee/manager to an existing organisation.
    kind='verify' / 'reset': a 6-digit code emailed for open signup / password reset."""

    __tablename__ = "invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(10))
    org_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    role: Mapped[str | None] = mapped_column(String(20), nullable=True)
    note: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_by: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime())
    used_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    # kind='verify'/'reset': wrong-code attempts (the code is short, so it is capped)
    attempts: Mapped[int | None] = mapped_column(Integer, nullable=True, default=0)


class EmailView(Base):
    """Who opened which document (the "seen" eye in the inbox) - per user."""

    __tablename__ = "email_views"
    __table_args__ = (UniqueConstraint("email_id", "user_id", name="uq_email_view"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email_id: Mapped[int] = mapped_column(Integer, index=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    viewed_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)


class ManualSend(Base):
    """A document a person chose to send on ("העבר לגורם מטפל")."""

    __tablename__ = "manual_sends"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    org_id: Mapped[int] = mapped_column(Integer, index=True)
    email_id: Mapped[int] = mapped_column(Integer, index=True)
    user_id: Mapped[int] = mapped_column(Integer)
    to_email: Mapped[str] = mapped_column(String(320))
    to_label: Mapped[str | None] = mapped_column(String(100), nullable=True)
    from_email: Mapped[str] = mapped_column(String(320))
    sent_at: Mapped[datetime] = mapped_column(UTCDateTime(), default=utcnow)
