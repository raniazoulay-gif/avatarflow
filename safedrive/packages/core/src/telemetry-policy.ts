/**
 * Adaptive location / upload cadence, to save battery and data. The mobile app
 * asks this policy how often to sample and upload given the current conditions.
 */

export type MovementClass = 'MOVING_FAST' | 'MOVING' | 'STOPPED' | 'UNKNOWN';

export interface TelemetryPolicyConfig {
  movingFastKmh: number;
  stoppedKmh: number;
  intervals: Record<MovementClass, { sampleMs: number; distanceFilterM: number }>;
  /** Multiplier for the sample interval while the app is in the background. */
  backgroundFactor: number;
  /** Multiplier while battery is low (and not charging). */
  lowBatteryFactor: number;
  lowBatteryLevel: number;
  /** With poor accuracy, sample more often to recover a good fix sooner. */
  poorAccuracyM: number;
  poorAccuracySampleMs: number;
  /** Upload batches: at most this many points or this long, whichever first. */
  uploadMaxPoints: number;
  uploadMaxDelayMs: number;
  /** While speeding, upload sooner so the parent dashboard stays live. */
  uploadAlertDelayMs: number;
}

export const DEFAULT_TELEMETRY_POLICY: TelemetryPolicyConfig = {
  movingFastKmh: 60,
  stoppedKmh: 3,
  intervals: {
    MOVING_FAST: { sampleMs: 1000, distanceFilterM: 10 },
    MOVING: { sampleMs: 2000, distanceFilterM: 5 },
    STOPPED: { sampleMs: 15000, distanceFilterM: 20 },
    UNKNOWN: { sampleMs: 3000, distanceFilterM: 5 },
  },
  backgroundFactor: 1.5,
  lowBatteryFactor: 2,
  lowBatteryLevel: 0.2,
  poorAccuracyM: 50,
  poorAccuracySampleMs: 2000,
  uploadMaxPoints: 30,
  uploadMaxDelayMs: 10000,
  uploadAlertDelayMs: 2000,
};

export interface TelemetryConditions {
  speedKmh: number | null;
  accuracyM: number | null;
  background: boolean;
  batteryLevel: number | null;
  charging: boolean;
  speeding: boolean;
}

export interface TelemetryPlan {
  motion: MovementClass;
  sampleMs: number;
  distanceFilterM: number;
  uploadMaxPoints: number;
  uploadMaxDelayMs: number;
}

export function classifyMotion(speedKmh: number | null, cfg: TelemetryPolicyConfig): MovementClass {
  if (speedKmh === null || !Number.isFinite(speedKmh)) return 'UNKNOWN';
  if (speedKmh >= cfg.movingFastKmh) return 'MOVING_FAST';
  if (speedKmh <= cfg.stoppedKmh) return 'STOPPED';
  return 'MOVING';
}

export function planTelemetry(
  c: TelemetryConditions,
  cfg: TelemetryPolicyConfig = DEFAULT_TELEMETRY_POLICY,
): TelemetryPlan {
  const motion = classifyMotion(c.speedKmh, cfg);
  let { sampleMs, distanceFilterM } = cfg.intervals[motion];
  if (c.accuracyM !== null && c.accuracyM > cfg.poorAccuracyM) {
    sampleMs = Math.min(sampleMs, cfg.poorAccuracySampleMs);
  }
  if (c.background) sampleMs = Math.round(sampleMs * cfg.backgroundFactor);
  const lowBattery = !c.charging && c.batteryLevel !== null && c.batteryLevel <= cfg.lowBatteryLevel;
  // Never thin out sampling while speeding: the 10-second rule needs the data.
  if (lowBattery && !c.speeding) sampleMs = Math.round(sampleMs * cfg.lowBatteryFactor);
  return {
    motion,
    sampleMs,
    distanceFilterM,
    uploadMaxPoints: cfg.uploadMaxPoints,
    uploadMaxDelayMs: c.speeding ? cfg.uploadAlertDelayMs : cfg.uploadMaxDelayMs,
  };
}
