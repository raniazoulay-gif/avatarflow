import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AppContext } from '../context.js';
import { me } from '../auth/plugin.js';
import { parse } from '../lib/validate.js';
import { forbidden } from '../lib/errors.js';
import { type DemoService } from '../services/demo.js';

export function demoRoutes(app: FastifyInstance, ctx: AppContext, demo: DemoService): void {
  const guard = async () => {
    if (!ctx.env.DEMO_MODE_ENABLED) throw forbidden('Demo mode is disabled on this server');
  };
  const auth = { preHandler: [app.requireAuth, guard] };
  const parentFamilies = async (userId: string) =>
    (
      await ctx.db.query<{ family_id: string }>(
        `SELECT family_id FROM family_members WHERE user_id = $1 AND role = 'PARENT' AND removed_at IS NULL`,
        [userId],
      )
    ).rows.map((r) => r.family_id);

  app.post('/demo/families', auth, async (req) => demo.createDemoFamily(me(req).id));

  app.post('/demo/runs', auth, async (req) => {
    const b = parse(
      z.object({
        driverId: z.string().uuid(),
        scenarioId: z.string().max(40),
        speedFactor: z.number().min(1).max(20).default(1),
      }),
      req.body,
    );
    return demo.start(me(req).id, b.driverId, b.scenarioId, b.speedFactor);
  });

  app.get('/demo/runs', auth, async (req) => demo.list(await parentFamilies(me(req).id)));

  app.post('/demo/runs/:id/cancel', auth, async (req) => {
    const p = parse(z.object({ id: z.string().uuid() }), req.params);
    demo.cancel(p.id, await parentFamilies(me(req).id));
    return { ok: true };
  });
}
