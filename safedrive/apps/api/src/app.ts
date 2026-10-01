import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { type Env } from './config/env.js';
import { type AppContext } from './context.js';
import { createPool, type Db } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { type FetchFn } from './lib/http.js';
import { registerAuth } from './auth/plugin.js';
import { TokenService } from './auth/tokens.js';
import { MemoryBus, createRedisBus, type RealtimeBus } from './realtime/bus.js';
import { registerWebSocket } from './realtime/ws.js';
import { OsmOverpassProvider } from './providers/speed-limit/osm.js';
import {
  HereSpeedLimitProvider,
  TomTomSpeedLimitProvider,
} from './providers/speed-limit/commercial.js';
import { type SpeedLimitProvider } from './providers/speed-limit/types.js';
import {
  ExpoPushProvider,
  LogPushProvider,
  NoPushProvider,
  type PushNotificationProvider,
} from './providers/push/push.js';
import { AuthService } from './services/auth.js';
import { DemoService } from './services/demo.js';
import { FamilyService } from './services/families.js';
import { Metrics } from './services/metrics.js';
import { MonitoringService } from './services/monitoring.js';
import { NotificationService } from './services/notifications.js';
import { SosService } from './services/sos.js';
import { SpeedLimitService } from './services/speed-limits.js';
import { TelemetryService } from './services/telemetry.js';
import { TripService } from './services/trips.js';
import { authRoutes } from './routes/auth.js';
import { familyRoutes } from './routes/families.js';
import { driverRoutes } from './routes/drivers.js';
import { deviceRoutes } from './routes/devices.js';
import { tripRoutes } from './routes/trips.js';
import { notificationRoutes } from './routes/notifications.js';
import { adminRoutes } from './routes/admin.js';
import { systemRoutes } from './routes/system.js';
import { demoRoutes } from './routes/demo.js';

export interface BuildOptions {
  env: Env;
  db?: Db;
  bus?: RealtimeBus;
  push?: PushNotificationProvider;
  speedLimitProviders?: SpeedLimitProvider[];
  fetchFn?: FetchFn;
  logger?: boolean;
}

export function buildSpeedLimitProviders(env: Env, fetchFn?: FetchFn): SpeedLimitProvider[] {
  const all: Record<string, SpeedLimitProvider> = {
    here: new HereSpeedLimitProvider(env.HERE_API_KEY, env.PROVIDER_HTTP_TIMEOUT_MS, fetchFn),
    tomtom: new TomTomSpeedLimitProvider(env.TOMTOM_API_KEY, env.PROVIDER_HTTP_TIMEOUT_MS, fetchFn),
    osm: new OsmOverpassProvider(
      env.OVERPASS_URL,
      env.PROVIDER_HTTP_TIMEOUT_MS,
      env.OVERPASS_MIN_INTERVAL_MS,
      `SafeDrive/0.1 (${env.CONTACT_EMAIL})`,
      fetchFn,
    ),
  };
  return env.SPEED_LIMIT_PROVIDERS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => all[id])
    .filter((p): p is SpeedLimitProvider => !!p);
}

function buildPush(env: Env, fetchFn?: FetchFn): PushNotificationProvider {
  if (env.PUSH_PROVIDER === 'expo')
    return new ExpoPushProvider(env.EXPO_ACCESS_TOKEN, env.PROVIDER_HTTP_TIMEOUT_MS, fetchFn);
  if (env.PUSH_PROVIDER === 'none') return new NoPushProvider();
  return new LogPushProvider();
}

export async function buildApp(
  opts: BuildOptions,
): Promise<{ app: FastifyInstance; ctx: AppContext; close: () => Promise<void> }> {
  const { env } = opts;
  const db = opts.db ?? createPool(env.DATABASE_URL, env.DATABASE_POOL_MAX);
  const bus = opts.bus ?? (env.REDIS_URL ? await createRedisBus(env.REDIS_URL) : new MemoryBus());
  const metrics = new Metrics();
  const tokens = new TokenService(env.JWT_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
  const auth = new AuthService(
    db,
    tokens,
    env.ACCESS_TOKEN_TTL_SECONDS,
    env.REFRESH_TOKEN_TTL_DAYS,
    env.BOOTSTRAP_ADMIN_EMAIL,
  );
  const push = opts.push ?? buildPush(env, opts.fetchFn);
  const providers = opts.speedLimitProviders ?? buildSpeedLimitProviders(env, opts.fetchFn);
  const speedLimits = new SpeedLimitService(db, providers, metrics, {
    positiveTtlMs: env.SPEED_LIMIT_CACHE_TTL_DAYS * 86_400_000,
    negativeTtlMs: env.SPEED_LIMIT_NEGATIVE_TTL_HOURS * 3_600_000,
    errorTtlMs: 60_000,
    memoryMax: 20_000,
  });
  const notifications = new NotificationService(db, bus, push, metrics);
  const telemetry = new TelemetryService({
    db,
    speedLimits,
    notifications,
    bus,
    metrics,
    offlineAfterSec: env.OFFLINE_AFTER_SECONDS,
    lookupMinMeters: env.SPEED_LIMIT_LOOKUP_MIN_METERS,
    lookupMinSeconds: env.SPEED_LIMIT_LOOKUP_MIN_SECONDS,
  });
  const trips = new TripService({
    db,
    bus,
    notifications,
    telemetry,
    metrics,
    offlineAfterSec: env.OFFLINE_AFTER_SECONDS,
  });
  const families = new FamilyService(db);
  const monitoring = new MonitoringService(db, bus, notifications);
  const sos = new SosService(db, bus, notifications);
  const ctx: AppContext = {
    env,
    db,
    bus,
    metrics,
    auth,
    families,
    notifications,
    telemetry,
    trips,
    monitoring,
    sos,
    speedLimits,
    speedLimitProviders: providers,
    push,
  };
  const demo = new DemoService({ db, families, trips, telemetry, sos });

  const app = Fastify({
    logger:
      opts.logger === false
        ? false
        : {
            level: env.NODE_ENV === 'production' ? 'info' : 'warn',
            redact: ['req.headers.authorization'],
          },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((s) => s.trim()),
    credentials: false,
  });
  await app.register(rateLimit, { max: env.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute' });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  registerAuth(app, auth);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.status)
        .send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError)
      return reply.code(400).send({ error: 'bad_request', message: 'Invalid request' });
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429)
      return reply.code(429).send({ error: 'too_many_requests', message: (err as Error).message });
    if (status && status < 500)
      return reply.code(status).send({ error: 'bad_request', message: (err as Error).message });
    metrics.inc('http_5xx');
    req.log.error({ err }, 'request failed');
    return reply.code(500).send({ error: 'internal', message: 'Internal server error' });
  });
  app.addHook('onResponse', async (req, reply) => {
    metrics.inc(`http_${Math.floor(reply.statusCode / 100)}xx`);
    metrics.time('http_request', reply.elapsedTime);
    if (req.routeOptions.url === '/trips/:id/telemetry')
      metrics.time('http_telemetry', reply.elapsedTime);
  });

  systemRoutes(app, ctx);
  authRoutes(app, ctx);
  familyRoutes(app, ctx);
  driverRoutes(app, ctx);
  deviceRoutes(app, ctx);
  tripRoutes(app, ctx);
  notificationRoutes(app, ctx);
  adminRoutes(app, ctx);
  demoRoutes(app, ctx, demo);
  registerWebSocket(app, ctx);

  const close = async () => {
    await app.close();
    await bus.close();
    if (!opts.db) await db.end();
  };
  return { app, ctx, close };
}
