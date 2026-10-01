import { type FastifyInstance } from 'fastify';
import { COUNTRY_PROFILES, DEFAULT_SAFETY_CONFIG, DEMO_SCENARIOS, DEFAULT_TELEMETRY_POLICY } from '@safedrive/core';
import { type AppContext } from '../context.js';
import { unauthorized } from '../lib/errors.js';

export function systemRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', { config: { rateLimit: false } }, async () => ({ status: 'ok', uptimeSec: ctx.metrics.snapshot().uptimeSec }));

  app.get('/health/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await ctx.db.query('SELECT 1');
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  /** Prometheus text format; requires METRICS_TOKEN when set. */
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    if (!ctx.env.METRICS_TOKEN || req.headers.authorization !== `Bearer ${ctx.env.METRICS_TOKEN}`) throw unauthorized();
    return reply.type('text/plain; version=0.0.4').send(ctx.metrics.prometheus());
  });

  /** Public client configuration: map tiles (MapProvider), country profiles, thresholds. */
  app.get('/config/client', async () => ({
    map: { tileUrl: ctx.env.MAP_TILE_URL, attribution: ctx.env.MAP_ATTRIBUTION },
    countries: COUNTRY_PROFILES,
    safety: DEFAULT_SAFETY_CONFIG,
    telemetry: DEFAULT_TELEMETRY_POLICY,
    demo: { enabled: ctx.env.DEMO_MODE_ENABLED, scenarios: DEMO_SCENARIOS.map((s) => ({ id: s.id, name: s.name, description: s.description })) },
    speedLimitProviders: ctx.speedLimitProviders.map((p) => ({ id: p.id, configured: p.available() })),
  }));
}
