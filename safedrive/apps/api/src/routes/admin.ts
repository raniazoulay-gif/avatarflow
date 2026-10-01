import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { resolveSafetyConfig } from '@safedrive/core';
import { type AppContext } from '../context.js';
import { me } from '../auth/plugin.js';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import { clearConfigCache } from '../services/app-config.js';
import { liveView, type TripRow } from '../services/live.js';

export async function systemHealth(app: FastifyInstance, ctx: AppContext) {
  const t0 = performance.now();
  let db: { ok: boolean; latencyMs: number; error?: string };
  try {
    await ctx.db.query('SELECT 1');
    db = { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch (e) {
    db = { ok: false, latencyMs: -1, error: (e as Error).message };
  }
  const q = db.ok
    ? await ctx.db.query<{ pending: number; failed: number; oldest: Date | null }>(
        `SELECT count(*) FILTER (WHERE push_status = 'pending')::int AS pending,
                count(*) FILTER (WHERE push_status = 'failed' AND created_at > now() - interval '1 day')::int AS failed,
                min(created_at) FILTER (WHERE push_status = 'pending') AS oldest
         FROM notifications`,
      )
    : null;
  const active = db.ok
    ? await ctx.db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM trips WHERE ended_at IS NULL',
      )
    : null;
  const sent = ctx.metrics.get('push_sent');
  const failed = ctx.metrics.get('push_failed');
  return {
    status: db.ok ? 'ok' : 'degraded',
    database: db,
    realtime: { bus: ctx.bus.kind, websocketConnections: app.wsConnections() },
    notificationQueue: {
      provider: ctx.push.id,
      pending: q?.rows[0]?.pending ?? null,
      failedLast24h: q?.rows[0]?.failed ?? null,
      oldestPendingAt: q?.rows[0]?.oldest ?? null,
      successRate: sent + failed > 0 ? Math.round((sent / (sent + failed)) * 1000) / 10 : null,
    },
    providers: ctx.speedLimits.providerHealth(),
    activeTrips: active?.rows[0]?.n ?? null,
    metrics: ctx.metrics.snapshot(),
  };
}

export function adminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const admin = { preHandler: app.requireSystemAdmin };
  const id = z.object({ id: z.string().uuid() });

  app.get('/admin/users', admin, async (req) => {
    const q = parse(
      z.object({
        q: z.string().max(100).default(''),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const { rows } = await ctx.db.query(
      `SELECT id, email, display_name AS "displayName", status, is_system_admin AS "isSystemAdmin",
              created_at AS "createdAt", last_login_at AS "lastLoginAt",
              (SELECT count(*)::int FROM family_members m WHERE m.user_id = u.id AND m.removed_at IS NULL) AS families
       FROM users u WHERE deleted_at IS NULL AND ($1 = '' OR email ILIKE '%' || $1 || '%' OR display_name ILIKE '%' || $1 || '%')
       ORDER BY created_at DESC LIMIT $2`,
      [q.q, q.limit],
    );
    return rows;
  });

  app.get('/admin/users/:id', admin, async (req) => {
    const { id: userId } = parse(id, req.params);
    const u = await ctx.db.query(
      `SELECT id, email, display_name AS "displayName", status, is_system_admin AS "isSystemAdmin", locale,
              created_at AS "createdAt", last_login_at AS "lastLoginAt", failed_logins AS "failedLogins"
       FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    if (!u.rowCount) throw notFound('User not found');
    const fams = await ctx.db.query(
      `SELECT f.id, f.name, m.role FROM family_members m JOIN families f ON f.id = m.family_id
       WHERE m.user_id = $1 AND m.removed_at IS NULL`,
      [userId],
    );
    const devices = await ctx.db.query(
      `SELECT id, platform, model, app_version AS "appVersion", last_seen_at AS "lastSeenAt", push_token IS NOT NULL AS "pushReady", capabilities
       FROM devices WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    const sessions = await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM device_sessions WHERE user_id = $1 AND revoked_at IS NULL AND rotated_at IS NULL AND expires_at > now()',
      [userId],
    );
    return {
      ...u.rows[0],
      families: fams.rows,
      devices: devices.rows,
      activeSessions: sessions.rows[0]?.n ?? 0,
    };
  });

  for (const [action, status] of [
    ['suspend', 'suspended'],
    ['unsuspend', 'active'],
  ] as const) {
    app.post(`/admin/users/:id/${action}`, admin, async (req) => {
      const { id: userId } = parse(id, req.params);
      if (userId === me(req).id) throw notFound('Cannot change your own status');
      await ctx.db.query('UPDATE users SET status = $2, updated_at = now() WHERE id = $1', [
        userId,
        status,
      ]);
      if (status === 'suspended') await ctx.auth.logoutAll(userId);
      await audit(ctx.db, {
        actorId: me(req).id,
        action: `admin.user_${action}`,
        targetType: 'user',
        targetId: userId,
        ip: req.ip,
      });
      return { ok: true };
    });
  }

  app.get('/admin/families', admin, async (req) => {
    const q = parse(z.object({ q: z.string().max(100).default('') }), req.query);
    const { rows } = await ctx.db.query(
      `SELECT f.id, f.name, f.country_code AS "countryCode", f.is_demo AS "isDemo", f.created_at AS "createdAt",
              (SELECT count(*)::int FROM family_members m WHERE m.family_id = f.id AND m.removed_at IS NULL) AS members,
              (SELECT count(*)::int FROM drivers d WHERE d.family_id = f.id AND d.deleted_at IS NULL) AS drivers,
              (SELECT count(*)::int FROM trips t WHERE t.family_id = f.id) AS trips,
              (SELECT count(*)::int FROM trips t WHERE t.family_id = f.id AND t.ended_at IS NULL) AS "activeTrips"
       FROM families f WHERE f.deleted_at IS NULL AND ($1 = '' OR f.name ILIKE '%' || $1 || '%')
       ORDER BY f.created_at DESC LIMIT 200`,
      [q.q],
    );
    return rows;
  });

  app.get('/admin/families/:id', admin, async (req) => {
    const { id: familyId } = parse(id, req.params);
    const detail = await ctx.families.detail(familyId);
    const trips = await ctx.db.query(
      `SELECT t.id, d.display_name AS "driverName", t.state, t.is_demo AS "isDemo", t.started_at AS "startedAt",
              t.ended_at AS "endedAt", round(t.distance_m)::int AS "distanceM", t.score
       FROM trips t JOIN drivers d ON d.id = t.driver_id WHERE t.family_id = $1 ORDER BY t.started_at DESC LIMIT 50`,
      [familyId],
    );
    const devices = await ctx.db.query(
      `SELECT dv.id, u.display_name AS "owner", dv.platform, dv.model, dv.last_seen_at AS "lastSeenAt", dv.push_token IS NOT NULL AS "pushReady"
       FROM devices dv JOIN users u ON u.id = dv.user_id JOIN family_members m ON m.user_id = u.id
       WHERE m.family_id = $1 AND m.removed_at IS NULL AND dv.revoked_at IS NULL`,
      [familyId],
    );
    await audit(ctx.db, {
      actorId: me(req).id,
      familyId,
      action: 'admin.family_view',
      targetType: 'family',
      targetId: familyId,
      ip: req.ip,
    });
    return { ...detail, trips: trips.rows, devices: devices.rows };
  });

  app.get('/admin/trips/active', admin, async () => {
    const { rows } = await ctx.db.query<TripRow & { display_name: string; family_name: string }>(
      `SELECT t.*, d.display_name, f.name AS family_name FROM trips t JOIN drivers d ON d.id = t.driver_id
       JOIN families f ON f.id = t.family_id WHERE t.ended_at IS NULL ORDER BY t.started_at`,
    );
    return rows.map((r) => ({
      ...liveView(r, r.display_name, ctx.env.OFFLINE_AFTER_SECONDS),
      familyId: r.family_id,
      familyName: r.family_name,
    }));
  });

  app.get('/admin/health', admin, async () => systemHealth(app, ctx));

  app.get('/admin/provider-usage', admin, async () => {
    const { rows } = await ctx.db.query(
      `SELECT provider, day, calls, errors, cache_hits AS "cacheHits", CASE WHEN calls > 0 THEN total_ms / calls ELSE 0 END AS "avgMs"
       FROM provider_usage WHERE day > current_date - 30 ORDER BY day DESC, provider`,
    );
    return rows;
  });

  app.get('/admin/audit', admin, async (req) => {
    const q = parse(
      z.object({
        action: z.string().max(60).default(''),
        familyId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
      req.query,
    );
    const { rows } = await ctx.db.query(
      `SELECT a.id, a.at, a.action, a.actor_id AS "actorId", u.email AS "actorEmail", a.family_id AS "familyId",
              a.target_type AS "targetType", a.target_id AS "targetId", a.ip, a.details
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE ($1 = '' OR a.action LIKE $1 || '%') AND ($2::uuid IS NULL OR a.family_id = $2)
       ORDER BY a.at DESC LIMIT $3`,
      [q.action, q.familyId ?? null, q.limit],
    );
    return rows;
  });

  app.get('/admin/config', admin, async () => {
    const { rows } = await ctx.db.query(
      `SELECT scope, key, value, updated_at AS "updatedAt" FROM app_config ORDER BY scope, key`,
    );
    return rows;
  });

  /** Safety configuration per scope (global, country:IL, family:<id>). Validated before saving. */
  app.put('/admin/config/safety', admin, async (req) => {
    const b = parse(
      z.object({
        scope: z.string().regex(/^(global|country:[A-Z]{2}|family:[0-9a-f-]{36})$/),
        value: z.record(z.unknown()),
      }),
      req.body,
    );
    resolveSafetyConfig(b.value as never); // throws on invalid thresholds
    await ctx.db.query(
      `INSERT INTO app_config (scope, key, value, updated_by) VALUES ($1, 'safety', $2, $3)
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [b.scope, b.value, me(req).id],
    );
    clearConfigCache();
    await audit(ctx.db, {
      actorId: me(req).id,
      action: 'admin.config_change',
      targetType: 'config',
      targetId: `${b.scope}:safety`,
      ip: req.ip,
      details: b.value,
    });
    return { ok: true };
  });
}
