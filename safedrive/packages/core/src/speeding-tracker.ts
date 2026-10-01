/**
 * Continuous-speeding detector. Pure and serialisable: the server stores the state
 * per trip, the mobile app runs the same code for the driver's own screen.
 *
 * Rules (all durations from SpeedingConfig):
 *  - A sample counts as "speeding" when speed > limit AND the excess reaches the
 *    ATTENTION threshold, with a usable GPS fix and a confident speed limit.
 *  - A speeding EVENT starts only after `confirmationSeconds` of continuous speeding.
 *    Dropping back to/below the threshold before that resets the timer.
 *  - While open, the event tracks maxima. A higher severity that holds for
 *    `escalationConfirmSeconds` is reported once as an escalation.
 *  - The event closes after `endConfirmSeconds` back under the threshold, when the
 *    limit becomes unavailable, when samples stop (gap/stale) or when the trip ends.
 *  - No limit (or a low-confidence one) never produces a violation.
 */
import { type Severity, type SpeedingConfig, severityRank } from './config.js';
import { computeExcess, severityForExcess } from './speed.js';

export interface SpeedLimitInfo {
  kmh: number;
  confidence: number;
  source: string;
  road?: string | null;
}

export interface SpeedSample {
  /** Epoch milliseconds (device time of the GPS fix). */
  t: number;
  speedKmh: number | null;
  limit: SpeedLimitInfo | null;
  lat: number;
  lon: number;
  accuracyM: number | null;
}

export interface SpeedingSnapshot {
  startTime: number;
  endTime: number | null;
  durationSec: number;
  startSpeedKmh: number;
  maxSpeedKmh: number;
  speedLimitKmh: number;
  maxExcessKmh: number;
  maxExcessPct: number;
  severity: Severity;
  startLocation: { lat: number; lon: number };
  maxLocation: { lat: number; lon: number };
  road: string | null;
  limitSource: string;
}

export type SpeedingEndReason = 'recovered' | 'limit_unavailable' | 'gap' | 'stale' | 'trip_end';

export type SpeedingOutput =
  | { type: 'started'; event: SpeedingSnapshot }
  | { type: 'escalated'; from: Severity; to: Severity; event: SpeedingSnapshot }
  | { type: 'ended'; reason: SpeedingEndReason; event: SpeedingSnapshot };

interface Window {
  since: number;
  /** Lowest severity seen since `since` = the level held continuously. */
  heldSeverity: Severity;
}

interface OpenEvent {
  startTime: number;
  lastSpeedingTime: number;
  startSpeedKmh: number;
  maxSpeedKmh: number;
  speedLimitKmh: number;
  maxExcessKmh: number;
  maxExcessPct: number;
  severity: Severity;
  startLocation: { lat: number; lon: number };
  maxLocation: { lat: number; lon: number };
  road: string | null;
  limitSource: string;
  escalation: Window | null;
  belowSince: number | null;
}

export interface SpeedingState {
  candidate: (Window & { start: Omit<OpenEvent, 'escalation' | 'belowSince' | 'severity'> }) | null;
  event: OpenEvent | null;
  lastSampleTime: number | null;
}

export type LiveSpeedStatus =
  'SAFE' | 'ATTENTION' | 'WARNING' | 'CRITICAL' | 'LIMIT_UNAVAILABLE' | 'GPS_UNRELIABLE';

export interface LiveSpeedInfo {
  /** Confirmed status (only an open event raises it above SAFE). */
  status: LiveSpeedStatus;
  speedKmh: number | null;
  limitKmh: number | null;
  excessKmh: number;
  excessPct: number;
  /** Severity of this very sample, before any confirmation. */
  instantSeverity: Severity;
  /** Seconds the current over-limit stretch has lasted (candidate or event), else null. */
  speedingSeconds: number | null;
  /** True while over the threshold but not yet confirmed (the 10-second window). */
  confirming: boolean;
}

export interface SpeedingStepResult {
  state: SpeedingState;
  outputs: SpeedingOutput[];
  live: LiveSpeedInfo;
}

