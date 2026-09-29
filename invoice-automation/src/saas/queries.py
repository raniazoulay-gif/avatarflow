"""Read models for the web app. Every function takes a Scope, which pins the
organisation and (for employees) the user's own mailboxes."""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from ..database.models import Classification, Email, EmailStatus
from .models import Mailbox, Role, User

DETECTED = {EmailStatus.DRY_RUN_WOULD_FORWARD, EmailStatus.FORWARDED, EmailStatus.FORWARD_BLOCKED,
            EmailStatus.CONFIRMED_INVOICE}
REVIEW = {EmailStatus.REVIEW, EmailStatus.NEW_SUPPLIER_REVIEW}
NOT_INV = {EmailStatus.NOT_INVOICE}

BUCKET = {**{s: "invoice" for s in DETECTED}, **{s: "review" for s in REVIEW},
          EmailStatus.NOT_INVOICE: "not_invoice", EmailStatus.ERROR: "error",
          EmailStatus.PENDING: "pending", EmailStatus.NO_ATTACHMENTS: "no_attachments"}
FILTERS = {"invoice": DETECTED, "review": REVIEW, "not_invoice": NOT_INV,
           "error": {EmailStatus.ERROR}, "no_attachments": {EmailStatus.NO_ATTACHMENTS}}


@dataclass
class Scope:
    org_id: int
    user_id: int
    role: str
    mailbox_ids: list[int] | None  # None = whole organisation (manager)

    @classmethod
    def for_user(cls, s: Session, user: User) -> Scope:
        if user.role == Role.MANAGER:
            return cls(user.org_id, user.id, user.role, None)
        ids = list(s.scalars(select(Mailbox.id).where(Mailbox.user_id == user.id,
                                                      Mailbox.org_id == user.org_id)))
        return cls(user.org_id, user.id, user.role, ids)


def _base(scope: Scope):
    q = select(Email).where(Email.org_id == scope.org_id)
    if scope.mailbox_ids is not None:
        q = q.where(Email.mailbox_id.in_(scope.mailbox_ids or [-1]))
    return q


def documents(s: Session, scope: Scope, since: datetime | None = None) -> list[Email]:
    """Emails that had a document attached (everything the engine judged)."""
    q = _base(scope).where(Email.status != EmailStatus.NO_ATTACHMENTS) \
        .options(selectinload(Email.classification), selectinload(Email.attachments))
    if since is not None:
        q = q.where(Email.received_at >= since)
    return list(s.scalars(q.order_by(Email.received_at.desc())))


def supplier_of(e: Email) -> str:
    c = e.classification
    return ((c.supplier if c else None) or e.sender_name or e.sender_email or "?")[:120]


def mailbox_owner_map(s: Session, org_id: int) -> dict[int, str]:
    rows = s.execute(select(Mailbox.id, User.name).join(User, User.id == Mailbox.user_id, isouter=True)
                     .where(Mailbox.org_id == org_id)).all()
    return {mid: (name or "") for mid, name in rows}


def email_card(e: Email, owners: dict[int, str] | None = None) -> dict:
    c = e.classification
    best = None
    for a in e.attachments or []:
        if a.filename and (c is None or a.filename == c.best_attachment):
            best = a
            break
    if best is None and e.attachments:
        best = e.attachments[0]
    ext = ((best.filename or "").rsplit(".", 1)[-1].upper() if best and best.filename else "")
    return {
        "id": e.id,
        "supplier": supplier_of(e),
        "subject": e.subject or "",
        "sender": e.sender_email or "",
        "received_at": e.received_at.isoformat() if e.received_at else None,
        "status": e.status,
        "bucket": BUCKET.get(e.status, "pending"),
        "score": round((e.final_score or 0) * 100),
        "invoice_number": c.invoice_number if c else None,
        "total": c.total if c else None,
        "currency": c.currency if c else None,
        "file_type": ext[:5] or "FILE",
        "drive_file_id": next((a.drive_file_id for a in e.attachments or [] if a.drive_file_id), None),
        "owner": (owners or {}).get(e.mailbox_id or -1, ""),
        "dry_run": bool(e.dry_run),
    }


