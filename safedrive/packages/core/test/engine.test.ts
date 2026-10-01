import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_CONFIG,
  computeTripScore,
  aggregateDriverScore,
  processMotionSample,
  initialMotionState,
  transition,
  canTransition,
  InvalidTransitionError,
  decideNotification,
  DEFAULT_NOTIFICATION_PREFERENCES,
  planTelemetry,
  OutboundQueue,
  MemoryQueueStorage,
  generateDemoPoints,
  DEMO_SCENARIOS,
  t,
  formatDuration,
  countryProfile,
  isRtl,
  type ScoredEvent,
} from '../src/index.js';

const score = DEFAULT_SAFETY_CONFIG.score;

describe('Safety Score', () => {
  it('starts at 100 with no events', () => {
    expect(computeTripScore([], score)).toEqual({
      score: 100,
      breakdown: { speeding: -0, hardBraking: -0, hardAcceleration: -0, phoneUsage: -0 },
      eventCount: 0,
    });
  });

  it('is deterministic and transparent', () => {
    const events: ScoredEvent[] = [
      { kind: 'speeding', severity: 'WARNING', durationSec: 102 }, // 5 + 3 blocks = 8
      { kind: 'hardBraking' }, // 1.5
      { kind: 'hardBraking' }, // 1.5 * 1.25 = 1.875
    ];
    const r = computeTripScore(events, score);
    expect(r.breakdown.speeding).toBe(-8);
    expect(r.breakdown.hardBraking).toBe(-3.4);
    expect(r.score).toBe(Math.round(100 - 8 - 3.375));
    expect(computeTripScore(events, score)).toEqual(r);
  });

  it('caps the duration penalty and clamps at 0', () => {
    const long = computeTripScore(
      [{ kind: 'speeding', severity: 'ATTENTION', durationSec: 10_000 }],
      score,
    );
    expect(long.breakdown.speeding).toBe(-(2 + score.speedingDurationPenaltyCap));
    const many = computeTripScore(
      Array.from(
        { length: 30 },
        () => ({ kind: 'speeding', severity: 'CRITICAL', durationSec: 600 }) as ScoredEvent,
      ),
      score,
    );
    expect(many.score).toBe(0);
  });

  it('aggregates driver scores weighted by distance', () => {
    expect(aggregateDriverScore([])).toBeNull();
    expect(
      aggregateDriverScore([
        { score: 100, distanceKm: 90 },
        { score: 0, distanceKm: 10 },
      ]),
    ).toBe(90);
    expect(
      aggregateDriverScore([
        { score: 50, distanceKm: 0.1 },
        { score: 100, distanceKm: 1 },
      ]),
    ).toBe(75);
  });
});

describe('hard braking / acceleration', () => {
  const m = DEFAULT_SAFETY_CONFIG.motion;
  const sample = (t: number, kmh: number, acc = 5) => ({
    t,
    speedKmh: kmh,
    accuracyM: acc,
    lat: 0,
    lon: 0,
  });

  it('detects hard braking and respects the cooldown', () => {
    let s = initialMotionState();
    const all = [];
    for (const [t, v] of [
      [0, 90],
      [1000, 70],
      [2000, 50],
      [3000, 45],
    ] as const) {
      const r = processMotionSample(s, sample(t, v), m);
      s = r.state;
      all.push(...r.events);
    }
    expect(all).toHaveLength(1);
    expect(all[0]!.type).toBe('HARD_BRAKING');
    expect(all[0]!.accelerationMs2).toBeLessThan(-3.5);
  });

  it('detects hard acceleration but not gentle driving', () => {
    let s = initialMotionState();
    let r = processMotionSample(s, sample(0, 10), m);
    s = r.state;
    r = processMotionSample(s, sample(1000, 25), m);
    expect(r.events[0]?.type).toBe('HARD_ACCELERATION');
    s = initialMotionState();
    r = processMotionSample(s, sample(0, 50), m);
    r = processMotionSample(r.state, sample(1000, 55), m);
    expect(r.events).toHaveLength(0);
  });

  it('ignores inaccurate fixes and long gaps', () => {
    let r = processMotionSample(initialMotionState(), sample(0, 90), m);
    r = processMotionSample(r.state, sample(1000, 40, 100), m);
    expect(r.events).toHaveLength(0);
    r = processMotionSample(initialMotionState(), sample(0, 90), m);
    r = processMotionSample(r.state, sample(10_000, 0), m);
    expect(r.events).toHaveLength(0);
  });
});

describe('trip state machine', () => {
  it('follows the normal lifecycle', () => {
    let s = transition('IDLE', 'START');
    s = transition(s, 'STARTED');
    s = transition(s, 'SEVERITY_WARNING');
    expect(s).toBe('WARNING');
    s = transition(s, 'SEVERITY_SAFE');
    s = transition(s, 'STOP');
    s = transition(s, 'STOPPED');
    expect(s).toBe('COMPLETED');
  });

  it('rejects invalid transitions', () => {
    expect(() => transition('COMPLETED', 'SEVERITY_CRITICAL')).toThrow(InvalidTransitionError);
    expect(canTransition('IDLE', 'STOPPED')).toBe(false);
  });

  it('supports remote monitoring and SOS', () => {
    let s = transition('IDLE', 'REQUEST_REMOTE');
    expect(s).toBe('REMOTE_MONITORING_REQUESTED');
    s = transition(s, 'STARTED_REMOTE');
    expect(s).toBe('REMOTE_MONITORING_ACTIVE');
    s = transition(s, 'SOS');
    expect(transition(s, 'SOS_RESOLVED')).toBe('ACTIVE');
  });
});

