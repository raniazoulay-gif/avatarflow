/**
 * Hard braking / hard acceleration from consecutive GPS speed samples.
 * GPS-derived acceleration is noisy, so a sample pair is only used when both fixes
 * are accurate, close in time and the vehicle is actually moving. This is a heuristic
 * (documented in KNOWN_LIMITATIONS.md); accelerometer fusion would be more precise.
 */
import { type MotionConfig } from './config.js';
import { kmhToMs } from './units.js';

export interface MotionSample {
  t: number;
  speedKmh: number | null;
  accuracyM: number | null;
  lat: number;
  lon: number;
}

export type MotionEventType = 'HARD_BRAKING' | 'HARD_ACCELERATION';

export interface MotionEvent {
  type: MotionEventType;
  t: number;
  /** m/s^2, positive for acceleration, negative for braking. */
  accelerationMs2: number;
  fromSpeedKmh: number;
  toSpeedKmh: number;
  location: { lat: number; lon: number };
}

export interface MotionState {
  last: MotionSample | null;
  lastEventAt: Partial<Record<MotionEventType, number>>;
}

export function initialMotionState(): MotionState {
  return { last: null, lastEventAt: {} };
}

function usable(s: MotionSample, cfg: MotionConfig): boolean {
  return (
    s.speedKmh !== null &&
    Number.isFinite(s.speedKmh) &&
    (s.accuracyM === null || s.accuracyM <= cfg.maxAccuracyMeters)
  );
}

export function processMotionSample(
  prev: MotionState,
  s: MotionSample,
  cfg: MotionConfig,
): { state: MotionState; events: MotionEvent[] } {
  const state: MotionState = { last: prev.last, lastEventAt: { ...prev.lastEventAt } };
  const events: MotionEvent[] = [];
  if (prev.last && s.t <= prev.last.t) return { state: prev, events };
  if (!usable(s, cfg)) {
    state.last = null; // break the chain: never differentiate across a bad fix
    return { state, events };
  }
  const p = state.last;
  state.last = s;
  if (!p) return { state, events };
  const dt = (s.t - p.t) / 1000;
  if (dt <= 0 || dt > cfg.maxDeltaSeconds) return { state, events };
  const v0 = p.speedKmh as number;
  const v1 = s.speedKmh as number;
  if (Math.max(v0, v1) < cfg.minSpeedKmh) return { state, events };
  const a = (kmhToMs(v1) - kmhToMs(v0)) / dt;
  let type: MotionEventType | null = null;
  if (a <= -cfg.hardBrakingMs2) type = 'HARD_BRAKING';
  else if (a >= cfg.hardAccelerationMs2) type = 'HARD_ACCELERATION';
  if (!type) return { state, events };
  const lastAt = state.lastEventAt[type];
  if (lastAt !== undefined && (s.t - lastAt) / 1000 < cfg.cooldownSeconds) return { state, events };
  state.lastEventAt[type] = s.t;
  events.push({
    type,
    t: s.t,
    accelerationMs2: Math.round(a * 100) / 100,
    fromSpeedKmh: v0,
    toSpeedKmh: v1,
    location: { lat: s.lat, lon: s.lon },
  });
  return { state, events };
}
