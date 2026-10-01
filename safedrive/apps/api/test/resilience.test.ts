import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  FakeSpeedLimitProvider,
  makeApp,
  makePoints,
  register,
  repeat,
  resetDatabase,
  setupFamily,
  type FamilySetup,
  type TestApp,
} from './helpers.js';
import {
  autoEndTrips,
  detectOffline,
  applyRetention,
  ensurePartitions,
} from '../src/workers/jobs.js';
import { buildApp } from '../src/app.js';
import { testEnv } from './helpers.js';

let t: TestApp;
let f: FamilySetup;

beforeAll(async () => {
  await resetDatabase();
  t = await makeApp();
});
afterAll(async () => t.close());

beforeEach(async () => {
  f = await setupFamily(t.app);
  t.provider.limitAt = () => 100;
  t.provider.fail = false;
});

const start = async () =>
  (await f.driver.post('/trips/start', { driverId: f.driverId, deviceId: f.deviceId })).body
    .tripId as string;

describe('duplicates and ordering (offline queue retries)', () => {
  it('re-sending the same batch is acknowledged as duplicates and never double-counts', async () => {
    const tripId = await start();
    const pts = makePoints(repeat(15, 130));
    const r1 = await f.driver.post(`/trips/${tripId}/telemetry`, { points: pts });
    const r2 = await f.driver.post(`/trips/${tripId}/telemetry`, { points: pts });
    expect(r1.body.accepted).toHaveLength(15);
    expect(r2.body.accepted).toHaveLength(0);
    expect(r2.body.duplicates).toHaveLength(15);
    const d = await f.parent.get(`/trips/${tripId}`);
    expect(d.body.speedingEvents).toHaveLength(1);
    const n = (await f.parent.get('/notifications')).body.items.filter(
      (x: any) => x.tripId === tripId && x.type.startsWith('SPEEDING_'),
    );
    expect(n).toHaveLength(1);
  });

  it('concurrent uploads of overlapping batches are serialised per trip', async () => {
    const tripId = await start();
    const pts = makePoints(repeat(30, 130));
    await Promise.all([
      f.driver.post(`/trips/${tripId}/telemetry`, { points: pts.slice(0, 20) }),
      f.driver.post(`/trips/${tripId}/telemetry`, { points: pts.slice(10, 30) }),
      f.driver.post(`/trips/${tripId}/telemetry`, { points: pts }),
    ]);
    const d = await f.parent.get(`/trips/${tripId}`);
    expect(d.body.speedingEvents).toHaveLength(1);
    expect((await f.parent.get(`/trips/${tripId}/points`)).body).toHaveLength(30);
  });

  it('delayed telemetry (synced after a network outage) keeps device timestamps', async () => {
    const tripId = await start();
    const t0 = Date.now() - 600_000; // recorded 10 minutes ago, uploaded now
    await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(12, 125), { startT: t0 }),
    });
    const d = await f.parent.get(`/trips/${tripId}`);
    expect(new Date(d.body.speedingEvents[0].startTime).getTime()).toBe(t0);
  });

  it('accepts late points after the trip ended without re-running alerts', async () => {
    const tripId = await start();
    await f.driver.post(`/trips/${tripId}/telemetry`, { points: makePoints(repeat(5, 50)) });
    await f.driver.post(`/trips/${tripId}/stop`);
    const late = await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(15, 160), { startSeq: 6 }),
    });
    expect(late.status).toBe(200);
    expect((await f.parent.get(`/trips/${tripId}`)).body.speedingEvents).toHaveLength(0);
  });
});

