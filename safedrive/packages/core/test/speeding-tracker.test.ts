import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SAFETY_CONFIG,
  initialSpeedingState,
  processSpeedSample,
  finishSpeeding,
  type SpeedSample,
  type SpeedingOutput,
  type SpeedingState,
} from '../src/index.js';

const cfg = DEFAULT_SAFETY_CONFIG.speeding;
const limit = (kmh: number | null, confidence = 1) =>
  kmh === null ? null : { kmh, confidence, source: 'test', road: 'Route 1' };

/** Feeds a 1 Hz speed profile; returns all outputs and the final state. */
function run(
  profile: Array<[number, number | null]>,
  opts: { start?: number; state?: SpeedingState } = {},
) {
  let state = opts.state ?? initialSpeedingState();
  const outputs: Array<SpeedingOutput & { at: number }> = [];
  let t = opts.start ?? 1_000_000;
  const lives = [];
  for (const [speed, lim] of profile) {
    const s: SpeedSample = {
      t,
      speedKmh: speed,
      limit: limit(lim),
      lat: 32,
      lon: 34.8,
      accuracyM: 5,
    };
    const r = processSpeedSample(state, s, cfg);
    state = r.state;
    lives.push(r.live);
    for (const o of r.outputs) outputs.push({ ...o, at: t });
    t += 1000;
  }
  return { state, outputs, lives, t };
}

const repeat = (
  n: number,
  speed: number,
  lim: number | null = 100,
): Array<[number, number | null]> => Array.from({ length: n }, () => [speed, lim]);

describe('10-second confirmation rule', () => {
  it('does not create an event for 0-9 seconds over the limit', () => {
    // 10 samples at 1 Hz = 9 seconds elapsed between first and last
    const r = run([...repeat(5, 90), ...repeat(10, 120), ...repeat(5, 90)]);
    expect(r.outputs).toHaveLength(0);
    expect(r.lives.some((l) => l.confirming)).toBe(true);
  });

  it('creates the event after 10 continuous seconds', () => {
    const r = run([...repeat(3, 90), ...repeat(11, 120)]);
    expect(r.outputs).toHaveLength(1);
    const o = r.outputs[0]!;
    expect(o.type).toBe('started');
    if (o.type === 'started') {
      expect(o.event.severity).toBe('ATTENTION');
      expect(o.event.durationSec).toBe(10);
      expect(o.event.startSpeedKmh).toBe(120);
    }
  });

  it('resets the timer when speed returns to/below the limit before 10 s', () => {
    const r = run([...repeat(8, 120), [100, 100], ...repeat(8, 120)]);
    expect(r.outputs).toHaveLength(0);
  });

  it('only counts excess at or above the ATTENTION threshold (5% over does not start the timer)', () => {
    const r = run(repeat(30, 105));
    expect(r.outputs).toHaveLength(0);
    expect(r.lives.every((l) => !l.confirming)).toBe(true);
  });
});

