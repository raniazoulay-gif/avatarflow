import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../context.js';
import { me } from '../auth/plugin.js';
import { requireParent } from '../auth/access.js';
import { parse } from '../lib/validate.js';

export function notificationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: app.requireAuth };

  app.get('/notifications', auth, async (req) => {
    const q = parse(
      z.object({
        unread: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    const { rows } = await ctx.db.query(
      `SELECT id, type, priority, title, body, data, sound, is_demo AS "isDemo", created_at AS "createdAt", read_at AS "readAt",
              driver_id AS "driverId", trip_id AS "tripId", push_status AS "pushStatus"
       FROM notifications WHERE recipient_id = $1 AND ($2 = false OR read_at IS NULL)
       ORDER BY created_at DESC LIMIT $3`,
      [me(req).id, q.unread === 'true', q.limit],
    );
    const unread = await ctx.db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM notifications WHERE recipient_id = $1 AND read_at IS NULL',
      [me(req).id],
    );
    return { items: rows, unread: unread.rows[0]?.n ?? 0 };
  });

  app.post('/notifications/:id/read', auth, async (req) => {
    const p = parse(z.object({ id: z.string().uuid() }), req.params);
    await ctx.db.query(
      'UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND recipient_id = $2',
      [p.id, me(req).id],
    );
    return { ok: true };
  });

  app.post('/notifications/read-all', auth, async (req) => {
    await ctx.db.query(
      'UPDATE notifications SET read_at = now() WHERE recipient_id = $1 AND read_at IS NULL',
      [me(req).id],
    );
    return { ok: true };
  });

  app.post(
    '/sos',
    { ...auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const b = parse(
        z.object({
          clientId: z.string().uuid(),
          driverId: z.string().uuid(),
          tripId: z.string().uuid().nullable().optional(),
          lat: z.number().min(-90).max(90).nullable().optional(),
          lon: z.number().min(-180).max(180).nullable().optional(),
          accuracyM: z.number().min(0).nullable().optional(),
          speedMs: z.number().min(0).nullable().optional(),
          triggeredAt: z.number().int().optional(),
        }),
        req.body,
      );
      return ctx.sos.trigger(me(req).id, b, req.ip);
    },
  );

  for (const action of ['ack', 'resolve'] as const) {
    app.post(`/sos/:id/${action}`, auth, async (req) => {
      const p = parse(z.object({ id: z.string().uuid() }), req.params);
      await ctx.sos.setStatus(
        me(req).id,
        p.id,
        action === 'ack' ? 'ACKNOWLEDGED' : 'RESOLVED',
        async (familyId) => {
          await requireParent(ctx.db, me(req).id, familyId);
        },
      );
      return { ok: true };
    });
  }
}
