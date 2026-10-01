import { type SeverityThresholds, type Severity } from './config.js';

export interface Excess {
  excessKmh: number;
  excessPct: number;
}

/**
 * excess_kmh = current_speed - speed_limit
 * excess_percentage = ((current_speed - speed_limit) / speed_limit) * 100
 * Only meaningful when current_speed > speed_limit; otherwise both are 0.
 */
export function computeExcess(speedKmh: number, limitKmh: number): Excess {
  if (!(limitKmh > 0) || !Number.isFinite(speedKmh) || speedKmh <= limitKmh) {
    return { excessKmh: 0, excessPct: 0 };
  }
  const excessKmh = speedKmh - limitKmh;
  return { excessKmh, excessPct: (excessKmh / limitKmh) * 100 };
}

/** Severity for an excess percentage (thresholds are inclusive lower bounds). */
export function severityForExcess(excessPct: number, t: SeverityThresholds): Severity {
  // Tiny epsilon so 110 km/h at a 100 limit (exactly 10%) is ATTENTION despite float error.
  const pct = excessPct + 1e-9;
  if (pct >= t.criticalPct) return 'CRITICAL';
  if (pct >= t.warningPct) return 'WARNING';
  if (pct >= t.attentionPct) return 'ATTENTION';
  return 'SAFE';
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
