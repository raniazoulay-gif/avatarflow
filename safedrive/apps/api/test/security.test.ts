import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  client,
  makeApp,
  makePoints,
  register,
  repeat,
  resetDatabase,
  setupFamily,
  type FamilySetup,
  type TestApp,
} from './helpers.js';

let t: TestApp;
let a: FamilySetup;
let b: FamilySetup;
let tripA: string;

beforeAll(async () => {
  await resetDatabase();
  t = await makeApp();
  a = await setupFamily(t.app, 'Driver A');
  b = await setupFamily(t.app, 'Driver B');
  tripA = (await a.driver.post('/trips/start', { driverId: a.driverId })).body.tripId;
  await a.driver.post(`/trips/${tripA}/telemetry`, { points: makePoints(repeat(5, 50)) });
});

afterAll(async () => t.close());

describe('family-level data isolation', () => {
  it('a parent can never read another family (404, no existence leak)', async () => {
    const p = b.parent;
    expect((await p.get(`/families/${a.familyId}`)).status).toBe(404);
    expect((await p.get(`/families/${a.familyId}/live`)).status).toBe(404);
    expect((await p.get(`/families/${a.familyId}/drivers`)).status).toBe(404);
    expect((await p.get(`/families/${a.familyId}/sos`)).status).toBe(404);
    expect((await p.get(`/drivers/${a.driverId}`)).status).toBe(404);
    expect((await p.get(`/drivers/${a.driverId}/trips`)).status).toBe(404);
    expect((await p.get(`/trips/${tripA}`)).status).toBe(404);
    expect((await p.get(`/trips/${tripA}/points`)).status).toBe(404);
    expect(
      (await p.post(`/families/${a.familyId}/invites`, { role: 'PARENT', displayName: 'x' }))
        .status,
    ).toBe(404);
    expect((await p.post(`/drivers/${a.driverId}/monitoring-requests`)).status).toBe(404);
  });

  it("a driver cannot upload to, stop or report on someone else's trip", async () => {
    expect(
      (await b.driver.post(`/trips/${tripA}/telemetry`, { points: makePoints([50]) })).status,
    ).toBe(400);
    expect((await b.driver.post(`/trips/${tripA}/stop`)).status).toBe(404);
    expect((await b.driver.post('/trips/start', { driverId: a.driverId })).status).toBe(404);
    expect(
      (await b.driver.post('/sos', { clientId: randomUUID(), driverId: a.driverId })).status,
    ).toBe(404);
  });

  it('drivers cannot use parent-only endpoints of their own family', async () => {
    expect((await a.driver.get(`/families/${a.familyId}/live`)).status).toBe(403);
    expect(
      (await a.driver.post(`/families/${a.familyId}/invites`, { role: 'PARENT', displayName: 'x' }))
        .status,
    ).toBe(403);
    // ...but can see their own trips
    expect((await a.driver.get(`/drivers/${a.driverId}/trips`)).status).toBe(200);
  });

  it('realtime notifications are delivered only to the right family', async () => {
    const na = await a.parent.get('/notifications');
    const nb = await b.parent.get('/notifications');
    expect(na.body.items.some((n: any) => n.tripId === tripA)).toBe(true);
    expect(nb.body.items.some((n: any) => n.tripId === tripA)).toBe(false);
  });

  it('non-admins cannot reach the admin API', async () => {
    expect((await a.parent.get('/admin/users')).status).toBe(403);
    expect((await a.parent.get('/admin/health')).status).toBe(403);
  });
});

describe('authentication', () => {
  it('rejects requests without or with a bad token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
    expect((await client(t.app, 'nope').get('/me')).status).toBe(401);
  });

  it('enforces password strength and unique emails', async () => {
    const weak = await t.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'w@x.test', password: 'short', displayName: 'W' },
    });
    expect(weak.statusCode).toBe(400);
    await register(t.app, 'Dup', 'dup@x.test');
    const dup = await t.app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'DUP@x.test', password: 'Passw0rd-123', displayName: 'D' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('rotates refresh tokens and revokes the chain on reuse', async () => {
    const u = await register(t.app, 'Rot');
    const r1 = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: u.refreshToken },
    });
    expect(r1.statusCode).toBe(200);
    const newer = JSON.parse(r1.body);
    // reuse of the old (rotated) token = theft signal -> whole chain revoked
    const reuse = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: u.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    const afterReuse = await t.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: newer.refreshToken },
    });
    expect(afterReuse.statusCode).toBe(401);
    expect((await client(t.app, newer.accessToken).get('/me')).status).toBe(401);
  });

  it('logout revokes the session immediately', async () => {
    const u = await register(t.app, 'Out');
    expect((await u.post('/auth/logout')).status).toBe(200);
    expect((await u.get('/me')).status).toBe(401);
  });

  it('locks the account after repeated failed logins', async () => {
    await register(t.app, 'Lock', 'lock@x.test');
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await t.app.inject({
          method: 'POST',
          url: '/auth/login',
          payload: { email: 'lock@x.test', password: 'wrong-pass-1' },
        })
      ).statusCode;
    }
    expect(last).toBe(429);
    const ok = await t.app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'lock@x.test', password: 'Passw0rd-123' },
    });
    expect(ok.statusCode).toBe(429);
  });

  it('driver joining requires explicit monitoring consent; invite codes are single-use', async () => {
    const p = await register(t.app, 'P');
    const fam = await p.post('/families', { name: 'F' });
    const inv = await p.post(`/families/${fam.body.id}/invites`, {
      role: 'DRIVER',
      displayName: 'Kid',
    });
    const kid = await register(t.app, 'Kid');
    expect(
      (await kid.post('/invites/accept', { code: inv.body.code, consent: false })).status,
    ).toBe(400);
    expect((await kid.post('/invites/accept', { code: inv.body.code, consent: true })).status).toBe(
      200,
    );
    const other = await register(t.app, 'Other');
    expect(
      (await other.post('/invites/accept', { code: inv.body.code, consent: true })).status,
    ).toBe(404);
  });

  it('suspension by an admin ends all sessions', async () => {
    const admin = await register(t.app, 'Admin', 'admin@safedrive.test');
    const victim = await register(t.app, 'Victim');
    expect((await admin.post(`/admin/users/${victim.userId}/suspend`)).status).toBe(200);
    expect((await victim.get('/me')).status).toBe(401);
    const audit = await admin.get('/admin/audit?action=admin.user_suspend');
    expect(audit.body[0].targetId).toBe(victim.userId);
  });
});

describe('input validation', () => {
  it('rejects malformed telemetry and simulated data on real trips', async () => {
    const bad = await a.driver.post(`/trips/${tripA}/telemetry`, {
      points: [{ id: 'x', seq: 1, recordedAt: 0, lat: 999, lon: 0 }],
    });
    expect(bad.status).toBe(400);
    const sim = await a.driver.post(`/trips/${tripA}/telemetry`, {
      points: makePoints([50], { startSeq: 100, extra: { simulatedLimitKmh: 30 } }),
    });
    expect(sim.status).toBe(400);
    const future = await a.driver.post(`/trips/${tripA}/telemetry`, {
      points: makePoints([50], { startSeq: 101, startT: Date.now() + 3_600_000 }),
    });
    expect(future.status).toBe(400);
  });
});
