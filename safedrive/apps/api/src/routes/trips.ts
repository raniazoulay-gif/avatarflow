import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../context.js';
import { me } from '../auth/plugin.js';
import { requireTripAccess } from '../auth/access.js';
import { parse } from '../lib/validate.js';
import { liveView, type TripRow } from '../services/live.js';
import { MAX_BATCH } from '../services/telemetry.js';

const id = z.object({ id: z.string().uuid() });
const point = z.object({
  id: z.string().uuid(),
  seq: z.number().int().min(1),
  recordedAt: z.union([z.string().max(40), z.number()]),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  altitudeM: z.number().nullable().optional(),
  speedMs: z.number().nullable().optional(),
  headingDeg: z.number().nullable().optional(),
  accuracyM: z.number().nullable().optional(),
  source: z.enum(['gps', 'simulated']).optional(),
  simulatedLimitKmh: z.number().positive().max(200).nullable().optional(),
});

export function tripRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: app.requireAuth };

  app.post('/trips/start', auth, async (req) => {
    const b = parse(
      z.object({
        driverId: z.string().uuid(),
        deviceId: z.string().uuid().nullable().optional(),
        monitoringRequestId: z.string().uuid().nullable().optional(),
        isDemo: z.boolean().optional(),
      }),
      req.body,
    );
    return ctx.trips.start(me(req).id, b, req.ip);
  });

  app.post('/trips/:id/stop', auth, async (req) => {
    const { id: tripId } = parse(id, req.params);
    return ctx.trips.stop(tripId, { userId: me(req).id, reason: 'driver' });
  });

  /** Idempotent batch upload (offline queue). Duplicates are acknowledged, never re-processed. */
  app.post(
    '/trips/:id/telemetry',
    { ...auth, bodyLimit: 512 * 1024, config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (req) => {
      const { id: tripId } = parse(id, req.params);
      const b = parse(z.object({ points: z.array(point).max(MAX_BATCH) }), req.body);
      return ctx.telemetry.ingest(me(req).id, tripId, b.points);
    },
  );

  app.post('/trips/:id/events', auth, async (req) => {
    const { id: tripId } = parse(id, req.params);
    const b = parse(
      z.object({
        clientId: z.string().uuid(),
        type: z.enum(['PHONE_USAGE', 'GPS_UNAVAILABLE', 'PERMISSION_PROBLEM', 'CONNECTIVITY_LOSS']),
        at: z.number().int(),
        data: z
          .record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()]))
          .default({}),
      }),
      req.body,
    );
    return ctx.trips.reportClientEvent(me(req).id, tripId, b);
  });

  app.get('/trips/:id', auth, async (req) => {
    const { id: tripId } = parse(id, req.params);
    const a = await requireTripAccess(ctx.db, me(req).id, tripId);
    const t = await ctx.db.query<TripRow>('SELECT * FROM trips WHERE id = $1', [tripId]);
    const trip = t.rows[0] as TripRow;
    const speeding = await ctx.db.query(
      `SELECT id, status, start_time AS "startTime", end_time AS "endTime", duration_s AS "durationSec",
              start_speed_kmh AS "startSpeedKmh", round(max_speed_kmh)::int AS "maxSpeedKmh", speed_limit_kmh AS "speedLimitKmh",
              round(max_excess_kmh)::int AS "maxExcessKmh", round(max_excess_pct)::int AS "maxExcessPct", severity,
              start_lat AS "startLat", start_lon AS "startLon", max_lat AS "maxLat", max_lon AS "maxLon", road, limit_source AS "limitSource",
              end_reason AS "endReason"
       FROM speeding_events WHERE trip_id = $1 ORDER BY start_time`,
      [tripId],
    );
    const events = await ctx.db.query(
      `SELECT id, type, severity, occurred_at AS "occurredAt", ended_at AS "endedAt", lat, lon, data
       FROM safety_events WHERE trip_id = $1 ORDER BY occurred_at`,
      [tripId],
    );
    const durationSec = Math.round(
      ((trip.ended_at ?? new Date()).getTime() - trip.started_at.getTime()) / 1000,
    );
    return {
      id: trip.id,
      driverId: trip.driver_id,
      driverName: a.driver.display_name,
      isDemo: trip.is_demo,
      state: trip.state,
      startedAt: trip.started_at,
      endedAt: trip.ended_at,
      durationSec,
      distanceM: Math.round(trip.distance_m),
      maxSpeedKmh: Math.round(trip.max_speed_kmh),
      avgSpeedKmh:
        trip.moving_seconds > 0
          ? Math.round((trip.distance_m / trip.moving_seconds) * 3.6 * 10) / 10
          : 0,
      score: trip.score,
      scoreBreakdown: trip.score_breakdown,
      counts: {
        speeding: trip.speeding_count,
        critical: trip.critical_count,
        hardBraking: trip.hard_braking_count,
        hardAcceleration: trip.hard_acceleration_count,
        phoneUsage: trip.phone_usage_count,
      },
      live: trip.ended_at
        ? null
        : liveView(trip, a.driver.display_name, ctx.env.OFFLINE_AFTER_SECONDS),
      speedingEvents: speeding.rows,
      events: events.rows,
    };
  });

  /** Route + speed / speed-limit history. Down-sampled to at most `max` points for maps/charts. */
  app.get('/trips/:id/points', auth, async (req) => {
    const { id: tripId } = parse(id, req.params);
    await requireTripAccess(ctx.db, me(req).id, tripId);
    const q = parse(
      z.object({ max: z.coerce.number().int().min(10).max(5000).default(1500) }),
      req.query,
    );
    const { rows } = await ctx.db.query(
      `WITH p AS (
         SELECT seq, recorded_at, lat, lon, speed_kmh, limit_kmh, accuracy_m, row_number() OVER (ORDER BY seq) AS rn,
                count(*) OVER () AS total
         FROM telemetry_points WHERE trip_id = $1)
       SELECT seq, extract(epoch FROM recorded_at) * 1000 AS t, lat, lon,
              round(speed_kmh::numeric, 1) AS "speedKmh", limit_kmh AS "limitKmh", accuracy_m AS "accuracyM"
       FROM p WHERE total <= $2 OR rn % ceil(total::numeric / $2)::int = 1 OR rn = total ORDER BY seq`,
      [tripId, q.max],
    );
    return rows.map((r) => ({
      ...r,
      t: Number(r.t),
      speedKmh: r.speedKmh === null ? null : Number(r.speedKmh),
    }));
  });

  /** The driver's current trip (driver app resumes after restart). */
  app.get('/me/active-trip', auth, async (req) => {
    const { rows } = await ctx.db.query<TripRow & { display_name: string }>(
      `SELECT t.*, d.display_name FROM trips t JOIN drivers d ON d.id = t.driver_id
       WHERE d.user_id = $1 AND t.ended_at IS NULL LIMIT 1`,
      [me(req).id],
    );
    const t = rows[0];
    return t
      ? { ...liveView(t, t.display_name, ctx.env.OFFLINE_AFTER_SECONDS), lastSeq: t.last_seq }
      : null;
  });
}
