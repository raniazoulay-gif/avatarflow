"""Database access layer."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime

from sqlalchemy import create_engine, select, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload, sessionmaker

from .models import (
    Attachment,
    Base,
    Classification,
    Email,
    EmailStatus,
    Forward,
    SystemState,
    utcnow,
)


def normalize_database_url(url: str) -> str:
    """Pin the PostgreSQL driver to psycopg2 (what requirements.txt installs).

    Hosting providers such as Railway hand out plain postgresql:// or legacy
    postgres:// URLs; SQLAlchemy 2.1 maps those to psycopg (v3) by default.
    """
    for prefix in ("postgresql://", "postgres://"):
        if url.startswith(prefix):
            return "postgresql+psycopg2://" + url[len(prefix):]
    return url


class Database:
    def __init__(self, url: str) -> None:
        url = normalize_database_url(url)
        if url.startswith("sqlite:///") and not url.startswith("sqlite:///:memory:"):
            path = url.replace("sqlite:///", "", 1)
            d = os.path.dirname(path)
            if d:
                os.makedirs(d, exist_ok=True)
        kwargs: dict = {"future": True}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
            if ":memory:" in url:
                from sqlalchemy.pool import StaticPool

                kwargs["poolclass"] = StaticPool
        else:
            # Drop connections the server closed while idle.
            kwargs["pool_pre_ping"] = True
        self.engine: Engine = create_engine(url, **kwargs)
        self._sessionmaker = sessionmaker(bind=self.engine, expire_on_commit=False)

    def create_all(self) -> None:
        Base.metadata.create_all(self.engine)

    def ping(self) -> bool:
        with self.engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True

    @contextmanager
    def repo(self) -> Iterator[Repository]:
        session = self._sessionmaker()
        try:
            yield Repository(session)
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()


class Repository:
    def __init__(self, session: Session) -> None:
        self.s = session

    # ---------------- emails ----------------
    def get_email(self, message_id: str) -> Email | None:
        return self.s.scalar(select(Email).where(Email.message_id == message_id))

    def needs_processing(self, message_id: str, max_attempts: int) -> bool:
        e = self.get_email(message_id)
        if e is None:
            return True
        if e.status in EmailStatus.FINAL:
            return False
        return e.attempts < max_attempts

    def upsert_email(self, **fields) -> Email:
        e = self.get_email(fields["message_id"])
        if e is None:
            e = Email(**fields)
            self.s.add(e)
        else:
            for k, v in fields.items():
                setattr(e, k, v)
        self.s.flush()
        return e

    def commit(self) -> None:
        self.s.commit()

    # ---------------- attachments ----------------
    def get_attachment(self, email: Email, key: str) -> Attachment | None:
        return self.s.scalar(
            select(Attachment).where(Attachment.email_id == email.id, Attachment.attachment_key == key)
        )

    def find_processed_by_sha(self, sha256: str) -> Attachment | None:
        return self.s.scalar(
            select(Attachment)
            .where(Attachment.sha256 == sha256, Attachment.processed.is_(True),
                   Attachment.error.is_(None), Attachment.classification_json.is_not(None))
            .order_by(Attachment.id)
            .limit(1)
        )

    def find_forwarded_duplicate(self, shas: list[str], exclude_email_id: int) -> str | None:
        """message_id of another email carrying one of these files that was (or
        would have been) forwarded - independent of any cached classification."""
        if not shas:
            return None
        rows = self.s.execute(
            select(Email.message_id, Email.would_forward, Forward.state)
            .join(Attachment, Attachment.email_id == Email.id)
            .outerjoin(Forward, Forward.email_id == Email.id)
            .where(Attachment.sha256.in_(shas), Email.id != exclude_email_id)
            .order_by(Email.id)
        ).all()
        for message_id, would_forward, state in rows:
            if would_forward or state in ("SENT", "SENDING"):
                return message_id
        return None

    def add_attachment(self, email: Email, **fields) -> Attachment:
        a = self.get_attachment(email, fields["attachment_key"])
        if a is None:
            a = Attachment(email_id=email.id, **fields)
            self.s.add(a)
        else:
            for k, v in fields.items():
                setattr(a, k, v)
        self.s.flush()
        return a

    # ---------------- classification ----------------
    def set_classification(self, email: Email, **fields) -> Classification:
        c = email.classification
        if c is None:
            c = Classification(email_id=email.id, **fields)
            self.s.add(c)
            email.classification = c
        else:
            for k, v in fields.items():
                setattr(c, k, v)
        self.s.flush()
        return c

    # ---------------- forwards ----------------
    def get_forward(self, message_id: str) -> Forward | None:
        return self.s.scalar(select(Forward).where(Forward.message_id == message_id))

    def reserve_forward(self, email: Email, target: str) -> Forward | None:
        """Atomically reserve the right to forward this message.

        Returns None if any forward row already exists (SENDING / SENT / FAILED):
        a message is never forwarded twice, and an interrupted send is left for
        manual inspection rather than retried blindly.
        """
        if self.get_forward(email.message_id) is not None:
            return None
        f = Forward(email_id=email.id, message_id=email.message_id, state="SENDING",
                    forwarded=False, target_email=target)
        self.s.add(f)
        try:
            self.s.commit()
        except IntegrityError:
            self.s.rollback()
            return None
        return f

    def mark_forward_sent(self, f: Forward, target_message_id: str | None) -> None:
        f.state = "SENT"
        f.forwarded = True
        f.forward_timestamp = utcnow()
        f.target_message_id = target_message_id
        self.s.commit()

    def mark_forward_failed(self, f: Forward, error: str) -> None:
        f.state = "FAILED"
        f.error = error[:1000]
        self.s.commit()

    # ---------------- state / monitoring ----------------
    def get_state(self, key: str, default: str | None = None) -> str | None:
        st = self.s.get(SystemState, key)
        return st.value if st else default

    def set_state(self, key: str, value: str | None) -> None:
        st = self.s.get(SystemState, key)
        if st is None:
            self.s.add(SystemState(key=key, value=value, updated_at=utcnow()))
        else:
            st.value = value
            st.updated_at = utcnow()
        self.s.flush()

    def incr_state(self, key: str, by: int = 1) -> int:
        cur = int(self.get_state(key, "0") or 0) + by
        self.set_state(key, str(cur))
        return cur

    def all_state(self) -> dict[str, str | None]:
        return {st.key: st.value for st in self.s.scalars(select(SystemState))}

    # ---------------- reports ----------------
    def emails_processed_between(self, start: datetime, end: datetime) -> list[Email]:
        return list(
            self.s.scalars(
                select(Email)
                .options(selectinload(Email.attachments), selectinload(Email.classification),
                         selectinload(Email.forward))
                .where(Email.processed_at >= start, Email.processed_at < end)
                .order_by(Email.processed_at)
            )
        )

    def last_processed_email(self) -> Email | None:
        return self.s.scalar(
            select(Email).where(Email.processed_at.is_not(None))
            .order_by(Email.processed_at.desc()).limit(1)
        )


def classification_to_json(d: dict) -> str:
    return json.dumps(d, ensure_ascii=False, default=str)
