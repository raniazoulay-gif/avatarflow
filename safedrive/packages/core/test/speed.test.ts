import { describe, expect, it } from 'vitest';
import {
  computeExcess,
  severityForExcess,
  DEFAULT_SAFETY_CONFIG,
  resolveSafetyConfig,
  msToKmh,
  kmhToMs,
  distanceMeters,
} from '../src/index.js';

const T = DEFAULT_SAFETY_CONFIG.speeding.thresholds;

describe('speed math', () => {
  it('computes excess km/h and percentage', () => {
    expect(computeExcess(110, 100)).toEqual({ excessKmh: 10, excessPct: 10 });
    expect(computeExcess(143, 100).excessKmh).toBe(43);
    expect(computeExcess(100, 90).excessPct).toBeCloseTo(11.11, 2);
  });

  it('is zero at or below the limit', () => {
    expect(computeExcess(100, 100)).toEqual({ excessKmh: 0, excessPct: 0 });
    expect(computeExcess(80, 100)).toEqual({ excessKmh: 0, excessPct: 0 });
  });

  it('rejects a missing/zero limit', () => {
    expect(computeExcess(80, 0)).toEqual({ excessKmh: 0, excessPct: 0 });
    expect(computeExcess(Number.NaN, 100)).toEqual({ excessKmh: 0, excessPct: 0 });
  });

  it('maps severities with inclusive thresholds (examples from the spec)', () => {
    expect(severityForExcess(computeExcess(105, 100).excessPct, T)).toBe('SAFE');
    expect(severityForExcess(computeExcess(110, 100).excessPct, T)).toBe('ATTENTION');
    expect(severityForExcess(computeExcess(130, 100).excessPct, T)).toBe('WARNING');
    expect(severityForExcess(computeExcess(150, 100).excessPct, T)).toBe('CRITICAL');
    expect(severityForExcess(computeExcess(99, 90).excessPct, T)).toBe('ATTENTION');
  });

  it('accepts configured thresholds and rejects invalid ones', () => {
    const cfg = resolveSafetyConfig({ speeding: { thresholds: { attentionPct: 5, warningPct: 20, criticalPct: 40 } } });
    expect(severityForExcess(6, cfg.speeding.thresholds)).toBe('ATTENTION');
    expect(cfg.speeding.confirmationSeconds).toBe(10);
    expect(() => resolveSafetyConfig({ speeding: { thresholds: { attentionPct: 40, warningPct: 20 } } })).toThrow();
  });

  it('converts units and measures distance', () => {
    expect(msToKmh(kmhToMs(100))).toBeCloseTo(100, 6);
    expect(distanceMeters({ lat: 32, lon: 34.8 }, { lat: 32.01, lon: 34.8 })).toBeCloseTo(1112, -1);
  });
});