def list_emails(s: Session, scope: Scope, bucket: str | None, q: str | None,
                limit: int = 50, offset: int = 0) -> tuple[list[dict], int]:
    stmt = _base(scope)
    if bucket != "no_attachments":  # mail without a file is only listed on request
        stmt = stmt.where(Email.status != EmailStatus.NO_ATTACHMENTS)
    if bucket in FILTERS:
        stmt = stmt.where(Email.status.in_(FILTERS[bucket]))
    if q:
        like = f"%{q.strip()[:80]}%"
        stmt = stmt.outerjoin(Classification, Classification.email_id == Email.id).where(or_(
            Email.subject.ilike(like), Email.sender_name.ilike(like), Email.sender_email.ilike(like),
            Classification.supplier.ilike(like), Classification.invoice_number.ilike(like)))
    total = len(list(s.scalars(stmt.with_only_columns(Email.id))))
    rows = s.scalars(stmt.options(selectinload(Email.classification), selectinload(Email.attachments))
                     .order_by(Email.received_at.desc()).limit(limit).offset(offset))
    owners = mailbox_owner_map(s, scope.org_id)
    return [email_card(e, owners) for e in rows], total


def get_email(s: Session, scope: Scope, email_id: int) -> Email | None:
    return s.scalar(_base(scope).where(Email.id == email_id).options(
        selectinload(Email.classification), selectinload(Email.attachments),
        selectinload(Email.forward)))


def email_detail(s: Session, scope: Scope, e: Email) -> dict:
    owners = mailbox_owner_map(s, scope.org_id)
    d = email_card(e, owners)
    c = e.classification
    reason = (c.reason if c else "") or ""
    d.update({
        "sender_name": e.sender_name or "",
        "invoice_date": c.invoice_date if c else None,
        "vat": c.vat if c else None,
        "reasons": [r.strip() for r in reason.split("|") if r.strip()][:6],
        "attachments": [{"filename": a.filename, "score": round((a.final_score or 0) * 100),
                         "drive_file_id": a.drive_file_id, "error": a.error}
                        for a in e.attachments or []],
        "forward": ({"state": e.forward.state, "at": e.forward.forward_timestamp.isoformat()
                     if e.forward.forward_timestamp else None} if e.forward else None),
        "processed_at": e.processed_at.isoformat() if e.processed_at else None,
        "gmail_link": f"https://mail.google.com/mail/u/0/#all/{e.message_id}",
        "reviewed": bool(e.reviewed_at),
    })
    return d


def month_start(now: datetime) -> datetime:
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def dashboard(s: Session, scope: Scope, tz, minutes_per_doc: float) -> dict:
    now = datetime.now(tz)
    m0 = month_start(now).astimezone(UTC)
    day0 = now.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    docs = documents(s, scope, since=min(m0, (now - timedelta(days=7)).astimezone(UTC)))
    month = [e for e in docs if e.received_at and e.received_at >= m0]
    today = [e for e in docs if e.received_at and e.received_at >= day0]
    inv = [e for e in month if e.status in DETECTED]
    rev_all = [e for e in documents(s, scope) if e.status in REVIEW]
    week = []
    for k in range(6, -1, -1):
        d0 = (now - timedelta(days=k)).replace(hour=0, minute=0, second=0, microsecond=0)
        d1 = d0 + timedelta(days=1)
        week.append({"date": d0.date().isoformat(), "weekday": d0.weekday(),
                     "count": sum(1 for e in docs if e.received_at and d0 <= e.received_at < d1)})
    owners = mailbox_owner_map(s, scope.org_id)
    out = {
        "month_documents": len(month),
        "today_documents": len(today),
        "month_invoices": len(inv),
        "auto_rate": round(len(inv) / len(month) * 100) if month else 0,
        "review_pending": len(rev_all),
        "hours_saved": round(len(inv) * minutes_per_doc / 60, 1),
        "week": week,
        "review_queue": [email_card(e, owners) for e in rev_all[:8]],
        "recent": [email_card(e, owners) for e in docs[:6]],
    }
    if scope.role == Role.MANAGER:
        out["team"] = team_stats(s, scope.org_id, m0, day0)
    return out


