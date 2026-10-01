import {
  finishSpeeding,
  transition,
  formatDuration,
  type LiveTripView,
} from '@safedrive/core';
import { type Db, withTx } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { type RealtimeBus, familyChannel } from '../realtime/bus.js';
import { audit } from './audit.js';
import { safetyConfigFor } from './app-config.js';
import { liveView, type TripRow } from './live.js';
import { type Metrics } from './metrics.js';
import { type NotificationService } from './notifications.js';
import { refreshDriverScore, scoreTrip } from './scoring.js';
import { type TelemetryService, type EngineState, initialEngineState } from './telemetry.js';

interface Deps {
  db: Db;
  bus: RealtimeBus;
  notifications: NotificationService;
  telemetry: TelemetryService;
  metrics: Metrics;
  offlineAfterSec: number;
}

export interface StartTripInput {
  driverId: string;
  deviceId?: string | null;
  monitoringRequestId?: string | null;
  isDemo?: boolean;
  demoScenario?: string | null;
}

interface DriverInfo {
  id: string;
  family_id: string;
  user_id: string;
  display_name: string;
  is_demo_family: boolean;
}

export class TripService {
  constructor(private readonly d: Deps) {}

  private async driver(driverId: string): Promise<DriverInfo> {
    const r = await this.d.db.query<DriverInfo>(
      `SELECT d.id, d.family_id, d.user_id, d.display_name, f.is_demo AS is_demo_family
       FROM drivers d JOIN families f ON f.id = d.family_id
       WHERE d.id = $1 AND d.deleted_at IS NULL AND f.deleted_at IS NULL`,
      [driverId],
    );
    const d = r.rows[0];
    if (!d) throw notFound('Driver not found');
    return d;
  }

