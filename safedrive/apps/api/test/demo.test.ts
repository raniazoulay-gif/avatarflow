import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeApp, register, resetDatabase, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  await resetDatabase();
  t = await makeApp();
});
afterAll(async () => t.close());

const waitFor = async (fn: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
};

describe('Demo Mode (no vehicle, no real GPS, no external APIs)', () => {
  it('runs the full escalation scenario through the real pipeline, labelled as demo', async () => {
    const parent = await register(t.app, 'Demo parent');
    const fam = await parent.post('/demo/families');
    expect(fam.status).toBe(200);
    const run = await parent.post('/demo/runs', {
      driverId: fam.body.driverId,
      scenarioId: 'full',
      speedFactor: 20,
    });
    expect(run.status).toBe(200);
    const done = await waitFor(
      async () =>
        (await parent.get('/demo/runs')).body.find((r: any) => r.id === run.body.id)?.status ===
        'finished',
    );
    expect(done).toBe(true);
    const trip = await parent.get(`/trips/${run.body.tripId}`);
    expect(trip.body.isDemo).toBe(true);
    expect(trip.body.state).toBe('COMPLETED');
    expect(trip.body.speedingEvents).toHaveLength(1);
    expect(trip.body.speedingEvents[0]).toMatchObject({
      severity: 'CRITICAL',
      limitSource: 'demo-simulated',
    });
    expect(trip.body.counts.hardBraking).toBeGreaterThanOrEqual(1);
    const types = (await parent.get('/notifications')).body.items.map((n: any) => n.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'TRIP_STARTED',
        'SPEEDING_ATTENTION',
        'SPEEDING_WARNING',
        'SPEEDING_CRITICAL',
        'TRIP_ENDED',
      ]),
    );
    // Demo trips never affect the driver's real score
    expect((await parent.get(`/drivers/${fam.body.driverId}`)).body.safetyScore).toBeNull();
    // External speed-limit providers were not called for demo data
    expect(t.provider.calls).toBe(0);
  }, 30_000);

  it('9-second burst creates no event; degraded scenario survives network/GPS loss and missing limits', async () => {
    const parent = await register(t.app, 'Demo parent 2');
    const fam = await parent.post('/demo/families');
    const r1 = await parent.post('/demo/runs', {
      driverId: fam.body.driverId,
      scenarioId: 'short-burst',
      speedFactor: 20,
    });
    await waitFor(
      async () =>
        (await parent.get('/demo/runs')).body.find((r: any) => r.id === r1.body.id)?.status ===
        'finished',
    );
    expect((await parent.get(`/trips/${r1.body.tripId}`)).body.speedingEvents).toHaveLength(0);

    const r2 = await parent.post('/demo/runs', {
      driverId: fam.body.driverId,
      scenarioId: 'degraded',
      speedFactor: 20,
    });
    await waitFor(
      async () =>
        (await parent.get('/demo/runs')).body.find((r: any) => r.id === r2.body.id)?.status ===
        'finished',
    );
    const trip = await parent.get(`/trips/${r2.body.tripId}`);
    expect(trip.body.speedingEvents).toHaveLength(0); // 125 km/h with no limit = no false violation
    expect(trip.body.counts.hardAcceleration).toBeGreaterThanOrEqual(1);
    const pts = await parent.get(`/trips/${r2.body.tripId}/points`);
    expect(pts.body.length).toBe(79); // 94 seconds minus 15 s of GPS loss; offline points were synced later
  }, 40_000);

  it('demo runs are only allowed for demo families', async () => {
    const parent = await register(t.app, 'Real parent');
    const fam = await parent.post('/families', { name: 'Real' });
    const inv = await parent.post(`/families/${fam.body.id}/invites`, {
      role: 'DRIVER',
      displayName: 'Kid',
    });
    const kid = await register(t.app, 'Kid');
    const j = await kid.post('/invites/accept', { code: inv.body.code, consent: true });
    expect(
      (await parent.post('/demo/runs', { driverId: j.body.driverId, scenarioId: 'full' })).status,
    ).toBe(400);
  });
});
