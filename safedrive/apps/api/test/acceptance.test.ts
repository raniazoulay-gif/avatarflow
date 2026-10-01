/**
 * Final acceptance flow (spec section 57), end to end through HTTP + WebSocket:
 * parent creates family -> driver joins with consent -> START DRIVING -> parent is
 * notified -> GPS -> speeding confirmed after 10 s -> escalations -> recovery ->
 * trip end -> history/summary/score -> SOS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  makeApp,
  makePoints,
  repeat,
  resetDatabase,
  setupFamily,
  type TestApp,
  type FamilySetup,
} from './helpers.js';

let t: TestApp;
let f: FamilySetup;
let wsUrl: string;

beforeAll(async () => {
  await resetDatabase();
  t = await makeApp();
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = t.app.server.address();
  wsUrl = `ws://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/ws`;
  f = await setupFamily(t.app, 'Romi');
});

afterAll(async () => {
  await t.close();
});

function openWs(
  token: string,
): Promise<{ ws: WebSocket; messages: Array<{ type: string; data: any }> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const messages: Array<{ type: string; data: any }> = [];
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'ready') resolve({ ws, messages });
      else messages.push(m);
    });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('error', reject);
  });
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return cond();
};

describe('acceptance: full family driving flow', () => {
  let tripId: string;
  let live: { ws: WebSocket; messages: Array<{ type: string; data: any }> };

  it('parent connects to the live channel', async () => {
    live = await openWs(f.parent.token);
    expect(live.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('driver presses START DRIVING and the parent is notified', async () => {
    const r = await f.driver.post('/trips/start', { driverId: f.driverId, deviceId: f.deviceId });
    expect(r.status).toBe(200);
    tripId = r.body.tripId;
    expect(r.body.state).toBe('ACTIVE');
    expect(await until(() => live.messages.some((m) => m.type === 'trip.started'))).toBe(true);
    const n = await f.parent.get('/notifications');
    expect(n.body.items[0].type).toBe('TRIP_STARTED');
    expect(n.body.items[0].body).toBe('Romi התחיל/ה לנהוג');
    // a second START while driving is refused
    expect((await f.driver.post('/trips/start', { driverId: f.driverId })).status).toBe(409);
  });

  it('driving, then speeding for 9 s creates nothing; 10 s creates ONE ATTENTION event', async () => {
    const t0 = Date.now() - 200_000;
    let r = await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(20, 90), { startSeq: 1, startT: t0 }),
    });
    expect(r.status).toBe(200);
    expect(r.body.accepted).toHaveLength(20);
    expect(r.body.live.limitKmh).toBe(100);
    // 9 seconds over (10 samples) then back under
    r = await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints([...repeat(10, 115), 95], { startSeq: 21, startT: t0 + 20_000 }),
    });
    let detail = await f.parent.get(`/trips/${tripId}`);
    expect(detail.body.speedingEvents).toHaveLength(0);
    // now 12 seconds continuous at 115 (15% over)
    r = await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(12, 115), { startSeq: 32, startT: t0 + 31_000 }),
    });
    expect(r.body.live.severity).toBe('ATTENTION');
    expect(r.body.live.state).toBe('ATTENTION');
    detail = await f.parent.get(`/trips/${tripId}`);
    expect(detail.body.speedingEvents).toHaveLength(1);
    expect(detail.body.speedingEvents[0]).toMatchObject({
      status: 'OPEN',
      severity: 'ATTENTION',
      speedLimitKmh: 100,
    });
    expect(await until(() => live.messages.some((m) => m.type === 'speeding.started'))).toBe(true);
    const n = await f.parent.get('/notifications');
    expect(n.body.items.some((x: any) => x.type === 'SPEEDING_ATTENTION')).toBe(true);
  });

  it('escalates to WARNING and CRITICAL with one notification each, no spam', async () => {
    const t0 = Date.now() - 200_000 + 43_000;
    await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(8, 135), { startSeq: 44, startT: t0 }),
    });
    await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(8, 156), { startSeq: 52, startT: t0 + 8000 }),
    });
    const n = await f.parent.get('/notifications');
    const types = n.body.items.map((x: any) => x.type);
    expect(types.filter((x: string) => x === 'SPEEDING_WARNING')).toHaveLength(1);
    expect(types.filter((x: string) => x === 'SPEEDING_CRITICAL')).toHaveLength(1);
    const crit = n.body.items.find((x: any) => x.type === 'SPEEDING_CRITICAL');
    expect(crit.priority).toBe('critical');
    expect(crit.sound).toBe(true);
    expect(crit.body).toContain('מסוכן'); // severity rendered in the parent's language
    const liveTrips = await f.parent.get(`/families/${f.familyId}/live`);
    expect(liveTrips.body[0]).toMatchObject({
      severity: 'CRITICAL',
      state: 'CRITICAL',
      limitKmh: 100,
    });
    expect(liveTrips.body[0].speedingSeconds).toBeGreaterThanOrEqual(25);
  });

  it('slowing down closes the event with a full summary', async () => {
    const t0 = Date.now() - 200_000 + 59_000;
    const r = await f.driver.post(`/trips/${tripId}/telemetry`, {
      points: makePoints(repeat(10, 90), { startSeq: 60, startT: t0 }),
    });
    expect(r.body.live.severity).toBe('SAFE');
    expect(r.body.live.state).toBe('ACTIVE');
    const detail = await f.parent.get(`/trips/${tripId}`);
    const ev = detail.body.speedingEvents[0];
    expect(ev).toMatchObject({
      status: 'CLOSED',
      severity: 'CRITICAL',
      maxSpeedKmh: 156,
      maxExcessKmh: 56,
      maxExcessPct: 56,
      endReason: 'recovered',
    });
    expect(ev.durationSec).toBe(28); // 12+8+8 samples over the limit, closed at the first sample back under
    const n = await f.parent.get('/notifications');
    expect(
      n.body.items.some((x: any) => x.type === 'SPEEDING_ENDED' && x.body.includes('00:28')),
    ).toBe(true);
  });

  it('driver ends the trip; summary, history and score are available to the parent', async () => {
    const r = await f.driver.post(`/trips/${tripId}/stop`);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('COMPLETED');
    const detail = await f.parent.get(`/trips/${tripId}`);
    expect(detail.body).toMatchObject({
      state: 'COMPLETED',
      maxSpeedKmh: 156,
      counts: { speeding: 1, critical: 1 },
    });
    expect(detail.body.distanceM).toBeGreaterThan(1500);
    expect(detail.body.score).toBeLessThan(100);
    expect(detail.body.scoreBreakdown.speeding).toBeLessThan(0);
    expect(detail.body.events.map((e: any) => e.type)).toEqual(
      expect.arrayContaining(['TRIP_STARTED', 'SPEEDING', 'TRIP_ENDED']),
    );
    const pts = await f.parent.get(`/trips/${tripId}/points`);
    expect(pts.body.length).toBe(69);
    expect(pts.body[0]).toHaveProperty('limitKmh', 100);
    const hist = await f.parent.get(`/drivers/${f.driverId}/trips`);
    expect(hist.body[0]).toMatchObject({ id: tripId, speedingCount: 1, criticalCount: 1 });
    const drv = await f.parent.get(`/drivers/${f.driverId}`);
    expect(drv.body.safetyScore).toBe(detail.body.score);
    expect(await until(() => live.messages.some((m) => m.type === 'trip.ended'))).toBe(true);
  });

  it('driver triggers SOS; parent receives a critical alert and can acknowledge', async () => {
    const r = await f.driver.post('/sos', {
      clientId: crypto.randomUUID(),
      driverId: f.driverId,
      lat: 32.1,
      lon: 34.8,
      speedMs: 0,
    });
    expect(r.status).toBe(200);
    expect(await until(() => live.messages.some((m) => m.type === 'sos'))).toBe(true);
    const n = await f.parent.get('/notifications');
    const sos = n.body.items.find((x: any) => x.type === 'SOS');
    expect(sos).toMatchObject({ priority: 'critical', sound: true });
    const list = await f.parent.get(`/families/${f.familyId}/sos`);
    expect(list.body[0]).toMatchObject({ status: 'OPEN', lat: 32.1 });
    expect((await f.parent.post(`/sos/${r.body.id}/ack`)).status).toBe(200);
    expect((await f.parent.get(`/families/${f.familyId}/sos`)).body[0].status).toBe('ACKNOWLEDGED');
    live.ws.close();
  });

  it('push notifications are delivered by the worker', async () => {
    const res = await t.ctx.notifications.deliverPending(100);
    expect(res.sent).toBeGreaterThan(3);
    expect(
      t.push.sent.some((m) => m.token === 'ExponentPushToken[parent]' && m.priority === 'critical'),
    ).toBe(true);
  });
});
