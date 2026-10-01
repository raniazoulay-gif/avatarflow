/**
 * Every tunable number of the safety engine lives here. Nothing in the engine
 * hard-codes a threshold: callers pass a SafetyConfig (defaults below, overridable
 * per country / family through app_config in the database).
 */

export type Severity = 'SAFE' | 'ATTENTION' | 'WARNING' | 'CRITICAL';

/** Ordered from least to most severe. */
export const SEVERITY_ORDER: readonly Severity[] = ['SAFE', 'ATTENTION', 'WARNING', 'CRITICAL'];

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER.indexOf(s);
}

export interface SeverityThresholds {
  /** Minimum excess percentage (inclusive) for each level. */
  attentionPct: number;
  warningPct: number;
  criticalPct: number;
}

export interface SpeedingConfig {
  thresholds: SeverityThresholds;
  /** Continuous seconds above the ATTENTION threshold before a speeding event exists. */
  confirmationSeconds: number;
  /** Continuous seconds a higher severity must hold before an escalation is reported. */
  escalationConfirmSeconds: number;
  /** Continuous seconds below the threshold before an open event is closed. */
  endConfirmSeconds: number;
  /** A gap between samples longer than this breaks continuity. */
  maxSampleGapSeconds: number;
  /** An open event with no usable sample for this long is closed at the last sample. */
  staleEventSeconds: number;
  /** Samples with worse horizontal accuracy are not used for speeding decisions. */
  maxAccuracyMeters: number;
  /** Speed-limit answers below this confidence are treated as "unavailable". */
  minLimitConfidence: number;
}

export interface MotionConfig {
  /** Deceleration (m/s^2) at or above which a hard-braking event is recorded. */
  hardBrakingMs2: number;
  /** Acceleration (m/s^2) at or above which a hard-acceleration event is recorded. */
  hardAccelerationMs2: number;
  /** Samples further apart than this are not used (derivative too coarse). */
  maxDeltaSeconds: number;
  /** Minimum seconds between two events of the same kind. */
  cooldownSeconds: number;
  maxAccuracyMeters: number;
  /** Ignore motion while the vehicle is effectively stopped. */
  minSpeedKmh: number;
}

export interface ScoreConfig {
  start: number;
  speedingPenalty: Record<Exclude<Severity, 'SAFE'>, number>;
  /** Extra penalty per full block of `speedingDurationBlockSeconds` of speeding. */
  speedingDurationPenaltyPerBlock: number;
  speedingDurationBlockSeconds: number;
  /** Cap of the duration part for a single event. */
  speedingDurationPenaltyCap: number;
  hardBraking: number;
  hardAcceleration: number;
  phoneUsage: number;
  /** Each repeated event of the same category in one trip multiplies its penalty by this. */
  repeatMultiplier: number;
  repeatMultiplierCap: number;
}

export interface SafetyConfig {
  speeding: SpeedingConfig;
  motion: MotionConfig;
  score: ScoreConfig;
}

export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  speeding: {
    thresholds: { attentionPct: 10, warningPct: 30, criticalPct: 50 },
    confirmationSeconds: 10,
    escalationConfirmSeconds: 3,
    endConfirmSeconds: 3,
    maxSampleGapSeconds: 15,
    staleEventSeconds: 60,
    maxAccuracyMeters: 50,
    minLimitConfidence: 0.6,
  },
  motion: {
    hardBrakingMs2: 3.5,
    hardAccelerationMs2: 3.0,
    maxDeltaSeconds: 3,
    cooldownSeconds: 10,
    maxAccuracyMeters: 25,
    minSpeedKmh: 5,
  },
  score: {
    start: 100,
    speedingPenalty: { ATTENTION: 2, WARNING: 5, CRITICAL: 10 },
    speedingDurationPenaltyPerBlock: 1,
    speedingDurationBlockSeconds: 30,
    speedingDurationPenaltyCap: 10,
    hardBraking: 1.5,
    hardAcceleration: 1,
    phoneUsage: 3,
    repeatMultiplier: 1.25,
    repeatMultiplierCap: 2,
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch) || !isPlainObject(base)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = (base as Record<string, unknown>)[k];
    out[k] = isPlainObject(cur) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

/** Applies overrides (from configuration storage) and validates the result. */
export function resolveSafetyConfig(overrides?: DeepPartial<SafetyConfig>): SafetyConfig {
  const cfg = deepMerge(DEFAULT_SAFETY_CONFIG, overrides ?? {});
  validateSafetyConfig(cfg);
  return cfg;
}

export function validateSafetyConfig(cfg: SafetyConfig): void {
  const t = cfg.speeding.thresholds;
  if (!(t.attentionPct > 0 && t.attentionPct < t.warningPct && t.warningPct < t.criticalPct)) {
    throw new Error('Severity thresholds must be positive and strictly increasing');
  }
  if (cfg.speeding.confirmationSeconds < 0) throw new Error('confirmationSeconds must be >= 0');
  if (cfg.speeding.minLimitConfidence < 0 || cfg.speeding.minLimitConfidence > 1) {
    throw new Error('minLimitConfidence must be within 0..1');
  }
  if (cfg.score.start <= 0) throw new Error('score.start must be positive');
}
