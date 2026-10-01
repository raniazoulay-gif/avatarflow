import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../context.js';
import { me } from '../auth/plugin.js';
import { parse } from '../lib/validate.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../services/audit.js';

const permissionStatus = z.enum(['granted', 'denied', 'limited', 'undetermined', 'unavailable']);
const deviceBody = z.object({
  platform: z.enum(['ios', 'android', 'web']),
  model: z.string().max(120).optional(),
  appVersion: z.string().max(40).optional(),
  pushToken: z.string().max(300).nullable().optional(),
  pushProvider: z.enum(['expo', 'fcm', 'apns']).optional(),
  /** What this device can actually do (see MOBILE_PERMISSIONS.md / PhoneUsageProvider). */
  capabilities: z
    .record(z.string().max(60), z.union([z.string().max(60), z.boolean(), z.number()]))
    .refine((o) => Object.keys(o).length <= 30, 'Too many capabilities')
    .optional(),
  permissions: z
    .record(z.string().max(60), permissionStatus)
    .refine((o) => Object.keys(o).length <= 20, 'Too many permissions')
    .optional(),
});

export function deviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: app.requireAuth };

  const savePermissions = async (
    deviceId: string,
    perms: Record<string, string> | undefined,
    userId: string,
  ) => {
    if (!perms) return;
    for (const [name, status] of Object.entries(perms)) {
      const prev = await ctx.db.query<{ status: string }>(
        'SELECT status FROM permissions WHERE device_id = $1 AND name = $2',
        [deviceId, name],
      );
      if (prev.rows[0]?.status === status) continue;
      await ctx.db.query(
        `INSERT INTO permissions (device_id, name, status) VALUES ($1, $2, $3)
         ON CONFLICT (device_id, name) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
        [deviceId, name.slice(0, 60), status],
      );
      await audit(ctx.db, {
        actorId: userId,
        action: 'device.permission_change',
        targetType: 'device',
        targetId: deviceId,
        details: { name, status, previous: prev.rows[0]?.status ?? null },
      });
    }
  };

  app.post('/devices', auth, async (req) => {
    const b = parse(deviceBody, req.body);
    const r = await ctx.db.query<{ id: string }>(
      `INSERT INTO devices (user_id, platform, model, app_version, push_token, push_provider, capabilities, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
      [
        me(req).id,
        b.platform,
        b.model ?? null,
        b.appVersion ?? null,
        b.pushToken ?? null,
        b.pushProvider ?? null,
        b.capabilities ?? {},
      ],
    );
    const deviceId = (r.rows[0] as { id: string }).id;
    await savePermissions(deviceId, b.permissions, me(req).id);
    return { id: deviceId };
  });

  app.patch('/devices/:id', auth, async (req) => {
    const p = parse(z.object({ id: z.string().uuid() }), req.params);
    const b = parse(deviceBody.partial(), req.body);
    const r = await ctx.db.query(
      `UPDATE devices SET model = coalesce($3, model), app_version = coalesce($4, app_version),
         push_token = CASE WHEN $5::boolean THEN $6 ELSE push_token END, push_provider = coalesce($7, push_provider),
         capabilities = coalesce($8, capabilities), last_seen_at = now()
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [
        p.id,
        me(req).id,
        b.model ?? null,
        b.appVersion ?? null,
        b.pushToken !== undefined,
        b.pushToken ?? null,
        b.pushProvider ?? null,
        b.capabilities ?? null,
      ],
    );
    if (!r.rowCount) throw notFound('Device not found');
    await savePermissions(p.id, b.permissions, me(req).id);
    return { ok: true };
  });

  app.get('/me/devices', auth, async (req) => {
    const { rows } = await ctx.db.query(
      `SELECT d.id, d.platform, d.model, d.app_version AS "appVersion", d.last_seen_at AS "lastSeenAt",
              d.push_token IS NOT NULL AS "pushReady", d.capabilities,
              (SELECT json_object_agg(p.name, p.status) FROM permissions p WHERE p.device_id = d.id) AS permissions
       FROM devices d WHERE d.user_id = $1 AND d.revoked_at IS NULL ORDER BY d.created_at`,
      [me(req).id],
    );
    return rows;
  });

  app.delete('/devices/:id', auth, async (req) => {
    const p = parse(z.object({ id: z.string().uuid() }), req.params);
    await ctx.db.query(
      'UPDATE devices SET revoked_at = now(), push_token = NULL WHERE id = $1 AND user_id = $2',
      [p.id, me(req).id],
    );
    await ctx.db.query(
      'UPDATE device_sessions SET revoked_at = now() WHERE device_id = $1 AND user_id = $2 AND revoked_at IS NULL',
      [p.id, me(req).id],
    );
    return { ok: true };
  });
}