describe('unreliable inputs never create false violations', () => {
  it('speed limit unavailable -> no violation, state SPEED_LIMIT_UNAVAILABLE', async () => {
    t.provider.limitAt = () => null;
    const tripId = await start();
    const r = await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(20, 160), { lat: 33.0 }),
    });
    expect(r.body.live.state).toBe('SPEED_LIMIT_UNAVAILABLE');
    expect(r.body.live.limitKmh).toBeNull();
    expect((await f.parent.get(`/trips/${tripId}`)).body.speedingEvents).toHaveLength(0);
  });

  it('provider failure degrades to "unavailable" and is visible in health', async () => {
    t.provider.fail = true;
    const tripId = await start();
    const r = await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(20, 160), { lat: 33.5 }),
    });
    expect(r.status).toBe(200);
    expect((await f.parent.get(`/trips/${tripId}`)).body.speedingEvents).toHaveLength(0);
    const h = t.ctx.speedLimits.providerHealth().find((p) => p.id === 'fake')!;
    expect(h.errors).toBeGreaterThan(0);
    expect(h.lastError).toBe('provider down');
  });

  it('inaccurate GPS -> no violation, state LOCATION_UNAVAILABLE', async () => {
    const tripId = await start();
    const r = await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(20, 160), { accuracyM: 300 }),
    });
    expect(r.body.live.state).toBe('LOCATION_UNAVAILABLE');
    expect((await f.parent.get(`/trips/${tripId}`)).body.speedingEvents).toHaveLength(0);
  });

  it('caches speed limits instead of calling the provider for every point', async () => {
    const p = new FakeSpeedLimitProvider(() => 90);
    const app2 = await makeApp(p);
    const g = await setupFamily(app2.app);
    const tripId = (await g.driver.post('/trips/start', { driverId: g.driverId })).body.tripId;
    // 60 points over ~500 m: lookups only every 40 m / 15 s, plus cell caching
    await g.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(60, 30), { lat: 31.5 }),
    });
    expect(p.calls).toBeLessThanOrEqual(6);
    const before = p.calls;
    const trip2 = await g.driver.post(`/trips/${tripId}/stop`);
    expect(trip2.status).toBe(200);
    const t3 = (await g.driver.post('/trips/start', { driverId: g.driverId })).body.tripId;
    await g.driver.post(`/trips/${t3}/telemetry`, {
      points: makePoints(repeat(60, 30), { lat: 31.5 }),
    });
    expect(p.calls).toBe(before); // same road again: served from cache
    await app2.close();
  });
});

describe('restarts and multiple instances', () => {
  it('engine state survives a server restart: the 10 s window continues on another instance', async () => {
    const tripId = await start();
    const t0 = Date.now() - 60_000;
    await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(6, 130), { startT: t0 }),
    });
    const other = await buildApp({
      env: testEnv(),
      speedLimitProviders: [t.provider],
      logger: false,
    });
    await other.app.ready();
    const r = await other.app.inject({
      method: 'POST',
      url: `/trips/${tripId}/telemetry`,
      headers: { authorization: `Bearer ${f.driver.token}` },
      payload: {
        points: makePoints(repeat(6, 130), { startSeq: 7, startT: t0 + 6000, lat: 32.002 }),
      },
    });
    expect(JSON.parse(r.body).live.severity).toBe('WARNING');
    expect((await f.parent.get(`/trips/${tripId}`)).body.speedingEvents).toHaveLength(1);
    await other.close();
  });
});

describe('background jobs', () => {
  it('marks a silent driver offline once and notifies parents', async () => {
    const tripId = await start();
    await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(3, 40), { startT: Date.now() - 600_000 }),
    });
    expect(await detectOffline(t.ctx)).toBeGreaterThanOrEqual(1);
    expect(await detectOffline(t.ctx)).toBe(0);
    const n = (await f.parent.get('/notifications')).body.items;
    expect(n.some((x: any) => x.type === 'DRIVER_OFFLINE' && x.tripId === tripId)).toBe(true);
    const live = (await f.parent.get(`/families/${f.familyId}/live`)).body;
    expect(live[0].connection).toBe('offline');
  });

  it('auto-ends trips silent for too long', async () => {
    const tripId = await start();
    await t.ctx.db.query(`UPDATE trips SET started_at = now() - interval '2 hours' WHERE id = $1`, [
      tripId,
    ]);
    expect(await autoEndTrips(t.ctx)).toBeGreaterThanOrEqual(1);
    expect((await f.parent.get(`/trips/${tripId}`)).body.state).toBe('COMPLETED');
  });

  it('applies raw telemetry retention but keeps trip summaries', async () => {
    const tripId = await start();
    await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(5, 50), { startT: Date.now() - 60 * 86_400_000 }),
    });
    await f.driver.post(`/trips/${tripId}/stop`);
    const res = await applyRetention(t.ctx);
    expect(res.telemetryPoints).toBeGreaterThanOrEqual(5);
    expect((await f.parent.get(`/trips/${tripId}/points`)).body).toHaveLength(0);
    expect((await f.parent.get(`/trips/${tripId}`)).status).toBe(200);
  });

  it('creates monthly telemetry partitions idempotently', async () => {
    await ensurePartitions(t.ctx, new Date('2030-01-15T00:00:00Z'));
    await ensurePartitions(t.ctx, new Date('2030-01-15T00:00:00Z'));
    const r = await t.ctx.db.query(
      `SELECT count(*)::int AS n FROM pg_tables WHERE tablename LIKE 'telemetry_points_y2030m0%'`,
    );
    expect(r.rows[0].n).toBe(3);
  });

  it('push: a permanently invalid token is removed', async () => {
    const tripId = await start();
    expect(tripId).toBeTruthy();
    t.push.send = async (msgs) =>
      msgs.map(() => ({ ok: false as const, error: 'DeviceNotRegistered', permanent: true }));
    await t.ctx.notifications.deliverPending(200);
    const tokens = await t.ctx.db.query(
      `SELECT count(*)::int AS n FROM devices WHERE user_id = $1 AND push_token IS NOT NULL`,
      [f.parent.userId],
    );
    expect(tokens.rows[0].n).toBe(0);
  });
});

