/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { type AppContext } from '../src/context.js';
import { LogPushProvider } from '../src/providers/push/push.js';
import { type SpeedLimitProvider, type SpeedLimitQuery, type SpeedLimitResult } from '../src/providers/speed-limit/types.js';
import { clearConfigCache } from '../src/services/app-config.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://safedrive:safedrive@localhost:5432/safedrive_test';

export function testEnv(extra: Record<string, string> = {}) {
  return loadEnv({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    JWT_SECRET: 'test-secret-test-secret-test-secret-0123',
    SPEED_LIMIT_PROVIDERS: '',
    PUSH_PROVIDER: 'log',
    DEMO_MODE_ENABLED: 'true',
    RATE_LIMIT_PER_MINUTE: '100000',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@safedrive.test',
    ...extra,
  });
}

/** Fake vendor: a limit function of the position, counts calls, can fail on demand. */
export class FakeSpeedLimitProvider implements SpeedLimitProvider {
  readonly id = 'fake';
  calls = 0;
  fail = false;
  constructor(public limitAt: (q: SpeedLimitQuery) => number | null = () => 100) {}
  available(): boolean {
    return true;
  }
  async lookup(q: SpeedLimitQuery): Promise<SpeedLimitResult | null> {
    this.calls += 1;
    if (this.fail) throw new Error('provider down');
    const kmh = this.limitAt(q);
    return kmh === null
      ? null
      : { limitKmh: kmh, confidence: 0.9, source: 'fake', roadName: 'Route 1', externalId: null, country: 'IL', region: null };
  }
}

export async function resetDatabase(): Promise<void> {
  const pool = new pg.Pool({ connectionString: TEST_DB, max: 1 });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  await pool.end();
  clearConfigCache();
}

export interface TestApp {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
  push: LogPushProvider;
  provider: FakeSpeedLimitProvider;
}

export async function makeApp(provider = new FakeSpeedLimitProvider(), env: Record<string, string> = {}): Promise<TestApp> {
  const push = new LogPushProvider();
  const built = await buildApp({ env: testEnv(env), push, speedLimitProviders: [provider], logger: false });
  await built.app.ready();
  return { ...built, push, provider };
}

export interface Client {
  token: string;
  refreshToken: string;
  userId: string;
  get: <T = any>(url: string) => Promise<{ status: number; body: T }>;
  post: <T = any>(url: string, body?: unknown) => Promise<{ status: number; body: T }>;
  put: <T = any>(url: string, body?: unknown) => Promise<{ status: number; body: T }>;
  del: <T = any>(url: string, body?: unknown) => Promise<{ status: number; body: T }>;
}

export function client(app: FastifyInstance, token: string, refreshToken = '', userId = ''): Client {
  const call = async (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) => {
    const r = await app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };
  return {
    token,
    refreshToken,
    userId,
    get: (u) => call('GET', u),
    post: (u, b) => call('POST', u, b ?? {}),
    put: (u, b) => call('PUT', u, b ?? {}),
    del: (u, b) => call('DELETE', u, b),
  };
}

export async function register(app: FastifyInstance, name: string, email = `${randomUUID()}@safedrive.test`): Promise<Client> {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: 'Passw0rd-123', displayName: name, locale: 'he' },
  });
  if (r.statusCode !== 200) throw new Error(`register failed ${r.statusCode} ${r.body}`);
  const b = JSON.parse(r.body);
  return client(app, b.accessToken, b.refreshToken, b.user.id);
}

export interface FamilySetup {
  parent: Client;
  driver: Client;
  familyId: string;
  driverId: string;
  deviceId: string;
}

export async function setupFamily(app: FastifyInstance, driverName = 'Romi'): Promise<FamilySetup> {
  const parent = await register(app, 'Parent');
  const fam = await parent.post('/families', { name: 'Azoulay' });
  const inv = await parent.post(`/families/${fam.body.id}/invites`, { role: 'DRIVER', displayName: driverName });
  const driver = await register(app, driverName);
  const joined = await driver.post('/invites/accept', { code: inv.body.code, consent: true });
  if (joined.status !== 200) throw new Error(`join failed ${JSON.stringify(joined.body)}`);
  const dev = await driver.post('/devices', {
    platform: 'android',
    model: 'Pixel',
    pushToken: 'ExponentPushToken[driver]',
    permissions: { locationAlways: 'granted' },
  });
  await parent.post('/devices', { platform: 'ios', pushToken: 'ExponentPushToken[parent]' });
  return { parent, driver, familyId: fam.body.id, driverId: joined.body.driverId, deviceId: dev.body.id };
}

/** 1 Hz points moving north (~speed m/s apart) starting at seq/time. */
export function makePoints(
  speedsKmh: Array<number | null>,
  opts: { startSeq?: number; startT?: number; lat?: number; accuracyM?: number; extra?: Record<string, unknown> } = {},
) {
  let lat = opts.lat ?? 32.0;
  const startSeq = opts.startSeq ?? 1;
  const startT = opts.startT ?? Date.now() - speedsKmh.length * 1000;
  return speedsKmh.map((kmh, i) => {
    const ms = kmh === null ? null : kmh / 3.6;
    lat += (ms ?? 0) / 111_320;
    return {
      id: randomUUID(),
      seq: startSeq + i,
      recordedAt: startT + i * 1000,
      lat,
      lon: 34.8,
      speedMs: ms,
      headingDeg: 0,
      accuracyM: opts.accuracyM ?? 5,
      ...(opts.extra ?? {}),
    };
  });
}

export const repeat = (n: number, v: number): number[] => Array.from({ length: n }, () => v);
