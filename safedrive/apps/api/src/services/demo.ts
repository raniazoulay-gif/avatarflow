/**
 * Server-side Demo Mode. Simulates a driver's phone: a demo driver account in a demo
 * family drives a scenario through the REAL pipeline (trip start, telemetry ingestion,
 * speeding engine, notifications, realtime, SOS, trip end). Network loss is simulated
 * with the same offline queue the mobile app uses. All data is flagged is_demo.
 */
import { randomUUID } from 'node:crypto';
import {
  demoScenario,
  generateDemoPoints,
  MemoryQueueStorage,
  OutboundQueue,
  type DemoPoint,
} from '@safedrive/core';
import { type Db } from '../db/pool.js';
import { hashPassword, randomToken } from '../lib/crypto.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireParent } from '../auth/access.js';
import { type FamilyService, CONSENT_VERSION } from './families.js';
import { type SosService } from './sos.js';
import { type TelemetryService, type IncomingPoint } from './telemetry.js';
import { type TripService } from './trips.js';

export interface DemoRun {
  id: string;
  tripId: string;
  scenarioId: string;
  familyId: string;
  driverId: string;
  startedAt: number;
  status: 'running' | 'finished' | 'cancelled' | 'failed';
  progress: number;
  error?: string;
}

interface Deps {
  db: Db;
  families: FamilyService;
  trips: TripService;
  telemetry: TelemetryService;
  sos: SosService;
}

export class DemoService {
  private runs = new Map<string, DemoRun & { cancel: boolean }>();

  constructor(private readonly d: Deps) {}

