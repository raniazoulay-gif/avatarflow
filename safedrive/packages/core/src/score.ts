/**
 * SafeDrive Safety Score (0-100). Deterministic and transparent: it is a product
 * indicator for families, not a scientific, insurance or legal measure.
 *
 * Trip score = start - sum(penalties), clamped to [0, start].
 *  - Speeding event: base penalty by its max severity + duration penalty
 *    (per full block of N seconds, capped per event).
 *  - Hard braking / hard acceleration / phone usage: fixed penalty each.
 *  - Repetition: the k-th event of the same category in one trip is multiplied by
 *    repeatMultiplier^(k-1), capped at repeatMultiplierCap.
 * Driver score = distance-weighted average of recent trip scores (short trips count
 * at least `minWeightKm` so a 200 m trip is not ignored).
 */
import { type ScoreConfig, type Severity } from './config.js';

export type ScoreCategory = 'speeding' | 'hardBraking' | 'hardAcceleration' | 'phoneUsage';

export type ScoredEvent =
  | { kind: 'speeding'; severity: Exclude<Severity, 'SAFE'>; durationSec: number }
  | { kind: 'hardBraking' }
  | { kind: 'hardAcceleration' }
  | { kind: 'phoneUsage' };

export interface ScoreBreakdown {
  score: number;
  /** Negative numbers, rounded to 1 decimal, per category. */
  breakdown: Record<ScoreCategory, number>;
  eventCount: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

export function basePenalty(e: ScoredEvent, cfg: ScoreConfig): number {
  switch (e.kind) {
    case 'speeding': {
      const blocks = Math.floor(Math.max(0, e.durationSec) / cfg.speedingDurationBlockSeconds);
      const duration = Math.min(
        cfg.speedingDurationPenaltyCap,
        blocks * cfg.speedingDurationPenaltyPerBlock,
      );
      return cfg.speedingPenalty[e.severity] + duration;
    }
    case 'hardBraking':
      return cfg.hardBraking;
    case 'hardAcceleration':
      return cfg.hardAcceleration;
    case 'phoneUsage':
      return cfg.phoneUsage;
  }
}

export function computeTripScore(events: readonly ScoredEvent[], cfg: ScoreConfig): ScoreBreakdown {
  const totals: Record<ScoreCategory, number> = {
    speeding: 0,
    hardBraking: 0,
    hardAcceleration: 0,
    phoneUsage: 0,
  };
  const seen: Record<ScoreCategory, number> = {
    speeding: 0,
    hardBraking: 0,
    hardAcceleration: 0,
    phoneUsage: 0,
  };
  for (const e of events) {
    const k = e.kind;
    const mult = Math.min(cfg.repeatMultiplierCap, cfg.repeatMultiplier ** seen[k]);
    seen[k] += 1;
    totals[k] += basePenalty(e, cfg) * mult;
  }
  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  const score = Math.max(0, Math.min(cfg.start, cfg.start - total));
  return {
    score: Math.round(score),
    breakdown: {
      speeding: -round1(totals.speeding),
      hardBraking: -round1(totals.hardBraking),
      hardAcceleration: -round1(totals.hardAcceleration),
      phoneUsage: -round1(totals.phoneUsage),
    },
    eventCount: events.length,
  };
}

export interface TripScoreInput {
  score: number;
  distanceKm: number;
}

export function aggregateDriverScore(
  trips: readonly TripScoreInput[],
  minWeightKm = 1,
): number | null {
  if (trips.length === 0) return null;
  let wSum = 0;
  let sSum = 0;
  for (const t of trips) {
    const w = Math.max(minWeightKm, t.distanceKm);
    wSum += w;
    sSum += w * t.score;
  }
  return Math.round(sSum / wSum);
}