describe('notification rules', () => {
  const p = DEFAULT_NOTIFICATION_PREFERENCES;
  it('sends, de-duplicates and rate-limits', () => {
    const c = {
      type: 'SPEEDING_ATTENTION' as const,
      severity: 'ATTENTION' as const,
      dedupeKey: 'k',
      at: 100_000,
    };
    expect(decideNotification(c, p, null, false)).toMatchObject({ send: true, sound: false });
    expect(decideNotification(c, p, null, true)).toMatchObject({
      send: false,
      reason: 'duplicate',
    });
    expect(decideNotification(c, p, 90_000, false)).toMatchObject({
      send: false,
      reason: 'cooldown',
    });
  });

  it('uses sound from WARNING up and respects disabled types, but never disables SOS', () => {
    const w = {
      type: 'SPEEDING_WARNING' as const,
      severity: 'WARNING' as const,
      dedupeKey: 'w',
      at: 0,
    };
    expect(decideNotification(w, p, null, false)).toMatchObject({
      send: true,
      sound: true,
      priority: 'high',
    });
    const prefs = { ...p, disabledTypes: ['SPEEDING_WARNING', 'SOS'] as typeof p.disabledTypes };
    expect(decideNotification(w, prefs, null, false).send).toBe(false);
    const sos = decideNotification({ type: 'SOS', dedupeKey: 's', at: 0 }, prefs, 0, false);
    expect(sos).toMatchObject({ send: true, sound: true, priority: 'critical' });
  });

  it('honours the minimum severity preference', () => {
    const prefs = { ...p, minSpeedingSeverity: 'WARNING' as const };
    const a = {
      type: 'SPEEDING_ATTENTION' as const,
      severity: 'ATTENTION' as const,
      dedupeKey: 'a',
      at: 0,
    };
    expect(decideNotification(a, prefs, null, false)).toMatchObject({
      send: false,
      reason: 'below_min_severity',
    });
  });
});

describe('adaptive telemetry policy', () => {
  it('samples faster when moving fast and slower when stopped / low battery', () => {
    const base = {
      accuracyM: 5,
      background: false,
      batteryLevel: 0.8,
      charging: false,
      speeding: false,
    };
    expect(planTelemetry({ ...base, speedKmh: 100 }).sampleMs).toBe(1000);
    expect(planTelemetry({ ...base, speedKmh: 0 }).sampleMs).toBe(15000);
    expect(planTelemetry({ ...base, speedKmh: 0, batteryLevel: 0.1 }).sampleMs).toBe(30000);
    expect(
      planTelemetry({ ...base, speedKmh: 100, batteryLevel: 0.1, speeding: true }).sampleMs,
    ).toBe(1000);
    expect(planTelemetry({ ...base, speedKmh: 100, speeding: true }).uploadMaxDelayMs).toBe(2000);
  });
});

describe('offline queue', () => {
  it('keeps order, survives restarts, retries with backoff and removes only acknowledged items', async () => {
    let now = 0;
    const storage = new MemoryQueueStorage<{ v: number }>();
    let n = 0;
    const q = new OutboundQueue(storage, {
      now: () => now,
      idFactory: () => `id${++n}`,
      maxBatch: 2,
    });
    for (let i = 1; i <= 5; i++) await q.enqueue('trip1', { v: i });

    // Network down
    const failing = async () => {
      throw new Error('offline');
    };
    expect(await q.flush(failing)).toBe(0);
    expect(q.size).toBe(5);
    expect(await q.flush(async () => ({ acknowledged: ['id1'] }))).toBe(0); // backoff not elapsed

    // App restart: a new queue instance loads the persisted items
    const q2 = new OutboundQueue(storage, { now: () => now, maxBatch: 2 });
    now = 10_000;
    const sent: number[][] = [];
    const acked = await q2.flush(async (batch) => {
      sent.push(batch.map((b) => b.seq));
      return { acknowledged: batch.map((b) => b.id) };
    });
    expect(acked).toBe(5);
    expect(sent).toEqual([[1, 2], [3, 4], [5]]);
    expect(q2.size).toBe(0);
  });

  it('keeps unacknowledged items for the next attempt', async () => {
    let n = 0;
    const q = new OutboundQueue(new MemoryQueueStorage<number>(), { idFactory: () => `x${++n}` });
    await q.enqueue('s', 1);
    await q.enqueue('s', 2);
    await q.flush(async () => ({ acknowledged: ['x2'] }));
    expect(q.size).toBe(1);
  });
});

describe('demo data and i18n', () => {
  it('generates 1 Hz simulated points with explicit limits', () => {
    const full = DEMO_SCENARIOS.find((s) => s.id === 'full')!;
    const pts = generateDemoPoints(full, 0);
    expect(pts).toHaveLength(full.segments.reduce((a, s) => a + s.seconds, 0));
    expect(pts[1]!.t - pts[0]!.t).toBe(1000);
    const degraded = generateDemoPoints(
      DEMO_SCENARIOS.find((s) => s.id === 'degraded')!,
      0,
    );
    expect(degraded.some((p) => p.limitKmh === null)).toBe(true);
    expect(degraded.some((p) => !p.online)).toBe(true);
  });

  it('formats Hebrew text, plurals and durations', () => {
    expect(t('he', 'trip.started', { name: 'רומי' })).toBe('רומי התחיל/ה לנהוג');
    expect(t('en', 'trip.started', { name: 'Romi' })).toBe('Romi started driving');
    expect(t('he', 'trips.count', { count: 2 })).toBe('שתי נסיעות');
    expect(t('en', 'trips.count', { count: 3 })).toBe('3 trips');
    expect(formatDuration(102)).toBe('01:42');
    expect(isRtl('he')).toBe(true);
    expect(countryProfile('IL').emergencyNumbers.map((e) => e.number)).toEqual([
      '100',
      '101',
      '102',
    ]);
  });
});
