import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const { PhoneUsageDetector, phoneUsageCapabilities } = await import('../src/lib/phone-usage');

describe('phone usage capability layer', () => {
  it('never claims detection of other apps', () => {
    const c = phoneUsageCapabilities();
    expect(c.safedriveForegroundWhileMoving).toBe('IMPLEMENTED');
    expect(c.typingInOtherApps).toBe('PLATFORM_RESTRICTED');
    expect(c.callDetection).toBe('PLATFORM_RESTRICTED');
    expect(c.otherAppUsage).not.toBe('IMPLEMENTED');
  });

  it('reports interaction only while moving, at most once per cooldown, never in demo', async () => {
    let now = 0;
    const reports: unknown[] = [];
    const d = new PhoneUsageDetector(async (x) => void reports.push(x), () => now);
    expect(await d.onInteraction(5, false)).toBe(false);
    expect(await d.onInteraction(null, false)).toBe(false);
    expect(await d.onInteraction(80, true)).toBe(false);
    now = 100_000;
    expect(await d.onInteraction(80, false)).toBe(true);
    now += 30_000;
    expect(await d.onInteraction(80, false)).toBe(false);
    now += 31_000;
    expect(await d.onInteraction(80, false)).toBe(true);
    expect(reports).toHaveLength(2);
  });
});
