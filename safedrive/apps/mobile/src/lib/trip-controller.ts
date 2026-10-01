/**
 * Driver-side trip engine (pure TypeScript, no React Native imports, unit-tested).
 *
 *  - explicit state machine (packages/core trip-state), never loose booleans;
 *  - every GPS fix becomes a telemetry point in a durable OutboundQueue (ordered,
 *    stable id + per-trip sequence) - uploads are idempotent on the server;
 *  - offline: points accumulate and are synchronised when the network returns;
 *    a trip stop or SOS made offline is persisted and retried;
 *  - data the server refuses for good (4xx) is dropped so it can never block newer data;
 *  - adaptive cadence from the core telemetry policy (battery, speed, accuracy...);
 *  - monitoring is never silent: the UI shows the state, the OS shows its indicator.
 *  - demo trips are simulated by the server (DemoService); the phone never sends
 *    simulated points.
 */
import {
  OutboundQueue,
  planTelemetry,
  transition,
  canTransition,
  type LiveTripView,
  type TelemetryPlan,
  type TelemetryPointInput,
  type TripState,
  type TripStateEvent,
} from '@safedrive/core';

export type PermissionLevel = 'background' | 'foreground' | 'denied' | 'undetermined';

export interface Fix {
  t: number;
  lat: number;
  lon: number;
  altitudeM: number | null;
  speedMs: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
}

export type UploadPoint = TelemetryPointInput;

export interface SosInput {
  clientId: string;
  driverId: string;
  tripId: string | null;
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
  speedMs: number | null;
  triggeredAt: number;
}

export interface TripApi {
  startTrip(input: {
    driverId: string;
    deviceId: string | null;
    monitoringRequestId?: string | null;
  }): Promise<LiveTripView>;
  stopTrip(tripId: string): Promise<unknown>;
  upload(
    tripId: string,
    points: UploadPoint[],
  ): Promise<{
    accepted: string[];
    duplicates: string[];
    rejected?: string[];
    live: LiveTripView | null;
  }>;
  reportEvent(
    tripId: string,
    e: {
      clientId: string;
      type: string;
      at: number;
      data: Record<string, string | number | boolean | null>;
    },
  ): Promise<unknown>;
  sos(input: SosInput): Promise<unknown>;
  activeTrip(): Promise<(LiveTripView & { lastSeq: number }) | null>;
  respondMonitoring(
    requestId: string,
    status: 'DECLINED' | 'PERMISSION_REQUIRED' | 'UNAVAILABLE',
  ): Promise<unknown>;
}

export interface LocationSource {
  permission(): Promise<PermissionLevel>;
  requestPermission(): Promise<PermissionLevel>;
  start(plan: TelemetryPlan): Promise<void>;
  updatePlan(plan: TelemetryPlan): Promise<void>;
  stop(): Promise<void>;
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ControllerDeps {
  api: TripApi;
  location: LocationSource;
  queue: OutboundQueue<UploadPoint>;
  store: KeyValueStore;
  isOnline: () => boolean;
  battery: () => { level: number | null; charging: boolean };
  isBackground: () => boolean;
  now: () => number;
  uuid: () => string;
}

export interface ControllerSnapshot {
  state: TripState;
  tripId: string | null;
  driverId: string | null;
  isDemo: boolean;
  live: LiveTripView | null;
  lastFix: Fix | null;
  queued: number;
  online: boolean;
  permission: PermissionLevel;
  error: string | null;
  pendingStop: boolean;
  pendingSos: number;
}

const K_ACTIVE = 'sd.activeTrip';
const K_PENDING_STOP = 'sd.pendingStop';
const K_PENDING_SOS = 'sd.pendingSos';

/** HTTP status of a failed API call, if the error carries one. */
function statusOf(e: unknown): number | null {
  const st = (e as { status?: unknown } | null)?.status;
  return typeof st === 'number' ? st : null;
}

/** The server refused for good (validation, trip gone, not ours): retrying cannot help. */
export function isPermanentError(e: unknown): boolean {
  const st = statusOf(e);
  return st !== null && st >= 400 && st < 500 && st !== 401 && st !== 408 && st !== 429;
}

export class TripController {
  private snap: ControllerSnapshot = {
    state: 'IDLE',
    tripId: null,
    driverId: null,
    isDemo: false,
    live: null,
    lastFix: null,
    queued: 0,
    online: true,
    permission: 'undetermined',
    error: null,
    pendingStop: false,
    pendingSos: 0,
  };
  private listeners = new Set<(s: ControllerSnapshot) => void>();
  private lastUploadAt = 0;
  private plan: TelemetryPlan | null = null;
  private starting = false;
  private resuming: Promise<void> | null = null;
  private sosChain: Promise<void> = Promise.resolve();

