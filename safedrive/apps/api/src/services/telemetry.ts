/**
 * Telemetry ingestion: idempotent storage + ordered processing through the shared
 * safety engine (packages/core). The trip row is locked (SELECT ... FOR UPDATE) while
 * a batch is processed, so concurrent uploads / multiple API instances can never
 * double-process a point or create duplicate events. Speed limits are resolved
 * before taking the lock (external calls never hold a row lock).
 */
import {
  canTransition,
  distanceMeters,
  initialMotionState,
  initialSpeedingState,
  isLive,
  isValidCoordinate,
  msToKmh,
  processMotionSample,
  processSpeedSample,
  severityEvent,
  transition,
  formatDuration,
  type LiveTripView,
  type MotionState,
  type SafetyConfig,
  type SpeedLimitInfo,
  type SpeedingOutput,
  type SpeedingState,
  type TelemetryPointInput,
  type TripState,
  type TripStateEvent,
} from '@safedrive/core';
import { type Db, withTx, type DbClient } from '../db/pool.js';
import { badRequest, conflict } from '../lib/errors.js';
import { type RealtimeBus, familyChannel } from '../realtime/bus.js';
import { safetyConfigFor } from './app-config.js';
import { liveView, driverName, type TripRow, type LiveSnapshot } from './live.js';
import { type Metrics } from './metrics.js';
import { type NotificationService } from './notifications.js';
import { scoreTrip } from './scoring.js';
import { type SpeedLimitService } from './speed-limits.js';
import { distanceToPolyline } from '../providers/speed-limit/osm.js';

export const MAX_BATCH = 500;

export interface EngineState {
  speeding: SpeedingState;
  motion: MotionState;
  lastFix: {
    t: number;
    lat: number;
    lon: number;
    speedKmh: number | null;
    accuracyM: number | null;
  } | null;
  lastLookup: {
    t: number;
    lat: number;
    lon: number;
    limit: SpeedLimitInfo | null;
    /** Road geometry of the last answer (OSM): reused while the vehicle stays on it. */
    geometry?: Array<{ lat: number; lon: number }> | null;
  } | null;
}

export function initialEngineState(): EngineState {
  return {
    speeding: initialSpeedingState(),
    motion: initialMotionState(),
    lastFix: null,
    lastLookup: null,
  };
}

/** Point as accepted from devices (simulatedLimitKmh only honoured on demo trips). */
export interface IncomingPoint extends TelemetryPointInput {
  simulatedLimitKmh?: number | null;
}

