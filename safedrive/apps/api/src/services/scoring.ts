import {
  computeTripScore,
  aggregateDriverScore,
  type SafetyConfig,
  type ScoredEvent,
  type ScoreBreakdown,
} from '@safedrive/core';
import { type Queryable } from '../db/pool.js';

/** Recomputes a trip's score from its stored events (deterministic). */
export async function scoreTrip(
  db: Queryable,
  tripId: string,
  cfg: SafetyConfig,
): Promise<ScoreBreakdown & { counts: Record<string, number> }> {
  const sp = await db.query<{ severity: 'ATTENTION' | 'WARNING' | 'CRITICAL'; duration_s: number }>(
    `SELECT severity, duration_s FROM speeding_events WHERE trip_id = $1 ORDER BY start_time`,
    [tripId],
  );
  const other = await db.query<{ type: string }>(
    `SELECT type FROM safety_events WHERE trip_id = $1 AND type IN ('HARD_BRAKING', 'HARD_ACCELERATION', 'PHONE_USAGE') ORDER BY occurred_at`,
    [tripId],
  );
  const events: ScoredEvent[] = [
    ...sp.rows.map((r) => ({
      kind: 'speeding' as const,
      severity: r.severity,
      durationSec: r.duration_s,
    })),
    ...other.rows.map((r) =>
      r.type === 'HARD_BRAKING'
        ? ({ kind: 'hardBraking' } as const)
        : r.type === 'HARD_ACCELERATION'
          ? ({ kind: 'hardAcceleration' } as const)
          : ({ kind: 'phoneUsage' } as const),
    ),
  ];
  const res = computeTripScore(events, cfg.score);
  return {
    ...res,
    counts: {
      speeding: sp.rowCount ?? 0,
      critical: sp.rows.filter((r) => r.severity === 'CRITICAL').length,
      hardBraking: other.rows.filter((r) => r.type === 'HARD_BRAKING').length,
      hardAcceleration: other.rows.filter((r) => r.type === 'HARD_ACCELERATION').length,
      phoneUsage: other.rows.filter((r) => r.type === 'PHONE_USAGE').length,
    },
  };
}

/** Driver score: distance-weighted average of the last 20 completed real (non-demo) trips. */
export async function refreshDriverScore(db: Queryable, driverId: string): Promise<number | null> {
  const { rows } = await db.query<{ score: number; distance_m: number }>(
    `SELECT score, distance_m FROM trips WHERE driver_id = $1 AND ended_at IS NOT NULL AND NOT is_demo
     ORDER BY started_at DESC LIMIT 20`,
    [driverId],
  );
  const score = aggregateDriverScore(
    rows.map((r) => ({ score: r.score, distanceKm: r.distance_m / 1000 })),
  );
  await db.query('UPDATE drivers SET safety_score = $2, score_updated_at = now() WHERE id = $1', [
    driverId,
    score,
  ]);
  if (score !== null) {
    await db.query(
      `INSERT INTO safety_scores (driver_id, scope, score) VALUES ($1, 'driver_rolling', $2)`,
      [driverId, score],
    );
  }
  return score;
}