def team_stats(s: Session, org_id: int, m0: datetime, day0: datetime) -> list[dict]:
    users = list(s.scalars(select(User).where(User.org_id == org_id, User.active.is_(True))
                           .order_by(User.role.desc(), User.name)))
    mbs = list(s.scalars(select(Mailbox).where(Mailbox.org_id == org_id)))
    by_user: dict[int, list[int]] = defaultdict(list)
    for m in mbs:
        if m.user_id:
            by_user[m.user_id].append(m.id)
    emails = list(s.scalars(select(Email).where(Email.org_id == org_id,
                                                Email.status != EmailStatus.NO_ATTACHMENTS,
                                                Email.received_at >= m0)))
    per_mb: dict[int, list[Email]] = defaultdict(list)
    for e in emails:
        per_mb[e.mailbox_id or -1].append(e)
    pending = Counter(e.mailbox_id for e in s.scalars(
        select(Email).where(Email.org_id == org_id, Email.status.in_(REVIEW))))
    rows = []
    for u in users:
        mine = [e for mid in by_user.get(u.id, []) for e in per_mb.get(mid, [])]
        inv = sum(1 for e in mine if e.status in DETECTED)
        rows.append({
            "user_id": u.id, "name": u.name, "role": u.role,
            "mailboxes": [{"email": m.email, "status": m.status} for m in mbs if m.user_id == u.id],
            "month": len(mine),
            "today": sum(1 for e in mine if e.received_at and e.received_at >= day0),
            "review": sum(pending.get(mid, 0) for mid in by_user.get(u.id, [])),
            "auto_rate": round(inv / len(mine) * 100) if mine else 0,
        })
    return rows


def suppliers(s: Session, scope: Scope) -> list[dict]:
    agg: dict[str, dict] = {}
    for e in documents(s, scope):
        if e.status not in DETECTED | REVIEW:
            continue
        name = supplier_of(e)
        a = agg.setdefault(name, {"name": name, "count": 0, "total": 0.0, "last": None,
                                  "email": e.sender_email or ""})
        a["count"] += 1
        c = e.classification
        if c and c.total and (c.currency or "ILS").upper() in ("ILS", "NIS"):
            a["total"] += c.total
        if e.received_at and (a["last"] is None or e.received_at.isoformat() > a["last"]):
            a["last"] = e.received_at.isoformat()
    return sorted(agg.values(), key=lambda x: (-x["total"], -x["count"]))


def invoices_by_month(s: Session, scope: Scope, tz) -> dict[str, list[dict]]:
    owners = mailbox_owner_map(s, scope.org_id)
    out: dict[str, list[dict]] = defaultdict(list)
    for e in documents(s, scope):
        if e.status not in DETECTED:
            continue
        key = e.received_at.astimezone(tz).strftime("%Y-%m") if e.received_at else "unknown"
        out[key].append(email_card(e, owners))
    return dict(sorted(out.items(), reverse=True))


def reports(s: Session, scope: Scope, tz) -> dict:
    docs = documents(s, scope)
    inv = [e for e in docs if e.status in DETECTED]
    sup: Counter[str] = Counter()
    for e in inv:
        c = e.classification
        if c and c.total:
            sup[supplier_of(e)] += c.total
    monthly: dict[str, float] = defaultdict(float)
    for e in inv:
        c = e.classification
        if e.received_at and c and c.total:
            monthly[e.received_at.astimezone(tz).strftime("%Y-%m")] += c.total
    types: Counter[str] = Counter()
    for e in docs:
        for a in e.attachments or []:
            if a.filename and "." in a.filename:
                types[a.filename.rsplit(".", 1)[-1].upper()[:5]] += 1
    buckets = Counter(BUCKET.get(e.status, "pending") for e in docs)
    return {
        "top_suppliers": [{"name": n, "total": round(v, 2)} for n, v in sup.most_common(8)],
        "monthly": [{"month": k, "total": round(v, 2)} for k, v in sorted(monthly.items())[-6:]],
        "file_types": dict(types.most_common(6)),
        "buckets": dict(buckets),
        "documents": len(docs),
    }


def link_legacy_emails(s: Session, org_id: int, mailbox_id: int) -> int:
    """Attach emails processed by the original (env-configured) account to the
    organisation when that same address is connected in the web app."""
    rows = list(s.scalars(select(Email).where(Email.mailbox_id.is_(None), Email.org_id.is_(None))))
    for e in rows:
        e.org_id, e.mailbox_id = org_id, mailbox_id
    return len(rows)