interface NormalPoint {
  id: string;
  seq: number;
  t: number;
  lat: number;
  lon: number;
  altitudeM: number | null;
  speedKmh: number | null;
  headingDeg: number | null;
  accuracyM: number | null;
  source: 'gps' | 'simulated';
  simulatedLimitKmh: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizePoints(points: IncomingPoint[], now = Date.now()): NormalPoint[] {
  if (points.length > MAX_BATCH) throw badRequest(`At most ${MAX_BATCH} points per batch`);
  const bySeq = new Map<number, NormalPoint>();
  for (const p of points) {
    if (!UUID_RE.test(p.id)) throw badRequest('Point id must be a UUID');
    if (!Number.isInteger(p.seq) || p.seq < 1) throw badRequest('seq must be a positive integer');
    const t = typeof p.recordedAt === 'number' ? p.recordedAt : Date.parse(p.recordedAt);
    if (!Number.isFinite(t)) throw badRequest('Invalid recordedAt');
    if (t > now + 5 * 60_000) throw badRequest('recordedAt is in the future');
    if (!isValidCoordinate({ lat: p.lat, lon: p.lon })) throw badRequest('Invalid coordinates');
    const speedMs = p.speedMs ?? null;
    const speedKmh =
      speedMs !== null && Number.isFinite(speedMs) && speedMs >= 0 && speedMs < 120
        ? msToKmh(speedMs)
        : null;
    bySeq.set(p.seq, {
      id: p.id,
      seq: p.seq,
      t,
      lat: p.lat,
      lon: p.lon,
      altitudeM: p.altitudeM ?? null,
      speedKmh,
      headingDeg:
        p.headingDeg !== null && p.headingDeg !== undefined && p.headingDeg >= 0
          ? p.headingDeg % 360
          : null,
      accuracyM:
        p.accuracyM !== null && p.accuracyM !== undefined && p.accuracyM >= 0 ? p.accuracyM : null,
      source: p.source === 'simulated' ? 'simulated' : 'gps',
      simulatedLimitKmh: p.simulatedLimitKmh ?? null,
    });
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export interface IngestResult {
  accepted: string[];
  duplicates: string[];
  live: LiveTripView | null;
}

interface Deps {
  db: Db;
  speedLimits: SpeedLimitService;
  notifications: NotificationService;
  bus: RealtimeBus;
  metrics: Metrics;
  offlineAfterSec: number;
  lookupMinMeters: number;
  lookupMinSeconds: number;
}

const GOOD_ACCURACY_M = 50;
/** A fix within this distance of the last matched road geometry is considered on that road. */
const ON_ROAD_METERS = 15;
/** Even on the same road, re-validate the limit this often (signs can change mid-way). */
const SAME_ROAD_REFRESH_SECONDS = 120;

export class TelemetryService {
  constructor(private readonly d: Deps) {}

  async ingest(userId: string, tripId: string, raw: IncomingPoint[]): Promise<IngestResult> {
    const t0 = performance.now();
    const points = normalizePoints(raw);
    const head = await this.d.db.query<TripRow & { user_id: string; country_code: string }>(
      `SELECT t.*, d.user_id, f.country_code FROM trips t JOIN drivers d ON d.id = t.driver_id
       JOIN families f ON f.id = t.family_id WHERE t.id = $1`,
      [tripId],
    );
    const trip0 = head.rows[0];
    if (!trip0 || trip0.user_id !== userId) throw badRequest('Unknown trip');
    if (points.length === 0) return { accepted: [], duplicates: [], live: null };
    if (
      !trip0.is_demo &&
      points.some((p) => p.source === 'simulated' || p.simulatedLimitKmh !== null)
    ) {
      // Never mix simulated data into a real trip.
      throw badRequest('Simulated points are only accepted on demo trips');
    }
    const cfg = await safetyConfigFor(this.d.db, trip0.family_id, trip0.country_code);
    const limits = await this.resolveLimits(trip0, points);

    const outcome = await withTx(this.d.db, async (c) => {
      const locked = await c.query<TripRow>('SELECT * FROM trips WHERE id = $1 FOR UPDATE', [
        tripId,
      ]);
      const trip = locked.rows[0] as TripRow;
      const inserted = await this.insertPoints(c, trip, points, limits);
      const fresh = points.filter((p) => inserted.has(p.seq) && p.seq > trip.last_seq);
      if (!trip.ended_at && isLive(trip.state) && fresh.length > 0) {
        return { ...(await this.process(c, trip, fresh, limits, cfg)), inserted };
      }
      return {
        trip,
        outputs: [] as Array<{ out: SpeedingOutput; eventId: string }>,
        motion: [] as string[],
        inserted,
      };
    });

    const accepted = points.filter((p) => outcome.inserted.has(p.seq)).map((p) => p.id);
    const duplicates = points.filter((p) => !outcome.inserted.has(p.seq)).map((p) => p.id);
    this.d.metrics.inc('telemetry_points_received', points.length);
    this.d.metrics.inc('telemetry_points_duplicate', duplicates.length);
    const name = await driverName(this.d.db, outcome.trip.driver_id);
    const live = liveView(outcome.trip, name, this.d.offlineAfterSec);
    await this.d.bus.publish(familyChannel(outcome.trip.family_id), {
      type: 'trip.update',
      data: live,
    });
    await this.notifyOutputs(outcome.trip, name, outcome.outputs);
    for (const kind of outcome.motion) {
      await this.d.notifications.notifyParents({
        familyId: outcome.trip.family_id,
        type: kind === 'HARD_BRAKING' ? 'HARD_BRAKING' : 'HARD_ACCELERATION',
        driverId: outcome.trip.driver_id,
        tripId: outcome.trip.id,
        dedupeKey: `${outcome.trip.id}:${kind}:${outcome.trip.last_seq}`,
        titleKey: `event.${kind}`,
        bodyKey: kind === 'HARD_BRAKING' ? 'notify.hardBraking' : 'notify.hardAcceleration',
        vars: { name },
        isDemo: outcome.trip.is_demo,
      });
    }
    this.d.metrics.time('telemetry_batch', performance.now() - t0);
    return { accepted, duplicates, live };
  }

  /** Decides which points need a lookup (moved enough / time passed) and resolves them. */
  private async resolveLimits(
    trip: TripRow & { country_code: string },
    points: NormalPoint[],
  ): Promise<Map<number, SpeedLimitInfo | null>> {
    const out = new Map<number, SpeedLimitInfo | null>();
    if (trip.is_demo) {
      for (const p of points) {
        out.set(
          p.seq,
          p.simulatedLimitKmh
            ? { kmh: p.simulatedLimitKmh, confidence: 1, source: 'demo-simulated', road: null }
            : null,
        );
      }
      return out;
    }
    const state = (trip.engine_state as Partial<EngineState>) ?? {};
    let last = state.lastLookup ?? null;
    this.lastLookups.set(trip.id, last);
    for (const p of points) {
      if (p.accuracyM !== null && p.accuracyM > GOOD_ACCURACY_M) {
        out.set(p.seq, last?.limit ?? null);
        continue;
      }
      const onSameRoad =
        !!last?.geometry &&
        last.geometry.length > 1 &&
        distanceToPolyline(p, last.geometry) <= ON_ROAD_METERS;
      const due =
        !last ||
        (!onSameRoad &&
          (distanceMeters(last, p) >= this.d.lookupMinMeters ||
            (p.t - last.t) / 1000 >= this.d.lookupMinSeconds)) ||
        (onSameRoad && (p.t - last.t) / 1000 >= SAME_ROAD_REFRESH_SECONDS);
      if (due || (last?.geometry && !onSameRoad)) {
        const r = await this.d.speedLimits.resolve({
          lat: p.lat,
          lon: p.lon,
          headingDeg: p.headingDeg,
          countryCode: trip.country_code,
        });
        const info: SpeedLimitInfo | null =
          r && r.limitKmh !== null
            ? { kmh: r.limitKmh, confidence: r.confidence, source: r.source, road: r.roadName }
            : null;
        last = { t: p.t, lat: p.lat, lon: p.lon, limit: info, geometry: r?.geometry ?? null };
      }
      out.set(p.seq, last?.limit ?? null);
    }
    this.lastLookups.set(trip.id, last);
    return out;
  }

  /** Lookup bookkeeping computed before the row lock, persisted with the batch. */
  private readonly lastLookups = new Map<string, EngineState['lastLookup']>();

  private async insertPoints(
    c: DbClient,
    trip: TripRow,
    points: NormalPoint[],
    limits: Map<number, SpeedLimitInfo | null>,
  ): Promise<Set<number>> {
    const cols = 14;
    const values: unknown[] = [];
    const rows: string[] = [];
    points.forEach((p, i) => {
      const l = limits.get(p.seq) ?? null;
      const b = i * cols;
      rows.push(`(${Array.from({ length: cols }, (_, k) => `$${b + k + 1}`).join(',')})`);
      values.push(
        trip.id,
        p.seq,
        new Date(p.t),
        p.id,
        p.lat,
        p.lon,
        p.altitudeM,
        p.speedKmh,
        p.headingDeg,
        p.accuracyM,
        p.source,
        l?.kmh ?? null,
        l?.source ?? null,
        l?.confidence ?? null,
      );
    });
    const r = await c.query<{ seq: number }>(
      `INSERT INTO telemetry_points (trip_id, seq, recorded_at, client_id, lat, lon, altitude_m, speed_kmh, heading_deg,
         accuracy_m, source, limit_kmh, limit_source, limit_confidence)
       VALUES ${rows.join(',')} ON CONFLICT DO NOTHING RETURNING seq`,
      values,
    );
    return new Set(r.rows.map((x) => x.seq));
  }

  private async process(
    c: DbClient,
    trip: TripRow,
    points: NormalPoint[],
    limits: Map<number, SpeedLimitInfo | null>,
    cfg: SafetyConfig,
  ): Promise<{
    trip: TripRow;
    outputs: Array<{ out: SpeedingOutput; eventId: string }>;
    motion: string[];
  }> {
    const es: EngineState = {
      ...initialEngineState(),
      ...(trip.engine_state as Partial<EngineState>),
    };
    let distance = trip.distance_m;
    let moving = trip.moving_seconds;
    let maxSpeed = trip.max_speed_kmh;
    let live: LiveSnapshot = { ...trip.live };
    const outputs: Array<{ out: SpeedingOutput; eventId: string }> = [];
    const motionKinds: string[] = [];
    let lastStatus: string = live.severity ?? 'SAFE';
    let startLat = trip.start_lat;
    let startLon = trip.start_lon;

    for (const p of points) {
      // Derive speed when the OS did not provide one (short, accurate intervals only).
      let speed = p.speedKmh;
      const prev = es.lastFix;
      if (speed === null && prev && p.accuracyM !== null && p.accuracyM <= 20) {
        const dt = (p.t - prev.t) / 1000;
        if (dt > 0 && dt <= 10) speed = msToKmh(distanceMeters(prev, p) / dt);
      }
      if (prev) {
        const dt = (p.t - prev.t) / 1000;
        const d = distanceMeters(prev, p);
        const goodFix = (p.accuracyM ?? 0) <= GOOD_ACCURACY_M;
        if (goodFix && dt > 0 && dt <= 120 && msToKmh(d / dt) <= 250) {
          distance += d;
          if ((speed ?? 0) > 3) moving += Math.round(dt);
        }
      }
      if (startLat === null) {
        startLat = p.lat;
        startLon = p.lon;
      }
      if (speed !== null && (p.accuracyM ?? 0) <= GOOD_ACCURACY_M && speed > maxSpeed)
        maxSpeed = speed;
      es.lastFix = { t: p.t, lat: p.lat, lon: p.lon, speedKmh: speed, accuracyM: p.accuracyM };
      const limit = limits.get(p.seq) ?? null;

      const step = processSpeedSample(
        es.speeding,
        { t: p.t, speedKmh: speed, limit, lat: p.lat, lon: p.lon, accuracyM: p.accuracyM },
        cfg.speeding,
      );
      es.speeding = step.state;
      for (const o of step.outputs)
        outputs.push({ out: o, eventId: await this.persistSpeeding(c, trip, o) });
      lastStatus = step.live.status;
      live = {
        lat: p.lat,
        lon: p.lon,
        accuracyM: p.accuracyM,
        speedKmh: speed === null ? null : Math.round(speed),
        limitKmh: limit?.kmh ?? null,
        limitSource: limit?.source ?? null,
        road: limit?.road ?? null,
        excessKmh: step.live.excessKmh,
        excessPct: step.live.excessPct,
        severity: step.state.event ? step.state.event.severity : 'SAFE',
        speedingSeconds: step.live.speedingSeconds,
        confirming: step.live.confirming,
      };

      const m = processMotionSample(
        es.motion,
        { t: p.t, speedKmh: speed, accuracyM: p.accuracyM, lat: p.lat, lon: p.lon },
        cfg.motion,
      );
      es.motion = m.state;
      for (const ev of m.events) {
        await c.query(
          `INSERT INTO safety_events (family_id, driver_id, trip_id, type, severity, occurred_at, lat, lon, data, is_demo, dedupe_key)
           VALUES ($1, $2, $3, $4, 'ATTENTION', $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [
            trip.family_id,
            trip.driver_id,
            trip.id,
            ev.type,
            new Date(ev.t),
            ev.location.lat,
            ev.location.lon,
            {
              accelerationMs2: ev.accelerationMs2,
              fromSpeedKmh: Math.round(ev.fromSpeedKmh),
              toSpeedKmh: Math.round(ev.toSpeedKmh),
            },
            trip.is_demo,
            `${ev.type}:${ev.t}`,
          ],
        );
        motionKinds.push(ev.type);
      }
    }

    if (!trip.is_demo && this.lastLookups.has(trip.id))
      es.lastLookup = this.lastLookups.get(trip.id) ?? null;
    this.lastLookups.delete(trip.id);
    const state = nextState(trip.state, lastStatus, trip.started_by === 'remote_request');
    const lastPoint = points[points.length - 1] as NormalPoint;
    const score = await scoreTrip(c, trip.id, cfg);
    const updated = await c.query<TripRow>(
      `UPDATE trips SET engine_state = $2, live = $3, last_seq = $4, last_point_at = $5, distance_m = $6,
         moving_seconds = $7, max_speed_kmh = $8, state = $9, score = $10, score_breakdown = $11,
         speeding_count = $12, critical_count = $13, hard_braking_count = $14, hard_acceleration_count = $15,
         start_lat = $16, start_lon = $17, offline_notified_at = NULL, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [
        trip.id,
        es,
        live,
        lastPoint.seq,
        new Date(lastPoint.t),
        distance,
        moving,
        maxSpeed,
        state,
        score.score,
        score.breakdown,
        score.counts.speeding,
        score.counts.critical,
        score.counts.hardBraking,
        score.counts.hardAcceleration,
        startLat,
        startLon,
      ],
    );
    return { trip: updated.rows[0] as TripRow, outputs, motion: motionKinds };
  }

  /** Writes speeding outputs: one safety_event + speeding_events row per continuous episode. */
  async persistSpeeding(c: DbClient, trip: TripRow, o: SpeedingOutput): Promise<string> {
    const e = o.event;
    if (o.type === 'started') {
      const se = await c.query<{ id: string }>(
        `INSERT INTO safety_events (family_id, driver_id, trip_id, type, severity, occurred_at, lat, lon, data, is_demo, dedupe_key)
         VALUES ($1, $2, $3, 'SPEEDING', $4, $5, $6, $7, '{}', $8, $9) RETURNING id`,
        [
          trip.family_id,
          trip.driver_id,
          trip.id,
          e.severity,
          new Date(e.startTime),
          e.startLocation.lat,
          e.startLocation.lon,
          trip.is_demo,
          `SPEEDING:${e.startTime}`,
        ],
      );
      const id = (se.rows[0] as { id: string }).id;
      await c.query(
        `INSERT INTO speeding_events (id, trip_id, status, start_time, duration_s, start_speed_kmh, max_speed_kmh, speed_limit_kmh,
           max_excess_kmh, max_excess_pct, severity, start_lat, start_lon, max_lat, max_lon, road, limit_source)
         VALUES ($1, $2, 'OPEN', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          id,
          trip.id,
          new Date(e.startTime),
          e.durationSec,
          e.startSpeedKmh,
          e.maxSpeedKmh,
          e.speedLimitKmh,
          e.maxExcessKmh,
          e.maxExcessPct,
          e.severity,
          e.startLocation.lat,
          e.startLocation.lon,
          e.maxLocation.lat,
          e.maxLocation.lon,
          e.road,
          e.limitSource,
        ],
      );
      return id;
    }
    const open = await c.query<{ id: string }>(
      `SELECT id FROM speeding_events WHERE trip_id = $1 AND status = 'OPEN'`,
      [trip.id],
    );
    const id = open.rows[0]?.id;
    if (!id) throw conflict('No open speeding event to update');
    await c.query(
      `UPDATE speeding_events SET duration_s = $2, max_speed_kmh = $3, speed_limit_kmh = $4, max_excess_kmh = $5,
         max_excess_pct = $6, severity = $7, max_lat = $8, max_lon = $9,
         status = CASE WHEN $10 THEN 'CLOSED' ELSE status END,
         end_time = CASE WHEN $10 THEN $11::timestamptz ELSE end_time END,
         end_reason = CASE WHEN $10 THEN $12 ELSE end_reason END
       WHERE id = $1`,
      [
        id,
        e.durationSec,
        e.maxSpeedKmh,
        e.speedLimitKmh,
        e.maxExcessKmh,
        e.maxExcessPct,
        e.severity,
        e.maxLocation.lat,
        e.maxLocation.lon,
        o.type === 'ended',
        e.endTime ? new Date(e.endTime) : null,
        o.type === 'ended' ? o.reason : null,
      ],
    );
    await c.query(
      `UPDATE safety_events SET severity = $2, ended_at = $3,
         data = jsonb_build_object('maxSpeedKmh', $4::float8, 'speedLimitKmh', $5::float8, 'maxExcessKmh', $6::float8,
                                   'maxExcessPct', $7::float8, 'durationSec', $8::int)
       WHERE id = $1`,
      [
        id,
        e.severity,
        o.type === 'ended' && e.endTime ? new Date(e.endTime) : null,
        e.maxSpeedKmh,
        e.speedLimitKmh,
        e.maxExcessKmh,
        e.maxExcessPct,
        e.durationSec,
      ],
    );
    return id;
  }

  async notifyOutputs(
    trip: TripRow,
    name: string,
    outputs: Array<{ out: SpeedingOutput; eventId: string }>,
  ): Promise<void> {
    for (const { out, eventId } of outputs) {
      const e = out.event;
      const base = {
        familyId: trip.family_id,
        driverId: trip.driver_id,
        tripId: trip.id,
        isDemo: trip.is_demo,
      };
      if (out.type === 'started' || out.type === 'escalated') {
        const sev = (out.type === 'started' ? e.severity : out.to) as
          'ATTENTION' | 'WARNING' | 'CRITICAL';
        await this.d.notifications.notifyParents({
          ...base,
          type: `SPEEDING_${sev}`,
          severity: sev,
          dedupeKey: `${trip.id}:speeding:${eventId}:${sev}`,
          titleKey: 'event.speeding',
          bodyKey: 'notify.speeding',
          vars: {
            name,
            severity: `i18n:severity.${sev}`,
            speed: Math.round(e.maxSpeedKmh),
            limit: Math.round(e.speedLimitKmh),
          },
          data: {
            eventId,
            severity: sev,
            maxSpeedKmh: e.maxSpeedKmh,
            speedLimitKmh: e.speedLimitKmh,
            maxExcessPct: Math.round(e.maxExcessPct),
          },
        });
        await this.d.bus.publish(familyChannel(trip.family_id), {
          type: out.type === 'started' ? 'speeding.started' : 'speeding.escalated',
          data: { tripId: trip.id, driverId: trip.driver_id, eventId, severity: sev, event: e },
        });
      } else {
        await this.d.notifications.notifyParents({
          ...base,
          type: 'SPEEDING_ENDED',
          dedupeKey: `${trip.id}:speeding:${eventId}:ended`,
          cooldownGroup: `${trip.driver_id}:SPEEDING_ENDED:${eventId}`,
          titleKey: 'event.speeding',
          bodyKey: 'notify.speedingEnded',
          vars: { name, duration: formatDuration(e.durationSec) },
          data: {
            eventId,
            durationSec: e.durationSec,
            maxSpeedKmh: e.maxSpeedKmh,
            severity: e.severity,
          },
        });
        await this.d.bus.publish(familyChannel(trip.family_id), {
          type: 'speeding.ended',
          data: {
            tripId: trip.id,
            driverId: trip.driver_id,
            eventId,
            reason: out.reason,
            event: e,
          },
        });
      }
    }
  }
}

/** Maps the engine's live status onto the explicit trip state machine. */
export function nextState(current: TripState, status: string, remote: boolean): TripState {
  let ev: TripStateEvent;
  switch (status) {
    case 'ATTENTION':
    case 'WARNING':
    case 'CRITICAL':
    case 'SAFE':
      ev = severityEvent(status);
      break;
    case 'LIMIT_UNAVAILABLE':
      ev = 'LIMIT_UNAVAILABLE';
      break;
    case 'GPS_UNRELIABLE':
      ev = 'LOCATION_LOST';
      break;
    default:
      return current;
  }
  if (current === 'SOS' || current === 'PAUSED') return current;
  if (!canTransition(current, ev)) return current;
  const to = transition(current, ev);
  return to === 'ACTIVE' && remote ? 'REMOTE_MONITORING_ACTIVE' : to;
}