  /** Driver presses START DRIVING (or accepts a remote monitoring request). */
  async start(userId: string, input: StartTripInput, ip?: string): Promise<LiveTripView> {
    const drv = await this.driver(input.driverId);
    if (drv.user_id !== userId) throw notFound('Driver not found');
    const isDemo = input.isDemo === true || drv.is_demo_family;
    let remote = false;
    if (input.monitoringRequestId) {
      const mr = await this.d.db.query<{ status: string; driver_id: string }>(
        'SELECT status, driver_id FROM monitoring_requests WHERE id = $1',
        [input.monitoringRequestId],
      );
      const req = mr.rows[0];
      if (!req || req.driver_id !== drv.id) throw badRequest('Unknown monitoring request');
      if (!['REQUESTED', 'PENDING'].includes(req.status)) throw conflict('Monitoring request is no longer pending');
      remote = true;
    }
    let state = transition(remote ? 'REMOTE_MONITORING_REQUESTED' : 'IDLE', 'START');
    state = transition(state, remote ? 'STARTED_REMOTE' : 'STARTED');
    let trip: TripRow;
    try {
      trip = await withTx(this.d.db, async (c) => {
        const ins = await c.query<TripRow>(
          `INSERT INTO trips (family_id, driver_id, device_id, state, is_demo, demo_scenario, started_by, monitoring_request_id, engine_state)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [drv.family_id, drv.id, input.deviceId ?? null, state, isDemo, input.demoScenario ?? null,
            isDemo && input.demoScenario ? 'demo' : remote ? 'remote_request' : 'driver', input.monitoringRequestId ?? null,
            initialEngineState()],
        );
        const t = ins.rows[0] as TripRow;
        await c.query(
          `INSERT INTO safety_events (family_id, driver_id, trip_id, type, occurred_at, is_demo, dedupe_key)
           VALUES ($1, $2, $3, 'TRIP_STARTED', now(), $4, 'TRIP_STARTED')`,
          [drv.family_id, drv.id, t.id, isDemo],
        );
        if (input.monitoringRequestId) {
          await c.query(`UPDATE monitoring_requests SET status = 'ACTIVE', trip_id = $2, updated_at = now() WHERE id = $1`, [
            input.monitoringRequestId,
            t.id,
          ]);
        }
        return t;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('A trip is already in progress for this driver');
      throw e;
    }
    await audit(this.d.db, { actorId: userId, familyId: drv.family_id, action: 'trip.start', targetType: 'trip', targetId: trip.id, ip: ip ?? null, details: { remote, isDemo } });
    this.d.metrics.inc('trips_started');
    const view = liveView(trip, drv.display_name, this.d.offlineAfterSec);
    await this.d.bus.publish(familyChannel(drv.family_id), { type: 'trip.started', data: view });
    await this.d.notifications.notifyParents({
      familyId: drv.family_id,
      type: 'TRIP_STARTED',
      driverId: drv.id,
      tripId: trip.id,
      dedupeKey: `${trip.id}:started`,
      cooldownGroup: `${trip.id}:TRIP_STARTED`,
      titleKey: 'app.name',
      bodyKey: 'trip.started',
      vars: { name: drv.display_name },
      isDemo,
    });
    return view;
  }

  /** Ends a trip (driver, or the system after prolonged silence). Idempotent. */
  async stop(tripId: string, actor: { userId: string | null; reason: 'driver' | 'auto' | 'admin' }): Promise<LiveTripView> {
    const pre = await this.d.db.query<TripRow & { user_id: string; country_code: string; display_name: string }>(
      `SELECT t.*, d.user_id, d.display_name, f.country_code FROM trips t JOIN drivers d ON d.id = t.driver_id
       JOIN families f ON f.id = t.family_id WHERE t.id = $1`,
      [tripId],
    );
    const t0 = pre.rows[0];
    if (!t0) throw notFound('Trip not found');
    if (actor.reason === 'driver' && t0.user_id !== actor.userId) throw notFound('Trip not found');
    if (t0.ended_at) return liveView(t0, t0.display_name, this.d.offlineAfterSec);
    const cfg = await safetyConfigFor(this.d.db, t0.family_id, t0.country_code);

    const result = await withTx(this.d.db, async (c) => {
      const locked = await c.query<TripRow>('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
      const trip = locked.rows[0] as TripRow;
      if (trip.ended_at) return { trip, outputs: [] };
      const es: EngineState = { ...initialEngineState(), ...(trip.engine_state as Partial<EngineState>) };
      const fin = finishSpeeding(es.speeding);
      const outputs = [];
      for (const o of fin.outputs) outputs.push({ out: o, eventId: await this.d.telemetry.persistSpeeding(c, trip, o) });
      es.speeding = fin.state;
      // Every live state (and STARTING/ERROR) accepts STOP; then ENDING -> COMPLETED.
      let state = trip.state === 'ENDING' ? trip.state : transition(trip.state, 'STOP');
      state = transition(state, 'STOPPED');
      const score = await scoreTrip(c, trip.id, cfg);
      const lastFix = es.lastFix;
      const upd = await c.query<TripRow>(
        `UPDATE trips SET state = $2, ended_at = coalesce(last_point_at, now()), engine_state = $3, score = $4,
           score_breakdown = $5, speeding_count = $6, critical_count = $7, hard_braking_count = $8,
           hard_acceleration_count = $9, phone_usage_count = $10, end_lat = $11, end_lon = $12,
           live = live || jsonb_build_object('severity', 'SAFE', 'speedingSeconds', null, 'confirming', false), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [trip.id, state, es, score.score, score.breakdown, score.counts.speeding, score.counts.critical,
          score.counts.hardBraking, score.counts.hardAcceleration, score.counts.phoneUsage, lastFix?.lat ?? null, lastFix?.lon ?? null],
      );
      const done = upd.rows[0] as TripRow;
      await c.query(
        `INSERT INTO safety_events (family_id, driver_id, trip_id, type, occurred_at, is_demo, dedupe_key, data)
         VALUES ($1, $2, $3, 'TRIP_ENDED', $4, $5, 'TRIP_ENDED', $6) ON CONFLICT DO NOTHING`,
        [trip.family_id, trip.driver_id, trip.id, done.ended_at, trip.is_demo, { reason: actor.reason }],
      );
      await c.query(`INSERT INTO safety_scores (driver_id, trip_id, scope, score, breakdown) VALUES ($1, $2, 'trip', $3, $4)`, [
        trip.driver_id, trip.id, score.score, score.breakdown,
      ]);
      if (trip.monitoring_request_id) {
        await c.query(`UPDATE monitoring_requests SET status = 'COMPLETED', updated_at = now() WHERE id = $1`, [trip.monitoring_request_id]);
      }
      return { trip: done, outputs };
    });

    if (!result.trip.is_demo) await refreshDriverScore(this.d.db, result.trip.driver_id);
    await audit(this.d.db, { actorId: actor.userId, familyId: result.trip.family_id, action: 'trip.stop', targetType: 'trip', targetId: tripId, details: { reason: actor.reason } });
    this.d.metrics.inc('trips_completed');
    await this.d.telemetry.notifyOutputs(result.trip, t0.display_name, result.outputs);
    const view = liveView(result.trip, t0.display_name, this.d.offlineAfterSec);
    await this.d.bus.publish(familyChannel(result.trip.family_id), { type: 'trip.ended', data: view });
    await this.d.notifications.notifyParents({
      familyId: result.trip.family_id,
      type: 'TRIP_ENDED',
      driverId: result.trip.driver_id,
      tripId,
      dedupeKey: `${tripId}:ended`,
      cooldownGroup: `${tripId}:TRIP_ENDED`,
      titleKey: 'app.name',
      bodyKey: 'notify.ended',
      vars: { name: t0.display_name, duration: formatDuration((result.trip.ended_at!.getTime() - result.trip.started_at.getTime()) / 1000) },
      data: { score: result.trip.score, distanceKm: Math.round(result.trip.distance_m / 100) / 10 },
      isDemo: result.trip.is_demo,
    });
    return view;
  }

  /** Events reported by the device itself (phone usage, permission problems, GPS loss...). */
  async reportClientEvent(
    userId: string,
    tripId: string,
    e: { clientId: string; type: 'PHONE_USAGE' | 'GPS_UNAVAILABLE' | 'PERMISSION_PROBLEM' | 'CONNECTIVITY_LOSS'; at: number; data: Record<string, unknown> },
  ): Promise<{ created: boolean }> {
    const r = await this.d.db.query<TripRow & { user_id: string; display_name: string; country_code: string }>(
      `SELECT t.*, d.user_id, d.display_name, f.country_code FROM trips t JOIN drivers d ON d.id = t.driver_id
       JOIN families f ON f.id = t.family_id WHERE t.id = $1`,
      [tripId],
    );
    const trip = r.rows[0];
    if (!trip || trip.user_id !== userId) throw notFound('Trip not found');
    const ins = await this.d.db.query(
      `INSERT INTO safety_events (family_id, driver_id, trip_id, type, severity, occurred_at, data, is_demo, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING RETURNING id`,
      [trip.family_id, trip.driver_id, trip.id, e.type, e.type === 'PHONE_USAGE' ? 'ATTENTION' : 'SAFE', new Date(e.at), e.data,
        trip.is_demo, `client:${e.clientId}`],
    );
    const created = (ins.rowCount ?? 0) > 0;
    if (created && (e.type === 'GPS_UNAVAILABLE' || e.type === 'PERMISSION_PROBLEM')) {
      await this.d.notifications.notifyParents({
        familyId: trip.family_id,
        type: e.type === 'GPS_UNAVAILABLE' ? 'GPS_UNAVAILABLE' : 'PERMISSION_PROBLEM',
        driverId: trip.driver_id,
        tripId: trip.id,
        dedupeKey: `${trip.id}:client:${e.clientId}`,
        titleKey: 'app.name',
        bodyKey: e.type === 'GPS_UNAVAILABLE' ? 'notify.gps' : 'notify.permission',
        vars: { name: trip.display_name },
        data: e.data,
        isDemo: trip.is_demo,
      });
    }
    if (created && e.type === 'PHONE_USAGE' && !trip.ended_at) {
      const cfg = await safetyConfigFor(this.d.db, trip.family_id, trip.country_code);
      const s = await scoreTrip(this.d.db, trip.id, cfg);
      await this.d.db.query('UPDATE trips SET score = $2, score_breakdown = $3, phone_usage_count = $4 WHERE id = $1', [
        trip.id, s.score, s.breakdown, s.counts.phoneUsage,
      ]);
    }
    return { created };
  }
}
