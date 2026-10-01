/**
 * Explicit trip state machine. Core trip status is never derived from loose
 * boolean flags: every change goes through `transition`, which rejects anything
 * not listed in TRANSITIONS.
 */

export const TRIP_STATES = [
  'IDLE',
  'REMOTE_MONITORING_REQUESTED',
  'PERMISSION_REQUIRED',
  'STARTING',
  'ACTIVE',
  'REMOTE_MONITORING_ACTIVE',
  'ATTENTION',
  'WARNING',
  'CRITICAL',
  'LOCATION_UNAVAILABLE',
  'SPEED_LIMIT_UNAVAILABLE',
  'PAUSED',
  'SOS',
  'ENDING',
  'COMPLETED',
  'ERROR',
] as const;

export type TripState = (typeof TRIP_STATES)[number];

export type TripStateEvent =
  | 'REQUEST_REMOTE'
  | 'PERMISSION_MISSING'
  | 'PERMISSION_GRANTED'
  | 'START'
  | 'STARTED'
  | 'STARTED_REMOTE'
  | 'SEVERITY_SAFE'
  | 'SEVERITY_ATTENTION'
  | 'SEVERITY_WARNING'
  | 'SEVERITY_CRITICAL'
  | 'LOCATION_LOST'
  | 'LOCATION_RESTORED'
  | 'LIMIT_UNAVAILABLE'
  | 'LIMIT_AVAILABLE'
  | 'PAUSE'
  | 'RESUME'
  | 'SOS'
  | 'SOS_RESOLVED'
  | 'STOP'
  | 'STOPPED'
  | 'FAIL'
  | 'RESET';

/** States in which a trip is live (telemetry accepted). */
export const LIVE_STATES: readonly TripState[] = [
  'ACTIVE',
  'REMOTE_MONITORING_ACTIVE',
  'ATTENTION',
  'WARNING',
  'CRITICAL',
  'LOCATION_UNAVAILABLE',
  'SPEED_LIMIT_UNAVAILABLE',
  'PAUSED',
  'SOS',
];

const LIVE_COMMON: Partial<Record<TripStateEvent, TripState>> = {
  SEVERITY_SAFE: 'ACTIVE',
  SEVERITY_ATTENTION: 'ATTENTION',
  SEVERITY_WARNING: 'WARNING',
  SEVERITY_CRITICAL: 'CRITICAL',
  LOCATION_LOST: 'LOCATION_UNAVAILABLE',
  LIMIT_UNAVAILABLE: 'SPEED_LIMIT_UNAVAILABLE',
  PAUSE: 'PAUSED',
  SOS: 'SOS',
  STOP: 'ENDING',
  FAIL: 'ERROR',
};

const TRANSITIONS: Record<TripState, Partial<Record<TripStateEvent, TripState>>> = {
  IDLE: { START: 'STARTING', REQUEST_REMOTE: 'REMOTE_MONITORING_REQUESTED', PERMISSION_MISSING: 'PERMISSION_REQUIRED', SOS: 'SOS' },
  REMOTE_MONITORING_REQUESTED: { STARTED_REMOTE: 'REMOTE_MONITORING_ACTIVE', START: 'STARTING', PERMISSION_MISSING: 'PERMISSION_REQUIRED', RESET: 'IDLE' },
  PERMISSION_REQUIRED: { PERMISSION_GRANTED: 'IDLE', RESET: 'IDLE' },
  STARTING: { STARTED: 'ACTIVE', STARTED_REMOTE: 'REMOTE_MONITORING_ACTIVE', PERMISSION_MISSING: 'PERMISSION_REQUIRED', FAIL: 'ERROR', STOP: 'ENDING' },
  ACTIVE: { ...LIVE_COMMON },
  REMOTE_MONITORING_ACTIVE: { ...LIVE_COMMON },
  ATTENTION: { ...LIVE_COMMON },
  WARNING: { ...LIVE_COMMON },
  CRITICAL: { ...LIVE_COMMON },
  LOCATION_UNAVAILABLE: { ...LIVE_COMMON, LOCATION_RESTORED: 'ACTIVE', LOCATION_LOST: 'LOCATION_UNAVAILABLE' },
  SPEED_LIMIT_UNAVAILABLE: { ...LIVE_COMMON, LIMIT_AVAILABLE: 'ACTIVE', LIMIT_UNAVAILABLE: 'SPEED_LIMIT_UNAVAILABLE' },
  PAUSED: { RESUME: 'ACTIVE', STOP: 'ENDING', SOS: 'SOS', FAIL: 'ERROR' },
  SOS: { SOS_RESOLVED: 'ACTIVE', STOP: 'ENDING', SOS: 'SOS', FAIL: 'ERROR' },
  ENDING: { STOPPED: 'COMPLETED', FAIL: 'ERROR' },
  COMPLETED: { RESET: 'IDLE' },
  ERROR: { RESET: 'IDLE', STOP: 'ENDING' },
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TripState,
    public readonly event: TripStateEvent,
  ) {
    super(`Invalid trip transition: ${from} --${event}-->`);
  }
}

export function canTransition(from: TripState, event: TripStateEvent): boolean {
  return TRANSITIONS[from][event] !== undefined;
}

export function transition(from: TripState, event: TripStateEvent): TripState {
  const to = TRANSITIONS[from][event];
  if (!to) throw new InvalidTransitionError(from, event);
  return to;
}

export function isLive(state: TripState): boolean {
  return LIVE_STATES.includes(state);
}

/** Severity-driven event for a live trip (no-op when already in that state). */
export function severityEvent(sev: 'SAFE' | 'ATTENTION' | 'WARNING' | 'CRITICAL'): TripStateEvent {
  return `SEVERITY_${sev}` as TripStateEvent;
}
