import { describe, expect, it } from 'vitest';
import { MemoryQueueStorage, OutboundQueue, type LiveTripView } from '@safedrive/core';
import {
  TripController,
  type Fix,
  type KeyValueStore,
  type LocationSource,
  type PermissionLevel,
  type TripApi,
  type UploadPoint,
} from '../src/lib/trip-controller';

class FakeStore implements KeyValueStore {
  data = new Map<string, string>();
  async get(k: string) {
    return this.data.get(k) ?? null;
  }
  async set(k: string, v: string) {
    this.data.set(k, v);
  }
  async remove(k: string) {
    this.data.delete(k);
  }
}

class FakeLocation implements LocationSource {
  started = 0;
  stopped = 0;
  plans: string[] = [];
  constructor(
    public perm: PermissionLevel = 'background',
    public grantOnRequest: PermissionLevel = 'background',
  ) {}
  async permission() {
    return this.perm;
  }
  async requestPermission() {
    this.perm = this.grantOnRequest;
    return this.perm;
  }
  failStart = false;
  async start() {
    if (this.failStart) throw new Error('location service unavailable');
    this.started += 1;
  }
  async updatePlan(p: { motion: string }) {
    this.plans.push(p.motion);
  }
  async stop() {
    this.stopped += 1;
  }
}

/** In-memory server: idempotent by (trip, seq), like the real API. */
class FakeServer implements TripApi {
  online = true;
  points = new Map<string, Map<number, UploadPoint>>();
  stopped: string[] = [];
  sosCalls: string[] = [];
  events: string[] = [];
  monitoringResponses: string[] = [];
  tripCount = 0;
  private live(tripId: string, severity: LiveTripView['severity'] = 'SAFE'): LiveTripView {
    return {
      tripId,
      driverId: 'd1',
      driverName: 'Romi',
      isDemo: false,
      state: severity === 'SAFE' ? 'ACTIVE' : severity,
      startedAt: '',
      lastUpdateAt: null,
      location: null,
      speedKmh: null,
      limitKmh: 100,
      limitSource: 'test',
      excessKmh: 0,
      excessPct: 0,
      severity,
      speedingSeconds: null,
      confirming: false,
      score: 100,
      connection: 'online',
    };
  }
  private check() {
    if (!this.online) throw new Error('network down');
  }
  /** Simulates an HTTP error with a status (like HttpError in src/lib/api.ts). */
  uploadStatus: number | null = null;
  stopStatus: number | null = null;
  active: (LiveTripView & { lastSeq: number }) | null = null;
  startDelay = 0;
  async startTrip(_input: { driverId: string }) {
    this.check();
    if (this.startDelay) await new Promise((r) => setTimeout(r, this.startDelay));
    this.tripCount += 1;
    return this.live(`trip${this.tripCount}`);
  }
  async stopTrip(id: string) {
    this.check();
    if (this.stopStatus) throw Object.assign(new Error('gone'), { status: this.stopStatus });
    this.stopped.push(id);
    return {};
  }
  async upload(tripId: string, pts: UploadPoint[]) {
    this.check();
    if (this.uploadStatus) throw Object.assign(new Error('refused'), { status: this.uploadStatus });
    const m = this.points.get(tripId) ?? new Map();
    const accepted: string[] = [];
    const duplicates: string[] = [];
    for (const p of pts) ((m.has(p.seq) ? duplicates : accepted).push(p.id), m.set(p.seq, p));
    this.points.set(tripId, m);
    const fast = pts.some((p) => (p.speedMs ?? 0) * 3.6 > 130);
    return { accepted, duplicates, live: this.live(tripId, fast ? 'WARNING' : 'SAFE') };
  }
  async reportEvent(_t: string, e: { type: string }) {
    this.check();
    this.events.push(e.type);
    return {};
  }
  async sos(i: { clientId: string }) {
    this.check();
    this.sosCalls.push(i.clientId);
    return {};
  }
  async activeTrip() {
    this.check();
    return this.active;
  }
  async respondMonitoring(_id: string, status: string) {
    this.monitoringResponses.push(status);
    return {};
  }
}