export function initialSpeedingState(): SpeedingState {
  return { candidate: null, event: null, lastSampleTime: null };
}

const minSeverity = (a: Severity, b: Severity): Severity =>
  severityRank(a) <= severityRank(b) ? a : b;

function snapshot(e: OpenEvent, endTime: number | null): SpeedingSnapshot {
  const end = endTime ?? e.lastSpeedingTime;
  return {
    startTime: e.startTime,
    endTime,
    durationSec: Math.max(0, Math.round((end - e.startTime) / 1000)),
    startSpeedKmh: e.startSpeedKmh,
    maxSpeedKmh: e.maxSpeedKmh,
    speedLimitKmh: e.speedLimitKmh,
    maxExcessKmh: e.maxExcessKmh,
    maxExcessPct: e.maxExcessPct,
    severity: e.severity,
    startLocation: e.startLocation,
    maxLocation: e.maxLocation,
    road: e.road,
    limitSource: e.limitSource,
  };
}

function clone(s: SpeedingState): SpeedingState {
  return JSON.parse(JSON.stringify(s)) as SpeedingState;
}

export function processSpeedSample(
  prev: SpeedingState,
  s: SpeedSample,
  cfg: SpeedingConfig,
): SpeedingStepResult {
  const state = clone(prev);
  const outputs: SpeedingOutput[] = [];
  const close = (reason: SpeedingEndReason, endTime: number): void => {
    if (!state.event) return;
    outputs.push({ type: 'ended', reason, event: snapshot(state.event, endTime) });
    state.event = null;
  };
  const baseLive: LiveSpeedInfo = {
    status: 'SAFE',
    speedKmh: s.speedKmh,
    limitKmh: s.limit?.kmh ?? null,
    excessKmh: 0,
    excessPct: 0,
    instantSeverity: 'SAFE',
    speedingSeconds: null,
    confirming: false,
  };

  // Out-of-order or duplicate sample: ignore (the caller orders by sequence).
  if (state.lastSampleTime !== null && s.t <= state.lastSampleTime) {
    return { state: prev, outputs, live: { ...baseLive, status: liveStatus(prev) } };
  }

  const gap =
    state.lastSampleTime !== null && (s.t - state.lastSampleTime) / 1000 > cfg.maxSampleGapSeconds;
  if (gap) {
    state.candidate = null;
    if (state.event) close('gap', state.event.lastSpeedingTime);
  }
  state.lastSampleTime = s.t;

  const usable =
    s.speedKmh !== null &&
    Number.isFinite(s.speedKmh) &&
    s.speedKmh >= 0 &&
    (s.accuracyM === null || s.accuracyM <= cfg.maxAccuracyMeters);
  if (!usable) {
    state.candidate = null;
    if (state.event && (s.t - state.event.lastSpeedingTime) / 1000 > cfg.staleEventSeconds) {
      close('stale', state.event.lastSpeedingTime);
    }
    return {
      state,
      outputs,
      live: { ...baseLive, status: state.event ? state.event.severity : 'GPS_UNRELIABLE' },
    };
  }

  const limitOk =
    s.limit !== null && s.limit.kmh > 0 && s.limit.confidence >= cfg.minLimitConfidence;
  if (!limitOk) {
    state.candidate = null;
    if (state.event) close('limit_unavailable', state.event.lastSpeedingTime);
    return { state, outputs, live: { ...baseLive, limitKmh: null, status: 'LIMIT_UNAVAILABLE' } };
  }

  const speed = s.speedKmh as number;
  const limit = s.limit as SpeedLimitInfo;
  const { excessKmh, excessPct } = computeExcess(speed, limit.kmh);
  const sev = severityForExcess(excessPct, cfg.thresholds);
  const live: LiveSpeedInfo = { ...baseLive, excessKmh, excessPct, instantSeverity: sev };
  const loc = { lat: s.lat, lon: s.lon };

  if (sev !== 'SAFE') {
    if (state.event) {
      const e = state.event;
      e.lastSpeedingTime = s.t;
      e.belowSince = null;
      if (speed > e.maxSpeedKmh) {
        e.maxSpeedKmh = speed;
        e.maxLocation = loc;
        e.speedLimitKmh = limit.kmh;
      }
      if (excessKmh > e.maxExcessKmh) e.maxExcessKmh = excessKmh;
      if (excessPct > e.maxExcessPct) e.maxExcessPct = excessPct;
      if (severityRank(sev) > severityRank(e.severity)) {
        e.escalation = e.escalation
          ? { since: e.escalation.since, heldSeverity: minSeverity(e.escalation.heldSeverity, sev) }
          : { since: s.t, heldSeverity: sev };
        if ((s.t - e.escalation.since) / 1000 >= cfg.escalationConfirmSeconds) {
          const from = e.severity;
          e.severity = e.escalation.heldSeverity;
          e.escalation = null;
          outputs.push({ type: 'escalated', from, to: e.severity, event: snapshot(e, null) });
        }
      } else {
        e.escalation = null;
      }
      live.speedingSeconds = Math.round((s.t - e.startTime) / 1000);
    } else {
      if (!state.candidate) {
        state.candidate = {
          since: s.t,
          heldSeverity: sev,
          start: {
            startTime: s.t,
            lastSpeedingTime: s.t,
            startSpeedKmh: speed,
            maxSpeedKmh: speed,
            speedLimitKmh: limit.kmh,
            maxExcessKmh: excessKmh,
            maxExcessPct: excessPct,
            startLocation: loc,
            maxLocation: loc,
            road: limit.road ?? null,
            limitSource: limit.source,
          },
        };
      } else {
        const c = state.candidate;
        c.heldSeverity = minSeverity(c.heldSeverity, sev);
        c.start.lastSpeedingTime = s.t;
        if (speed > c.start.maxSpeedKmh) {
          c.start.maxSpeedKmh = speed;
          c.start.maxLocation = loc;
          c.start.speedLimitKmh = limit.kmh;
        }
        if (excessKmh > c.start.maxExcessKmh) c.start.maxExcessKmh = excessKmh;
        if (excessPct > c.start.maxExcessPct) c.start.maxExcessPct = excessPct;
      }
      const c = state.candidate;
      const held = (s.t - c.since) / 1000;
      live.speedingSeconds = Math.round(held);
      if (held >= cfg.confirmationSeconds) {
        state.event = { ...c.start, severity: c.heldSeverity, escalation: null, belowSince: null };
        state.candidate = null;
        outputs.push({ type: 'started', event: snapshot(state.event, null) });
      } else {
        live.confirming = true;
      }
    }
  } else {
    state.candidate = null;
    if (state.event) {
      const e = state.event;
      e.escalation = null;
      if (e.belowSince === null) e.belowSince = s.t;
      if ((s.t - e.belowSince) / 1000 >= cfg.endConfirmSeconds) {
        close('recovered', e.belowSince);
      }
    }
  }

  live.status = liveStatus(state);
  return { state, outputs, live };
}

/** Closes any open event (trip finished). */
export function finishSpeeding(prev: SpeedingState): SpeedingStepResult {
  const state = clone(prev);
  const outputs: SpeedingOutput[] = [];
  if (state.event) {
    outputs.push({
      type: 'ended',
      reason: 'trip_end',
      event: snapshot(state.event, state.event.lastSpeedingTime),
    });
  }
  state.event = null;
  state.candidate = null;
  return {
    state,
    outputs,
    live: {
      status: 'SAFE',
      speedKmh: null,
      limitKmh: null,
      excessKmh: 0,
      excessPct: 0,
      instantSeverity: 'SAFE',
      speedingSeconds: null,
      confirming: false,
    },
  };
}

function liveStatus(s: SpeedingState): LiveSpeedStatus {
  return s.event ? s.event.severity : 'SAFE';
}

/** Snapshot of the open event, if any (for dashboards). */
export function currentSpeedingEvent(s: SpeedingState): SpeedingSnapshot | null {
  return s.event ? snapshot(s.event, null) : null;
}