  constructor(private readonly d: ControllerDeps) {}

  get snapshot(): ControllerSnapshot {
    return { ...this.snap };
  }

  /** True while something still has to reach the server (points, stop, SOS). */
  get hasPendingWork(): boolean {
    return this.d.queue.size > 0 || this.snap.pendingStop || this.snap.pendingSos > 0;
  }

  subscribe(fn: (s: ControllerSnapshot) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  private emit(patch: Partial<ControllerSnapshot>): void {
    this.snap = { ...this.snap, ...patch, queued: this.d.queue.size, online: this.d.isOnline() };
    for (const l of this.listeners) l(this.snapshot);
  }

  private go(ev: TripStateEvent): void {
    if (canTransition(this.snap.state, ev)) this.emit({ state: transition(this.snap.state, ev) });
  }

  /**
   * After an app restart / crash / headless start: continue the trip the server still
   * considers live. Single-flight: concurrent callers share one run.
   */
  resume(): Promise<void> {
    this.resuming ??= this.doResume().finally(() => (this.resuming = null));
    return this.resuming;
  }

  private async doResume(): Promise<void> {
    await this.d.queue.init();
    const permission = await this.d.location.permission();
    const pendingStop = await this.d.store.get(K_PENDING_STOP);
    this.emit({
      permission,
      pendingStop: pendingStop !== null,
      pendingSos: this.pendingSosList(await this.d.store.get(K_PENDING_SOS)).length,
    });
    if (pendingStop) {
      // The driver already ended this trip (maybe offline): never restart GPS for it.
      await this.d.location.stop().catch(() => undefined);
      this.emit({ state: 'ENDING', tripId: pendingStop });
      await this.sync(true);
      return;
    }
    if (this.snap.tripId) {
      await this.sync();
      return;
    }
    let active: (LiveTripView & { lastSeq: number }) | null = null;
    try {
      active = await this.d.api.activeTrip();
    } catch {
      const cached = await this.d.store.get(K_ACTIVE);
      if (cached) active = JSON.parse(cached) as LiveTripView & { lastSeq: number };
    }
    if (!active) {
      // Nothing to monitor (e.g. the server auto-ended the trip): release the GPS.
      await this.d.store.remove(K_ACTIVE);
      await this.d.location.stop().catch(() => undefined);
      await this.sync(); // late points of an ended trip are still delivered
      return;
    }
    await this.d.queue.setNextSeq(active.tripId, active.lastSeq);
    this.emit({
      state: active.state === 'REMOTE_MONITORING_ACTIVE' ? 'REMOTE_MONITORING_ACTIVE' : 'ACTIVE',
      tripId: active.tripId,
      driverId: active.driverId,
      isDemo: active.isDemo,
      live: active,
    });
    if (!active.isDemo && (permission === 'background' || permission === 'foreground')) {
      await this.d.location
        .start(this.currentPlan())
        .catch((e: Error) => this.emit({ error: e.message }));
    }
    await this.sync();
  }

  /** START DRIVING (or accepting a parent's monitoring request). */
  async start(
    driverId: string,
    deviceId: string | null,
    opts: { monitoringRequestId?: string | null } = {},
  ): Promise<boolean> {
    if (this.snap.tripId) return true;
    if (this.starting) return false; // double tap
    this.starting = true;
    try {
      return await this.doStart(driverId, deviceId, opts);
    } finally {
      this.starting = false;
    }
  }

  private async doStart(
    driverId: string,
    deviceId: string | null,
    opts: { monitoringRequestId?: string | null },
  ): Promise<boolean> {
    this.emit({ error: null, driverId });
    let permission = await this.d.location.permission();
    if (permission === 'undetermined' || permission === 'denied')
      permission = await this.d.location.requestPermission();
    this.emit({ permission });
    if (permission === 'denied' || permission === 'undetermined') {
      this.go('PERMISSION_MISSING');
      if (opts.monitoringRequestId)
        await this.d.api
          .respondMonitoring(opts.monitoringRequestId, 'PERMISSION_REQUIRED')
          .catch(() => undefined);
      return false;
    }
    if (this.snap.state === 'PERMISSION_REQUIRED') this.go('PERMISSION_GRANTED');
    this.go(opts.monitoringRequestId ? 'REQUEST_REMOTE' : 'START');
    if (opts.monitoringRequestId) this.go('START');
    let live: LiveTripView;
    try {
      live = await this.d.api.startTrip({
        driverId,
        deviceId,
        monitoringRequestId: opts.monitoringRequestId ?? null,
      });
    } catch (e) {
      this.emit({ error: (e as Error).message, state: 'IDLE', tripId: null });
      return false;
    }
    try {
      await this.d.location.start(this.currentPlan());
    } catch (e) {
      // No GPS stream = no monitoring: end the trip instead of leaving an orphan.
      await this.d.api.stopTrip(live.tripId).catch(() => undefined);
      this.emit({ error: (e as Error).message, state: 'IDLE', tripId: null, live: null });
      return false;
    }
    await this.d.store.set(K_ACTIVE, JSON.stringify({ ...live, lastSeq: 0 }));
    this.emit({ tripId: live.tripId, live, isDemo: live.isDemo });
    this.go(opts.monitoringRequestId ? 'STARTED_REMOTE' : 'STARTED');
    return true;
  }

  private currentPlan(): TelemetryPlan {
    const fix = this.snap.lastFix;
    const b = this.d.battery();
    this.plan = planTelemetry({
      speedKmh: fix?.speedMs !== null && fix?.speedMs !== undefined ? fix.speedMs * 3.6 : null,
      accuracyM: fix?.accuracyM ?? null,
      background: this.d.isBackground(),
      batteryLevel: b.level,
      charging: b.charging,
      speeding:
        (this.snap.live?.severity ?? 'SAFE') !== 'SAFE' || this.snap.live?.confirming === true,
    });
    return this.plan;
  }

  /** Called by the background location task for every fix. */
  async onFix(fix: Fix): Promise<void> {
    const tripId = this.snap.tripId;
    // Demo trips are simulated server-side; a trip being stopped takes no new fixes.
    if (!tripId || this.snap.isDemo || this.snap.pendingStop) return;
    const item = await this.d.queue.enqueue(tripId, {
      id: '',
      seq: 0,
      recordedAt: fix.t,
      lat: fix.lat,
      lon: fix.lon,
      altitudeM: fix.altitudeM,
      speedMs: fix.speedMs,
      headingDeg: fix.headingDeg,
      accuracyM: fix.accuracyM,
      source: 'gps',
    });
    item.payload.id = item.id;
    item.payload.seq = item.seq;
    this.emit({ lastFix: fix });
    const prevMotion = this.plan?.motion;
    const plan = this.currentPlan();
    if (plan.motion !== prevMotion) await this.d.location.updatePlan(plan).catch(() => undefined);
    const due =
      this.d.queue.size >= plan.uploadMaxPoints ||
      this.d.now() - this.lastUploadAt >= plan.uploadMaxDelayMs;
    if (due) await this.sync();
  }

  /** Uploads everything queued (oldest first) and retries pending stop/SOS. Safe to call any time. */
  async sync(force = false): Promise<void> {
    if (!this.d.isOnline()) {
      this.emit({});
      return;
    }
    await this.flushSos();
    this.lastUploadAt = this.d.now();
    let lastLive: LiveTripView | null = null;
    await this.d.queue
      .flush(async (batch) => {
        const byTrip = new Map<string, UploadPoint[]>();
        for (const b of batch)
          byTrip.set(b.stream, [
            ...(byTrip.get(b.stream) ?? []),
            { ...b.payload, id: b.id, seq: b.seq },
          ]);
        const acknowledged: string[] = [];
        for (const [tripId, points] of byTrip) {
          try {
            const r = await this.d.api.upload(tripId, points);
            acknowledged.push(...r.accepted, ...r.duplicates, ...(r.rejected ?? []));
            if (r.live && tripId === this.snap.tripId) lastLive = r.live;
          } catch (e) {
            if (!isPermanentError(e)) throw e; // network / 5xx: keep everything, back off
            // Refused for good (trip gone, invalid): drop it so it cannot block newer data.
            acknowledged.push(...points.map((p) => p.id));
            this.emit({ error: (e as Error).message });
          }
        }
        return { acknowledged };
      }, force)
      .catch(() => undefined);
    if (lastLive) this.applyLive(lastLive);
    this.emit({});
    if (this.d.queue.size === 0 && (await this.d.store.get(K_PENDING_STOP)))
      await this.finishStop();
  }

  private applyLive(live: LiveTripView): void {
    const sev = live.severity;
    if (this.snap.state !== 'SOS' && this.snap.state !== 'ENDING') {
      const ev: TripStateEvent =
        live.state === 'SPEED_LIMIT_UNAVAILABLE'
          ? 'LIMIT_UNAVAILABLE'
          : live.state === 'LOCATION_UNAVAILABLE'
            ? 'LOCATION_LOST'
            : (`SEVERITY_${sev}` as TripStateEvent);
      if (canTransition(this.snap.state, ev)) {
        const to = transition(this.snap.state, ev);
        this.emit({
          state:
            to === 'ACTIVE' && live.state === 'REMOTE_MONITORING_ACTIVE'
              ? 'REMOTE_MONITORING_ACTIVE'
              : to,
        });
      }
    }
    this.emit({ live });
  }

  /** End trip. Offline: the stop is persisted and completed once queued points are uploaded. */
  async stop(): Promise<void> {
    if (!this.snap.tripId) return;
    await this.d.location.stop().catch(() => undefined);
    this.go('STOP');
    await this.d.store.set(K_PENDING_STOP, this.snap.tripId);
    this.emit({ pendingStop: true });
    await this.sync(true);
  }

  private async finishStop(): Promise<void> {
    const tripId = await this.d.store.get(K_PENDING_STOP);
    if (!tripId) return;
    try {
      await this.d.api.stopTrip(tripId);
    } catch (e) {
      if (!isPermanentError(e)) return; // retried on next sync
      // 404/409...: the trip is already over (e.g. auto-ended by the server).
    }
    await this.d.store.remove(K_PENDING_STOP);
    await this.d.store.remove(K_ACTIVE);
    this.go('STOPPED');
    this.emit({ tripId: null, isDemo: false, pendingStop: false, live: null, lastFix: null });
    this.go('RESET');
    if (this.snap.state !== 'IDLE') this.emit({ state: 'IDLE' });
  }

  /** Device-detected event (phone usage, GPS loss...). Best effort, de-duplicated by clientId. */
  async report(
    type: 'PHONE_USAGE' | 'GPS_UNAVAILABLE' | 'PERMISSION_PROBLEM' | 'CONNECTIVITY_LOSS',
    data: Record<string, string | number | boolean | null> = {},
  ): Promise<void> {
    if (!this.snap.tripId || !this.d.isOnline()) return;
    await this.d.api
      .reportEvent(this.snap.tripId, { clientId: this.d.uuid(), type, at: this.d.now(), data })
      .catch(() => undefined);
  }

  private pendingSosList(raw: string | null): SosInput[] {
    try {
      return raw ? (JSON.parse(raw) as SosInput[]) : [];
    } catch {
      return [];
    }
  }

  /** SOS: always recorded locally first, sent immediately or as soon as the network returns. */
  async sos(): Promise<void> {
    if (!this.snap.driverId) throw new Error('No driver profile');
    const fix = this.snap.lastFix;
    const payload: SosInput = {
      clientId: this.d.uuid(),
      driverId: this.snap.driverId,
      tripId: this.snap.tripId,
      lat: fix?.lat ?? null,
      lon: fix?.lon ?? null,
      accuracyM: fix?.accuracyM ?? null,
      speedMs: fix?.speedMs ?? null,
      triggeredAt: this.d.now(),
    };
    // Appended inside the same serial chain as the flush, so nothing can overwrite it.
    this.sosChain = this.sosChain
      .then(async () => {
        const list = this.pendingSosList(await this.d.store.get(K_PENDING_SOS));
        list.push(payload);
        await this.d.store.set(K_PENDING_SOS, JSON.stringify(list));
        this.emit({ pendingSos: list.length });
      })
      .catch(() => undefined);
    await this.sosChain;
    if (this.snap.tripId) this.go('SOS');
    await this.flushSos();
  }

  /** Serialised: concurrent calls never lose an SOS queued meanwhile. */
  private flushSos(): Promise<void> {
    this.sosChain = this.sosChain.then(() => this.doFlushSos()).catch(() => undefined);
    return this.sosChain;
  }

  private async doFlushSos(): Promise<void> {
    if (!this.d.isOnline()) return;
    const list = this.pendingSosList(await this.d.store.get(K_PENDING_SOS));
    if (list.length === 0) return;
    const left: SosInput[] = [];
    for (const s of list) {
      try {
        await this.d.api.sos(s);
      } catch (e) {
        if (!isPermanentError(e)) left.push(s); // invalid for good: do not retry forever
      }
    }
    if (left.length) await this.d.store.set(K_PENDING_SOS, JSON.stringify(left));
    else await this.d.store.remove(K_PENDING_SOS);
    this.emit({ pendingSos: left.length });
  }

  setDriver(driverId: string): void {
    this.emit({ driverId });
  }
}