describe('severity escalation and aggregation', () => {
  it('escalates ATTENTION -> WARNING -> CRITICAL once each and closes with a summary', () => {
    const r = run([...repeat(12, 115), ...repeat(5, 135), ...repeat(5, 155), ...repeat(6, 90)]);
    const types = r.outputs.map((o) => (o.type === 'escalated' ? `escalated:${o.to}` : o.type));
    expect(types).toEqual(['started', 'escalated:WARNING', 'escalated:CRITICAL', 'ended']);
    const end = r.outputs.at(-1)!;
    expect(end.type).toBe('ended');
    if (end.type === 'ended') {
      expect(end.reason).toBe('recovered');
      expect(end.event.maxSpeedKmh).toBe(155);
      expect(end.event.maxExcessKmh).toBe(55);
      expect(end.event.maxExcessPct).toBeCloseTo(55, 5);
      expect(end.event.severity).toBe('CRITICAL');
      expect(end.event.durationSec).toBe(22); // 12+5+5 seconds over the limit
      expect(end.event.speedLimitKmh).toBe(100);
    }
  });

  it('does not escalate on a single-second spike', () => {
    const r = run([...repeat(12, 115), [160, 100], ...repeat(5, 115), ...repeat(5, 90)]);
    expect(r.outputs.map((o) => o.type)).toEqual(['started', 'ended']);
    const end = r.outputs.at(-1)!;
    if (end.type === 'ended') {
      expect(end.event.severity).toBe('ATTENTION');
      expect(end.event.maxSpeedKmh).toBe(160);
    }
  });

  it('starts directly at the severity held for the whole confirmation window', () => {
    const r = run(repeat(11, 160));
    const o = r.outputs[0]!;
    expect(o.type === 'started' && o.event.severity).toBe('CRITICAL');
  });

  it('emits one event for continuous speeding, not one per second', () => {
    const r = run(repeat(120, 120));
    expect(r.outputs).toHaveLength(1);
  });

  it('keeps the event open through a short dip (end confirmation)', () => {
    const r = run([...repeat(12, 120), [95, 100], [95, 100], ...repeat(5, 120), ...repeat(5, 90)]);
    expect(r.outputs.map((o) => o.type)).toEqual(['started', 'ended']);
  });
});

describe('unreliable inputs never create false violations', () => {
  it('ignores speeding when the limit is unavailable', () => {
    const r = run(repeat(30, 150, null));
    expect(r.outputs).toHaveLength(0);
    expect(r.lives.at(-1)!.status).toBe('LIMIT_UNAVAILABLE');
  });

  it('ignores low-confidence limits', () => {
    let state = initialSpeedingState();
    const outs: SpeedingOutput[] = [];
    for (let i = 0; i < 20; i++) {
      const r = processSpeedSample(
        state,
        { t: 1000 * i, speedKmh: 150, limit: limit(100, 0.3), lat: 0, lon: 0, accuracyM: 5 },
        cfg,
      );
      state = r.state;
      outs.push(...r.outputs);
    }
    expect(outs).toHaveLength(0);
  });

  it('ignores inaccurate GPS fixes', () => {
    let state = initialSpeedingState();
    const outs: SpeedingOutput[] = [];
    for (let i = 0; i < 20; i++) {
      const r = processSpeedSample(
        state,
        { t: 1000 * i, speedKmh: 150, limit: limit(100), lat: 0, lon: 0, accuracyM: 200 },
        cfg,
      );
      state = r.state;
      outs.push(...r.outputs);
    }
    expect(outs).toHaveLength(0);
  });

  it('closes an open event when the limit disappears', () => {
    const r = run([...repeat(12, 120), ...repeat(3, 120, null)]);
    expect(r.outputs.map((o) => o.type)).toEqual(['started', 'ended']);
    const e = r.outputs[1]!;
    expect(e.type === 'ended' && e.reason).toBe('limit_unavailable');
  });

  it('a gap in samples breaks continuity', () => {
    const a = run(repeat(6, 120));
    const b = run(repeat(6, 120), { start: a.t + 60_000, state: a.state });
    expect([...a.outputs, ...b.outputs]).toHaveLength(0);
  });

  it('ignores duplicate / out-of-order samples', () => {
    const a = run(repeat(5, 120));
    const r = processSpeedSample(
      a.state,
      { t: a.t - 3000, speedKmh: 120, limit: limit(100), lat: 0, lon: 0, accuracyM: 5 },
      cfg,
    );
    expect(r.state).toEqual(a.state);
  });

  it('closes an open event when the trip ends', () => {
    const a = run(repeat(15, 120));
    const r = finishSpeeding(a.state);
    expect(r.outputs).toHaveLength(1);
    expect(r.outputs[0]!.type === 'ended' && r.outputs[0]!.reason).toBe('trip_end');
  });

  it('state survives JSON round-trips (persisted per trip on the server)', () => {
    const a = run(repeat(6, 120));
    const restored = JSON.parse(JSON.stringify(a.state)) as SpeedingState;
    const b = run(repeat(6, 120), { start: a.t, state: restored });
    expect(b.outputs.map((o) => o.type)).toEqual(['started']);
  });
});
