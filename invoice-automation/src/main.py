"""CLI entry point.

  python -m src.main check                 # SYSTEM CHECK
  python -m src.main run                   # service: poller + scheduler + /health
  python -m src.main process-once          # one poll cycle, then exit
  python -m src.main backfill --days 7     # scan last N days (never forwards by default)
  python -m src.main report [--date D] [--no-send]
  python -m src.main admin-link            # print a one-time platform admin setup link
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from datetime import date

from .config.settings import Settings, get_settings
from .system_check import format_check, run_system_check
from .utils.logging_setup import setup_logging

log = logging.getLogger("invoice_automation")


def _secrets(s: Settings) -> list[str]:
    return [s.gmail_client_secret, s.gmail_refresh_token, s.ai_api_key, s.pubsub_verification_token]


def _banner(s: Settings) -> None:
    if s.forward_switches_on:
        log.warning("MODE: PRODUCTION - invoices above %.2f WILL be forwarded to target",
                    s.invoice_auto_forward_threshold)
    else:
        log.info("MODE: DRY RUN - no email will be forwarded")


def cmd_check(s: Settings, _args) -> int:
    items = run_system_check(s)
    print(format_check(items))
    return 0 if all(i.status != "ERROR" for i in items) else 1


def _ctx(s: Settings):
    from .app_context import AppContext

    return AppContext(s)


def cmd_process_once(s: Settings, _args) -> int:
    ctx = _ctx(s)
    if ctx.watcher is None:
        print("Gmail NOT CONFIGURED / not connected - nothing processed.")
        return 1
    ctx.labels.ensure_labels()
    res = ctx.watcher.poll_once()
    print(json.dumps(res, indent=2))
    return 0


def cmd_backfill(s: Settings, args) -> int:
    ctx = _ctx(s)
    if ctx.watcher is None:
        print("Gmail NOT CONFIGURED / not connected - nothing processed.")
        return 1
    ctx.labels.ensure_labels()
    days = args.days if args.days is not None else s.backfill_days
    res = ctx.watcher.backfill(days)
    print(json.dumps(res, indent=2))
    return 0


def cmd_report(s: Settings, args) -> int:
    from .reports.email_report import generate_daily_report

    ctx = _ctx(s)
    d = date.fromisoformat(args.date) if args.date else None
    res = generate_daily_report(s, ctx.db, ctx.gmail, d, send=not args.no_send)
    print(json.dumps(res, indent=2, default=str))
    return 0


def cmd_admin_link(s: Settings, _args) -> int:
    from .database.repository import Database
    from .saas.bootstrap import create_admin_link

    db = Database(s.database_url)
    db.create_all()
    try:
        print(create_admin_link(s, db))
    except ValueError as exc:
        print(f"Not created: {exc}")
        return 1
    return 0


def cmd_run(s: Settings, _args) -> int:
    import uvicorn

    from .api.server import create_app
    from .scheduler.jobs import build_scheduler

    print(format_check(run_system_check(s)))
    ctx = _ctx(s)
    if ctx.watcher is None:
        log.error("Gmail NOT CONFIGURED / not connected - only /health will run. "
                  "Fix credentials and restart.")
    else:
        ctx.labels.ensure_labels()
        ctx.watcher.start_watch()
        if s.backfill_days > 0:
            with ctx.db.repo() as repo:
                done = repo.get_state("backfill_done_days")
            if done != str(s.backfill_days):
                ctx.watcher.backfill(s.backfill_days)
                with ctx.db.repo() as repo:
                    repo.set_state("backfill_done_days", str(s.backfill_days))
        ctx.safe_poll()
    ctx.bootstrap_admin()
    sched = build_scheduler(ctx)
    sched.start()
    for job in sched.get_jobs():
        log.info("Scheduled: %s next run %s", job.name, job.next_run_time)
    try:
        uvicorn.run(create_app(ctx), host=s.host, port=s.port, log_level="warning")
    finally:
        sched.shutdown(wait=False)
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="invoice-automation")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check")
    sub.add_parser("run")
    sub.add_parser("process-once")
    b = sub.add_parser("backfill")
    b.add_argument("--days", type=int, default=None)
    r = sub.add_parser("report")
    r.add_argument("--date", default=None, help="YYYY-MM-DD (default: today in TIMEZONE)")
    r.add_argument("--no-send", action="store_true", help="only write the Excel file")
    sub.add_parser("admin-link")
    args = p.parse_args(argv)

    try:
        s = get_settings()
    except Exception as exc:
        print(f"CONFIGURATION ERROR: {exc}", file=sys.stderr)
        return 2
    setup_logging(s.log_level, _secrets(s))
    _banner(s)
    handlers = {"check": cmd_check, "run": cmd_run, "process-once": cmd_process_once,
                "backfill": cmd_backfill, "report": cmd_report,
                "admin-link": cmd_admin_link}
    return handlers[args.cmd](s, args)


if __name__ == "__main__":
    sys.exit(main())
