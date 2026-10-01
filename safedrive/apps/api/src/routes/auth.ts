import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../context.js';
import { me } from '../auth/plugin.js';
import { parse } from '../lib/validate.js';
import { publicUser } from '../services/auth.js';

const register = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
  displayName: z.string().trim().min(1).max(80),
  locale: z.enum(['he', 'en']).optional(),
});
const login = z.object({
  email: z.string().max(320),
  password: z.string().max(200),
  deviceId: z.string().uuid().optional(),
});
const refresh = z.object({ refreshToken: z.string().min(10).max(500) });

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const authLimit = {
    config: { rateLimit: { max: ctx.env.AUTH_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' } },
  };

  app.post('/auth/register', authLimit, async (req) => {
    const b = parse(register, req.body);
    return ctx.auth.register(b, { ip: req.ip, userAgent: req.headers['user-agent'] });
  });

  app.post('/auth/login', authLimit, async (req) => {
    const b = parse(login, req.body);
    return ctx.auth.login(b.email, b.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      deviceId: b.deviceId ?? null,
    });
  });

  app.post(
    '/auth/refresh',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const b = parse(refresh, req.body);
      return ctx.auth.refresh(b.refreshToken, { ip: req.ip, userAgent: req.headers['user-agent'] });
    },
  );

  app.post('/auth/logout', { preHandler: app.requireAuth }, async (req) => {
    await ctx.auth.logout(req.auth!.sessionId);
    return { ok: true };
  });

  app.post('/auth/logout-all', { preHandler: app.requireAuth }, async (req) => {
    await ctx.auth.logoutAll(me(req).id);
    return { ok: true };
  });

  app.get('/me', { preHandler: app.requireAuth }, async (req) => {
    const u = me(req);
    return { user: publicUser(u), families: await ctx.families.listForUser(u.id) };
  });

  app.patch('/me', { preHandler: app.requireAuth }, async (req) => {
    const b = parse(
      z.object({
        displayName: z.string().trim().min(1).max(80).optional(),
        locale: z.enum(['he', 'en']).optional(),
      }),
      req.body,
    );
    await ctx.db.query(
      'UPDATE users SET display_name = coalesce($2, display_name), locale = coalesce($3, locale), updated_at = now() WHERE id = $1',
      [me(req).id, b.displayName ?? null, b.locale ?? null],
    );
    return { ok: true };
  });

  /** Account deletion (privacy requirement). Requires the password again. */
  app.delete(
    '/me',
    { preHandler: app.requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const b = parse(z.object({ password: z.string().max(200) }), req.body);
      await ctx.auth.login(me(req).email, b.password, { ip: req.ip });
      await ctx.families.deleteAccount(me(req).id);
      return { ok: true };
    },
  );
}