  /** Creates a clearly-labelled demo family with the caller as parent and a simulated driver. */
  async createDemoFamily(
    parentId: string,
    driverName = 'רומי (הדגמה)',
  ): Promise<{ familyId: string; driverId: string }> {
    const fam = await this.d.families.create(parentId, {
      name: 'משפחת הדגמה (Demo)',
      isDemo: true,
    });
    const email = `demo-driver-${randomUUID()}@demo.safedrive.invalid`;
    const u = await this.d.db.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id`,
      [email, await hashPassword(randomToken()), driverName],
    );
    const userId = (u.rows[0] as { id: string }).id;
    const m = await this.d.db.query<{ id: string }>(
      `INSERT INTO family_members (family_id, user_id, role, display_name) VALUES ($1, $2, 'DRIVER', $3) RETURNING id`,
      [fam.id, userId, driverName],
    );
    const drv = await this.d.db.query<{ id: string }>(
      `INSERT INTO drivers (family_id, member_id, user_id, display_name, consent_at, consent_version)
       VALUES ($1, $2, $3, $4, now(), $5) RETURNING id`,
      [
        fam.id,
        (m.rows[0] as { id: string }).id,
        userId,
        driverName,
        `${CONSENT_VERSION}-simulated`,
      ],
    );
    return { familyId: fam.id, driverId: (drv.rows[0] as { id: string }).id };
  }

  list(familyIds: string[]): DemoRun[] {
    return [...this.runs.values()]
      .filter((r) => familyIds.includes(r.familyId))
      .map(({ cancel: _c, ...r }) => r);
  }

  cancel(runId: string, familyIds: string[]): void {
    const r = this.runs.get(runId);
    if (!r || !familyIds.includes(r.familyId)) throw notFound('Demo run not found');
    r.cancel = true;
  }

  /**
   * Starts a scenario in the background. speedFactor 1 = real time (1 point/second),
   * higher values compress time but keep the device timestamps realistic.
   */
  async start(
    parentId: string,
    driverId: string,
    scenarioId: string,
    speedFactor: number,
  ): Promise<DemoRun> {
    const scenario = demoScenario(scenarioId);
    if (!scenario) throw badRequest('Unknown scenario');
    const drv = await this.d.db.query<{
      id: string;
      family_id: string;
      user_id: string;
      is_demo: boolean;
    }>(
      `SELECT d.id, d.family_id, d.user_id, f.is_demo FROM drivers d JOIN families f ON f.id = d.family_id WHERE d.id = $1`,
      [driverId],
    );
    const driver = drv.rows[0];
    if (!driver) throw notFound('Driver not found');
    await requireParent(this.d.db, parentId, driver.family_id);
    if (!driver.is_demo) throw badRequest('Demo scenarios run only for drivers of a demo family');
    const live = await this.d.db.query(
      'SELECT id FROM trips WHERE driver_id = $1 AND ended_at IS NULL',
      [driverId],
    );
    if (live.rowCount)
      await this.d.trips.stop((live.rows[0] as { id: string }).id, {
        userId: null,
        reason: 'auto',
      });
    const view = await this.d.trips.start(driver.user_id, {
      driverId,
      isDemo: true,
      demoScenario: scenarioId,
    });
    const run: DemoRun & { cancel: boolean } = {
      id: randomUUID(),
      tripId: view.tripId,
      scenarioId,
      familyId: driver.family_id,
      driverId,
      startedAt: Date.now(),
      status: 'running',
      progress: 0,
      cancel: false,
    };
    this.runs.set(run.id, run);
    const points = generateDemoPoints(scenario, Date.now());
    void this.drive(run, driver.user_id, points, Math.max(1, Math.min(20, speedFactor))).catch(
      (e: Error) => {
        run.status = 'failed';
        run.error = e.message;
      },
    );
    const { cancel: _c, ...pub } = run;
    return pub;
  }

  private async drive(
    run: DemoRun & { cancel: boolean },
    userId: string,
    points: DemoPoint[],
    speedFactor: number,
  ): Promise<void> {
    const queue = new OutboundQueue<IncomingPoint>(new MemoryQueueStorage(), { baseBackoffMs: 0 });
    const send = async (batch: { id: string; payload: IncomingPoint }[]) => {
      const r = await this.d.telemetry.ingest(
        userId,
        run.tripId,
        batch.map((b) => b.payload),
      );
      return { acknowledged: [...r.accepted, ...r.duplicates] };
    };
    const startWall = Date.now();
    const t0 = points[0]?.t ?? Date.now();
    for (let i = 0; i < points.length; i++) {
      if (run.cancel) {
        run.status = 'cancelled';
        break;
      }
      const p = points[i] as DemoPoint;
      // Realistic device timestamps: the point is "recorded" when it happens on the compressed clock.
      const dueAt = startWall + (p.t - t0) / speedFactor;
      const wait = dueAt - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const recordedAt = startWall + (p.t - t0);
      const item = await queue.enqueue(run.tripId, {
        id: randomUUID(),
        seq: 0,
        recordedAt,
        lat: p.lat,
        lon: p.lon,
        speedMs: p.speedMs,
        headingDeg: p.headingDeg,
        accuracyM: p.accuracyM,
        altitudeM: p.altitudeM,
        source: 'simulated',
        simulatedLimitKmh: p.limitKmh,
      });
      item.payload.seq = item.seq;
      item.payload.id = item.id;
      if (p.online)
        await queue.flush(
          async (b) =>
            send(b.map((x) => ({ ...x, payload: { ...x.payload, id: x.id, seq: x.seq } }))),
          true,
        );
      if (p.sos) {
        await this.d.sos.trigger(userId, {
          clientId: randomUUID(),
          driverId: run.driverId,
          tripId: run.tripId,
          lat: p.lat,
          lon: p.lon,
          accuracyM: p.accuracyM,
          speedMs: p.speedMs,
        });
      }
      run.progress = Math.round(((i + 1) / points.length) * 100);
    }
    await queue.flush(
      async (b) => send(b.map((x) => ({ ...x, payload: { ...x.payload, id: x.id, seq: x.seq } }))),
      true,
    );
    await this.d.trips.stop(run.tripId, { userId: null, reason: 'auto' });
    if (run.status === 'running') run.status = 'finished';
  }
}
