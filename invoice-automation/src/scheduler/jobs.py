"""APScheduler jobs with an explicit timezone (never the server's local tz)."""

from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

log = logging.getLogger(__name__)


def build_scheduler(app_ctx) -> BackgroundScheduler:
    s = app_ctx.settings
    sched = BackgroundScheduler(timezone=s.tz, job_defaults={"coalesce": True,
                                                             "max_instances": 1,
                                                             "misfire_grace_time": 3600})
    sched.add_job(app_ctx.safe_poll, IntervalTrigger(seconds=s.poll_interval_seconds, timezone=s.tz),
                  id="poll", name="Gmail polling")
    sched.add_job(app_ctx.safe_daily_report,
                  CronTrigger(hour=s.report_hour, minute=s.report_minute, timezone=s.tz),
                  id="daily_report", name="Daily Excel report")
    if s.gmail_pubsub_topic:
        # Gmail watch expires after 7 days - renew daily.
        sched.add_job(app_ctx.safe_renew_watch, CronTrigger(hour=3, minute=17, timezone=s.tz),
                      id="renew_watch", name="Renew Gmail watch")
    return sched