describe('remote monitoring requests (never covert)', () => {
  it('parent requests, driver sees it, starting the trip activates it', async () => {
    const req = await f.parent.post(`/drivers/${f.driverId}/monitoring-requests`);
    expect(req.body.status).toBe('REQUESTED');
    const mine = await f.driver.get('/me/monitoring-requests');
    expect(mine.body[0].id).toBe(req.body.id);
    expect((await f.driver.get('/notifications')).body.items[0].type).toBe('MONITORING_REQUEST');
    const trip = await f.driver.post('/trips/start', {
      driverId: f.driverId,
      monitoringRequestId: req.body.id,
    });
    expect(trip.body.state).toBe('REMOTE_MONITORING_ACTIVE');
    const drivers = await f.parent.get(`/families/${f.familyId}/drivers`);
    expect(drivers.body[0].lastMonitoringRequest.status).toBe('ACTIVE');
  });

  it('driver can decline or report missing permission; no device = UNAVAILABLE', async () => {
    const req = await f.parent.post(`/drivers/${f.driverId}/monitoring-requests`);
    expect(
      (
        await f.driver.post(`/monitoring-requests/${req.body.id}/respond`, {
          status: 'PERMISSION_REQUIRED',
        })
      ).body.status,
    ).toBe('PERMISSION_REQUIRED');
    const p = await register(t.app, 'P2');
    const fam = await p.post('/families', { name: 'NoDevice' });
    const inv = await p.post(`/families/${fam.body.id}/invites`, {
      role: 'DRIVER',
      displayName: 'K',
    });
    const k = await register(t.app, 'K');
    const j = await k.post('/invites/accept', { code: inv.body.code, consent: true });
    expect((await p.post(`/drivers/${j.body.driverId}/monitoring-requests`)).body.status).toBe(
      'UNAVAILABLE',
    );
  });
});

describe('preferences, client events and account deletion', () => {
  it('a parent can mute ATTENTION but SOS always comes through', async () => {
    await f.parent.put(`/families/${f.familyId}/notification-preferences`, {
      minSpeedingSeverity: 'WARNING',
      disabledTypes: ['SOS'],
    });
    const tripId = await start();
    await f.driver.post(`/trips/${tripId}/telemetry`, { points: makePoints(repeat(15, 115)) });
    await f.driver.post('/sos', { clientId: randomUUID(), driverId: f.driverId });
    const types = (await f.parent.get('/notifications')).body.items.map((x: any) => x.type);
    expect(types).not.toContain('SPEEDING_ATTENTION');
    expect(types).toContain('SOS');
  });

  it('phone-usage events (from capable devices) affect the score; duplicates ignored', async () => {
    const tripId = await start();
    const ev = {
      clientId: randomUUID(),
      type: 'PHONE_USAGE',
      at: Date.now(),
      data: { kind: 'app_foreground_while_moving' },
    };
    expect((await f.driver.post(`/trips/${tripId}/events`, ev)).body.created).toBe(true);
    expect((await f.driver.post(`/trips/${tripId}/events`, ev)).body.created).toBe(false);
    const d = await f.parent.get(`/trips/${tripId}`);
    expect(d.body.scoreBreakdown.phoneUsage).toBe(-3);
    expect(d.body.score).toBe(97);
  });

  it('account deletion removes personal data and location history', async () => {
    const tripId = await start();
    await f.driver.post(`/trips/${tripId}/telemetry`, { points: makePoints(repeat(5, 50)) });
    expect((await f.driver.del('/me', { password: 'wrong-pass-1' })).status).toBe(401);
    expect((await f.driver.del('/me', { password: 'Passw0rd-123' })).status).toBe(200);
    expect((await f.driver.get('/me')).status).toBe(401);
    const pts = await t.ctx.db.query(
      'SELECT count(*)::int AS n FROM telemetry_points WHERE trip_id = $1',
      [tripId],
    );
    expect(pts.rows[0].n).toBe(0);
    const u = await t.ctx.db.query('SELECT email, display_name FROM users WHERE id = $1', [
      f.driver.userId,
    ]);
    expect(u.rows[0].display_name).toBe('deleted');
  });
});

describe('rate limiting', () => {
  it('login is rate limited by default', async () => {
    const app = await buildApp({
      env: testEnv({ AUTH_RATE_LIMIT_PER_MINUTE: '10' }),
      speedLimitProviders: [],
      logger: false,
    });
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (
        await app.app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'x@y.test', password: 'p' },
        })
      ).statusCode;
    }
    expect(last).toBe(429);
    await app.close();
  });
});
