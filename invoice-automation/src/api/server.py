"""HTTP endpoints: /health, /gmail/push (Pub/Sub push target) and the public
home / privacy / terms pages required by the Google OAuth consent screen."""

from __future__ import annotations

import hmac

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse

from .public_pages import home_page, privacy_page, terms_page


def create_app(ctx) -> FastAPI:
    app = FastAPI(title="Gmail Invoice Automation", docs_url=None, redoc_url=None)

    def _contact() -> str:
        s = ctx.settings
        return s.public_contact_email or s.source_gmail_account

    @app.get("/", response_class=HTMLResponse)
    def home() -> str:
        return home_page(_contact())

    @app.get("/privacy", response_class=HTMLResponse)
    def privacy() -> str:
        return privacy_page(_contact())

    @app.get("/terms", response_class=HTMLResponse)
    def terms() -> str:
        return terms_page(_contact())

    @app.get("/health")
    def health() -> dict:
        s = ctx.settings
        try:
            ctx.db.ping()
            db_status = "OK"
        except Exception as exc:
            db_status = f"ERROR ({type(exc).__name__})"
        state: dict = {}
        last_email = None
        try:
            with ctx.db.repo() as repo:
                state = repo.all_state()
                e = repo.last_processed_email()
                if e is not None:
                    last_email = {"message_id": e.message_id, "status": e.status,
                                  "processed_at": e.processed_at.isoformat() if e.processed_at
                                  else None}
        except Exception:
            pass
        if not s.gmail_configured:
            gmail_status = "NOT CONFIGURED"
        elif ctx.gmail is None:
            gmail_status = f"ERROR ({ctx.gmail_error})"
        else:
            gmail_status = "CONNECTED" if state.get("last_poll") else "NOT VERIFIED"
        return {
            "mode": s.mode,
            "gmail_status": gmail_status,
            "gmail_watch": state.get("watch_status", "NOT CONFIGURED"),
            "database_status": db_status,
            "ai_status": "CONFIGURED (NOT VERIFIED here; run system check)"
            if s.ai_configured else "NOT CONFIGURED",
            "last_processed_email": last_email,
            "last_report": state.get("last_daily_report"),
            "last_error": state.get("last_error"),
            "monitoring": {k: state.get(k) for k in (
                "last_successful_processing", "last_failed_processing", "last_daily_report",
                "total_processed", "total_invoices", "total_would_forward", "total_forwarded",
                "total_errors", "last_poll")},
        }

    @app.post("/gmail/push")
    async def gmail_push(request: Request) -> dict:
        token = ctx.settings.pubsub_verification_token
        supplied = request.query_params.get("token", "")
        if not token or not hmac.compare_digest(token, supplied):
            raise HTTPException(status_code=403, detail="forbidden")
        if ctx.watcher is None:
            raise HTTPException(status_code=503, detail="Gmail not configured")
        # Payload only carries emailAddress/historyId; we simply run an
        # idempotent poll cycle, which picks up anything new.
        ctx.watcher.on_push_notification()
        return {"ok": True}

    return app
