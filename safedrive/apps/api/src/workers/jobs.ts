/**
 * Background jobs. Each tick is safe to run on several instances at once
 * (SKIP LOCKED / conditional UPDATEs), so no external scheduler is required.
 */
import { countryProfile } from '@safedrive/core';
import { type AppContext } from '../context.js';
import { familyChannel } from '../realtime/bus.js';
import { liveView, type TripRow } from '../services/live.js';

export async function deliverPush(ctx: AppContext): Promise<void> {
  await ctx.notifications.deliverPending(50);
}

/** Driver offline: one notification per silence episode (reset when data arrives). */
export async function detectOffline(ctx: AppContext): Promise<number> {
  const { rows } = await ctx.db.query<TripRow & { display_name: string }>(
    `UPDATE trips t SET offline_notified_at = now()
     FROM drivers d WHERE d.id = t.driver_id AND t.ended_at IS NULL AND t.offline_notified_at IS NULL
       AND coalesce(t.last_point_at, t.started_at) < now() - ($1 || ' seconds')::interval
     RETURNING t.*, d.display_name`,
    [String(ctx.env.OFFLINE_AFTER_SECONDS)],
  );
  for (const t of rows) {
    await ctx.bus.publish(familyChannel(t.family_id), { type: 'trip.update', data: liveView(t, t.display_name, ctx.env.OFFLINE_AFTER_SECONDS) });
    await ctx.notifications.notifyParents({
      familyId: t.family_id,
      type: 'DRIVER_OFFLINE',
      driverId: t.driver_id,
      tripId: t.id,
      dedupeKey: `${t.id}:offline:${(t.last_point_at ?? t.started_at).getTime()}`,
      titleKey: 'app.name',
      bodyKey: 'notify.offline',
      vars: { name: t.display_name },
      isDemo: t.is_demo,
    });
    await ctx.db.query(
      `INSERT INTO safety_events (family_id, driver_id, trip_id, type, occurred_at, is_demo, dedupe_key)
       VALUES ($1, $2, $3, 'CONNECTIVITY_LOSS', now(), $4, $5) ON CONFLICT DO NOTHING`,
      [t.family_id, t.driver_id, t.id, t.is_demo, `offline:${(t.last_point_at ?? t.started_at).getTime()}`],
    );
  }
  return rows.length;
}

/** Ends trips that have been silent for a long time (app killed, phone off...). */
export async function autoEndTrips(ctx: AppContext): Promise<number> {
  const { rows } = await ctx.db.query<{ id: string }>(
    `SELECT id FROM trips WHERE ended_at IS NULL
       AND coalesce(last_point_at, started_at) < now() - ($1 || ' minutes')::interval LIMIT 50`,
    [String(ctx.env.AUTO_END_TRIP_AFTER_MINUTES)],
  );
  for (const r of rows) await ctx.trips.stop(r.id, { userId: null, reason: 'auto' }).catch(() => undefined);
  await ctx.monitoring.expireOld();
  return rows.length;
}

/** Monthly partitions for telemetry (current + next two months). */
export async function ensurePartitions(ctx: AppContext, now = new Date()): Promise<void> {
  for (let k = 0; k < 3; k++) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + k + 1, 1));
    const name = `telemetry_points_y${from.getUTCFullYear()}m${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
    try {
      await ctx.db.query(
        `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF telemetry_points FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
      );
    } catch (e) {
      // Rows for this range already sit in the default partition (e.g. clock skew); keep running.
      console.warn(`Partition ${name} not created: ${(e as Error).message}`);
    }
  }
}

/**
 * Retention (configurable per country via the country profile, overridable in app_config
 * key 'retention'). Raw telemetry is short-lived; trip summaries and events live longer.
 */
export async function applyRetention(ctx: AppContext): Promise<Record<string, number>> {
  const cfgRow = await ctx.db.query<{ value: Partial<{ rawTelemetryDays: number; tripSummaryDays: number; auditLogDays: number }> }>(
    `SELECT value FROM app_config WHERE scope = 'global' AND key = 'retention'`,
  );
  const r = { ...countryProfile('IL').retention, ...(cfgRow.rows[0]?.value ?? {}) };
  const raw = await ctx.db.query(
    `DELETE FROM telemetry_points WHERE recorded_at < now() - ($1 || ' days')::interval
       AND trip_id IN (SELECT id FROM trips WHERE ended_at IS NOT NULL)`,
    [String(r.rawTelemetryDays)],
  );
  const audits = await ctx.db.query(`DELETE FROM audit_logs WHERE at < now() - ($1 || ' days')::interval`, [String(r.auditLogDays)]);
  const notes = await ctx.db.query(`DELETE FROM notifications WHERE created_at < now() - interval '180 days'`);
  const cache1 = await ctx.db.query(`DELETE FROM speed_limits WHERE expires_at < now()`);
  const cache2 = await ctx.db.query(`DELETE FROM provider_cache WHERE expires_at < now()`);
  const sessions = await ctx.db.query(`DELETE FROM device_sessions WHERE expires_at < now() - interval '30 days'`);
  return {
    telemetryPoints: raw.rowCount ?? 0,
    auditLogs: audits.rowCount ?? 0,
    notifications: notes.rowCount ?? 0,
    cache: (cache1.rowCount ?? 0) + (cache2.rowCount ?? 0),
    sessions: sessions.rowCount ?? 0,
  };
}

export function startWorkers(ctx: AppContext): () => void {
  const timers: NodeJS.Timeout[] = [];
  const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
    let running = false;
    const t = setInterval(() => {
      if (running) return;
      running = true;
      fn()
        .catch((e: Error) => {
          ctx.metrics.inc(`job_${name}_errors`);
          console.error(`Job ${name} failed: ${e.message}`);
        })
        .finally(() => {
          running = false;
        });
    }, ms);
    t.unref();
    timers.push(t);
  };
  every(2_000, 'push', () => deliverPush(ctx));
  every(15_000, 'offline', () => detectOffline(ctx));
  every(60_000, 'auto_end', () => autoEndTrips(ctx));
  every(6 * 3600_000, 'maintenance', async () => {
    await ensurePartitions(ctx);
    await applyRetention(ctx);
  });
  ctx.speedLimits.startUsageFlush();
  return () => {
    for (const t of timers) clearInterval(t);
    ctx.speedLimits.stop();
  };
}
