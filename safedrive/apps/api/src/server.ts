import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';
import { migrate } from './db/migrate.js';
import { ensurePartitions, startWorkers } from './workers/jobs.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const { app, ctx, close } = await buildApp({ env });
  const applied = await migrate(ctx.db);
  if (applied.length) app.log.warn(`Applied migrations: ${applied.join(', ')}`);
  await ensurePartitions(ctx);
  const stopWorkers = env.WORKERS_ENABLED ? startWorkers(ctx) : () => undefined;
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.warn(
    `SafeDrive API listening on ${env.HOST}:${env.PORT} (demo mode ${env.DEMO_MODE_ENABLED ? 'ON' : 'OFF'})`,
  );
  const shutdown = async (sig: string) => {
    app.log.warn(`${sig} received, shutting down`);
    stopWorkers();
    await ctx.speedLimits.flushUsage().catch(() => undefined);
    await close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