function setup(opts: { perm?: PermissionLevel; grant?: PermissionLevel } = {}) {
  const server = new FakeServer();
  const store = new FakeStore();
  const storage = new MemoryQueueStorage<UploadPoint>();
  let n = 0;
  let now = 1_000_000;
  const loc = new FakeLocation(opts.perm ?? 'background', opts.grant ?? 'background');
  const make = () =>
    new TripController({
      api: server,
      location: loc,
      queue: new OutboundQueue(storage, {
        now: () => now,
        baseBackoffMs: 0,
        idFactory: () => `p${++n}`,
      }),
      store,
      isOnline: () => server.online,
      battery: () => ({ level: 0.8, charging: false }),
      isBackground: () => false,
      now: () => now,
      uuid: () => `u${++n}`,
    });
  const fix = (kmh: number): Fix => {
    now += 1000;
    return {
      t: now,
      lat: 32,
      lon: 34.8,
      altitudeM: null,
      speedMs: kmh / 3.6,
      headingDeg: 0,
      accuracyM: 5,
    };
  };
  return { server, store, storage, loc, make, fix, tick: (ms: number) => (now += ms) };
}

describe('driver trip controller', () => {
  it('START DRIVING: checks permission, starts the trip and location, shows ACTIVE', async () => {
    const s = setup();
    const c = s.make();
    expect(await c.start('d1', 'dev1')).toBe(true);
    expect(c.snapshot.state).toBe('ACTIVE');
    expect(s.loc.started).toBe(1);
  });

  it('permission denied: no trip, PERMISSION_REQUIRED, monitoring request answered honestly', async () => {
    const s = setup({ perm: 'undetermined', grant: 'denied' });
    const c = s.make();
    expect(await c.start('d1', 'dev1', { monitoringRequestId: 'mr1' })).toBe(false);
    expect(c.snapshot.state).toBe('PERMISSION_REQUIRED');
    expect(s.server.tripCount).toBe(0);
    expect(s.server.monitoringResponses).toEqual(['PERMISSION_REQUIRED']);
  });

  it('uploads in order with stable ids/sequence and updates live severity from the server', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    for (let i = 0; i < 35; i++) await c.onFix(s.fix(140));
    await c.sync(true);
    const stored = [...(s.server.points.get('trip1')?.keys() ?? [])];
    expect(stored).toEqual(Array.from({ length: 35 }, (_, i) => i + 1));
    expect(c.snapshot.state).toBe('WARNING');
    expect(c.snapshot.queued).toBe(0);
  });

  it('offline: queues points, then syncs them all (preserving timestamps) when back online', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    s.server.online = false;
    const times: number[] = [];
    for (let i = 0; i < 50; i++) {
      const f = s.fix(80);
      times.push(f.t);
      await c.onFix(f);
    }
    expect(c.snapshot.queued).toBe(50);
    expect(c.snapshot.online).toBe(false);
    s.server.online = true;
    await c.sync(true);
    const pts = [...(s.server.points.get('trip1')?.values() ?? [])];
    expect(pts).toHaveLength(50);
    expect(pts.map((p) => p.recordedAt)).toEqual(times);
    expect(c.snapshot.queued).toBe(0);
  });

  it('retries never duplicate data on the server', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    for (let i = 0; i < 10; i++) await c.onFix(s.fix(50));
    await c.sync(true);
    await c.sync(true);
    expect(s.server.points.get('trip1')?.size).toBe(10);
  });

  it('stopping while offline is completed after the queued points are synced', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    s.server.online = false;
    for (let i = 0; i < 5; i++) await c.onFix(s.fix(50));
    await c.stop();
    expect(c.snapshot.pendingStop).toBe(true);
    expect(s.server.stopped).toEqual([]);
    expect(s.loc.stopped).toBe(1);
    s.server.online = true;
    await c.sync(true);
    expect(s.server.points.get('trip1')?.size).toBe(5);
    expect(s.server.stopped).toEqual(['trip1']);
    expect(c.snapshot.tripId).toBeNull();
    expect(c.snapshot.state).toBe('IDLE');
  });

  it('survives an app restart: queued points are kept and uploaded by the new instance', async () => {
    const s = setup();
    const c1 = s.make();
    await c1.start('d1', 'dev1');
    s.server.online = false;
    for (let i = 0; i < 7; i++) await c1.onFix(s.fix(60));
    // app killed; new instance, network back
    s.server.online = true;
    const c2 = s.make();
    await c2.resume();
    await c2.sync(true);
    expect(s.server.points.get('trip1')?.size).toBe(7);
  });

  it('SOS offline is stored and delivered once the network returns', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    await c.onFix(s.fix(40));
    s.server.online = false;
    await c.sos();
    expect(c.snapshot.state).toBe('SOS');
    expect(c.snapshot.pendingSos).toBe(1);
    s.server.online = true;
    await c.sync(true);
    expect(s.server.sosCalls).toHaveLength(1);
    expect(c.snapshot.pendingSos).toBe(0);
  });

  it('adapts the GPS plan to the movement (battery optimisation)', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    await c.onFix(s.fix(0));
    await c.onFix(s.fix(100));
    expect(s.loc.plans).toEqual(['STOPPED', 'MOVING_FAST']);
  });

  it('a double tap on START creates a single trip', async () => {
    const s = setup();
    s.server.startDelay = 5;
    const c = s.make();
    const [a, b] = await Promise.all([c.start('d1', 'dev1'), c.start('d1', 'dev1')]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(s.server.tripCount).toBe(1);
  });

  it('if GPS cannot start, the server trip is ended instead of left orphaned', async () => {
    const s = setup();
    s.loc.failStart = true;
    const c = s.make();
    expect(await c.start('d1', 'dev1')).toBe(false);
    expect(s.server.stopped).toEqual(['trip1']);
    expect(c.snapshot.tripId).toBeNull();
    expect(c.snapshot.error).toContain('location');
  });

  it('a stop made offline survives a restart and never restarts GPS for that trip', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    await c.onFix(s.fix(50));
    s.server.online = false;
    await c.stop();
    // App killed; the server still thinks the trip is live.
    s.server.active = { ...(c.snapshot.live as LiveTripView), lastSeq: 0 };
    const started = s.loc.started;
    const c2 = s.make();
    await c2.resume();
    expect(c2.snapshot.state).toBe('ENDING');
    expect(s.loc.started).toBe(started);
    s.server.online = true;
    await c2.sync(true);
    expect(s.server.stopped).toEqual(['trip1']);
    expect(c2.snapshot.state).toBe('IDLE');
    expect(s.server.points.get('trip1')?.size).toBe(1);
  });

  it('a batch the server refuses for good (4xx) is dropped instead of blocking forever', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    s.server.uploadStatus = 404;
    await c.onFix(s.fix(50));
    await c.sync(true);
    expect(c.snapshot.queued).toBe(0);
    s.server.uploadStatus = 500; // transient: kept for retry
    await c.onFix(s.fix(50));
    await c.sync(true);
    expect(c.snapshot.queued).toBe(1);
  });

  it('a trip already ended on the server (409) completes a pending stop', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    s.server.stopStatus = 409;
    await c.stop();
    expect(c.snapshot.pendingStop).toBe(false);
    expect(c.snapshot.state).toBe('IDLE');
  });

  it('two SOS presses while a flush is running are both delivered', async () => {
    const s = setup();
    const c = s.make();
    await c.start('d1', 'dev1');
    await Promise.all([c.sos(), c.sos(), c.sync(true)]);
    expect(s.server.sosCalls).toHaveLength(2);
    expect(c.snapshot.pendingSos).toBe(0);
  });

  it('concurrent resume calls (UI + headless task) run once', async () => {
    const s = setup();
    s.server.active = { ...(await s.server.startTrip({ driverId: 'd1' })), lastSeq: 3 };
    const c = s.make();
    await Promise.all([c.resume(), c.resume(), c.resume()]);
    expect(s.loc.started).toBe(1);
    await c.onFix(s.fix(50));
    await c.sync(true);
    expect([...(s.server.points.get('trip1')?.keys() ?? [])]).toEqual([4]);
  });
});
