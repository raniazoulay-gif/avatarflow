import { type LiveTripView, type Severity, type TripState } from '@safedrive/core';
import { type Queryable } from '../db/pool.js';

export interface TripRow {
  id: string;
  family_id: string;
  driver_id: string;
  device_id: string | null;
  state: TripState;
  is_demo: boolean;
  demo_scenario: string | null;
  started_by: string;
  monitoring_request_id: string | null;
  started_at: Date;
  ended_at: Date | null;
  start_lat: number | null;
  start_lon: number | null;
  end_lat: number | null;
  end_lon: number | null;
  distance_m: number;
  moving_seconds: number;
  max_speed_kmh: number;
  speeding_count: number;
  critical_count: number;
  hard_braking_count: number;
  hard_acceleration_count: number;
  phone_usage_count: number;
  score: number;
  score_breakdown: Record<string, number>;
  engine_state: Record<string, unknown>;
  live: LiveSnapshot;
  last_seq: number;
  last_point_at: Date | null;
}

export interface LiveSnapshot {
  lat?: number;
  lon?: number;
  accuracyM?: number | null;
  speedKmh?: number | null;
  limitKmh?: number | null;
  limitSource?: string | null;
  road?: string | null;
  excessKmh?: number;
  excessPct?: number;
  severity?: Severity;
  speedingSeconds?: number | null;
  confirming?: boolean;
}

export function connectionStatus(lastPointAt: Date | null, now: number, offlineAfterSec: number): LiveTripView['connection'] {
  if (!lastPointAt) return 'stale';
  const age = (now - lastPointAt.getTime()) / 1000;
  if (age <= 30) return 'online';
  if (age <= offlineAfterSec) return 'stale';
  return 'offline';
}

export function liveView(trip: TripRow, driverName: string, offlineAfterSec: number, now = Date.now()): LiveTripView {
  const l = trip.live ?? {};
  return {
    tripId: trip.id,
    driverId: trip.driver_id,
    driverName,
    isDemo: trip.is_demo,
    state: trip.state,
    startedAt: trip.started_at.toISOString(),
    lastUpdateAt: trip.last_point_at ? trip.last_point_at.toISOString() : null,
    location: l.lat !== undefined && l.lon !== undefined ? { lat: l.lat, lon: l.lon, accuracyM: l.accuracyM ?? null } : null,
    speedKmh: l.speedKmh ?? null,
    limitKmh: l.limitKmh ?? null,
    limitSource: l.limitSource ?? null,
    excessKmh: Math.round((l.excessKmh ?? 0) * 10) / 10,
    excessPct: Math.round((l.excessPct ?? 0) * 10) / 10,
    severity: l.severity ?? 'SAFE',
    speedingSeconds: l.speedingSeconds ?? null,
    confirming: l.confirming ?? false,
    score: trip.score,
    connection: trip.ended_at ? 'offline' : connectionStatus(trip.last_point_at, now, offlineAfterSec),
  };
}

export async function driverName(db: Queryable, driverId: string): Promise<string> {
  const r = await db.query<{ display_name: string }>('SELECT display_name FROM drivers WHERE id = $1', [driverId]);
  return r.rows[0]?.display_name ?? '';
}
