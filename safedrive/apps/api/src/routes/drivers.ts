import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../context.js';
import { me } from '../auth/plugin.js';
import { requireDriverAccess, requireParent } from '../auth/access.js';
import { parse } from '../lib/validate.js';

const id = z.object({ id: z.string().uuid() });

export function driverRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: app.requireAuth };

  app.get('/drivers/:id', auth, async (req) => {
    const { id: driverId } = parse(id, req.params);
    const { driver, as } = await requireDriverAccess(ctx.db, me(req).id, driverId);
    const latest = await ctx.db.query(
      `SELECT score, breakdown, computed_at AS "computedAt" FROM safety_scores
       WHERE driver_id = $1 AND scope = 'trip' ORDER BY computed_at DESC LIMIT 1`,
      [driverId],
    );
    const active = await ctx.db.query(
      'SELECT id FROM trips WHERE driver_id = $1 AND ended_at IS NULL',
      [driverId],
    );
    return {
      id: driver.id,
      familyId: driver.family_id,
      displayName: driver.display_name,
      safetyScore: driver.safety_score,
      lastTripScore: latest.rows[0] ?? null,
      activeTripId: active.rows[0]?.id ?? null,
      viewerRole: as,
    };
  });

  app.get('/drivers/:id/trips', auth, async (req) => {
    const { id: driverId } = parse(id, req.params);
    await requireDriverAccess(ctx.db, me(req).id, driverId);
    const q = parse(
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        before: z.string().datetime().optional(),
        includeDemo: z.enum(['true', 'false']).default('true'),
      }),
      req.query,
    );
    const { rows } = await ctx.db.query(
      `SELECT id, state, is_demo AS "isDemo", started_at AS "startedAt", ended_at AS "endedAt",
              extract(epoch FROM (coalesce(ended_at, now()) - started_at))::int AS "durationSec",
              round(distance_m)::int AS "distanceM", round(max_speed_kmh)::int AS "maxSpeedKmh",
              CASE WHEN moving_seconds > 0 THEN round((distance_m / moving_seconds * 3.6)::numeric, 1) ELSE 0 END AS "avgSpeedKmh",
              speeding_count AS "speedingCount", critical_count AS "criticalCount",
              hard_braking_count AS "hardBrakingCount", hard_acceleration_count AS "hardAccelerationCount",
              score, score_breakdown AS "scoreBreakdown"
       FROM trips WHERE driver_id = $1 AND ($2::timestamptz IS NULL OR started_at < $2) AND ($3 OR NOT is_demo)
       ORDER BY started_at DESC LIMIT $4`,
      [driverId, q.before ?? null, q.includeDemo === 'true', q.limit],
    );
    return rows;
  });

  /** Parent asks the driver to start monitoring (never starts it silently). */
  app.post(
    '/drivers/:id/monitoring-requests',
    { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      const { id: driverId } = parse(id, req.params);
      const { driver } = await requireDriverAccess(ctx.db, me(req).id, driverId);
      await requireParent(ctx.db, me(req).id, driver.family_id);
      return ctx.monitoring.request(me(req).id, driverId, req.ip);
    },
  );

  app.get('/me/monitoring-requests', auth, async (req) => {
    const { rows } = await ctx.db.query(
      `SELECT m.id, m.driver_id AS "driverId", m.status, m.created_at AS "createdAt", m.expires_at AS "expiresAt",
              u.display_name AS "requestedBy"
       FROM monitoring_requests m JOIN drivers d ON d.id = m.driver_id JOIN users u ON u.id = m.requested_by
       WHERE d.user_id = $1 AND m.status IN ('REQUESTED', 'PENDING', 'PERMISSION_REQUIRED') AND m.expires_at > now()
       ORDER BY m.created_at DESC`,
      [me(req).id],
    );
    return rows;
  });

  app.post('/monitoring-requests/:id/respond', auth, async (req) => {
    const { id: requestId } = parse(id, req.params);
    const b = parse(
      z.object({ status: z.enum(['DECLINED', 'PERMISSION_REQUIRED', 'UNAVAILABLE', 'PENDING']) }),
      req.body,
    );
    return ctx.monitoring.respond(me(req).id, requestId, b.status);
  });
}
