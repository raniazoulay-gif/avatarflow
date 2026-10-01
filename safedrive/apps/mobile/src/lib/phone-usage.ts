/**
 * Phone-usage capability layer. Honest by design: mobile operating systems do NOT let a
 * third-party app see which other apps are in use, whether the user is typing in
 * another app, or whether WhatsApp/calls are active. What we can know reliably:
 *
 *  - SafeDrive itself is in the foreground and being touched while the car is moving
 *    (reported as PHONE_USAGE with source "safedrive_foreground");
 *  - the screen state indirectly via AppState (active vs background) - not proof of use.
 *
 * Everything else is reported as unavailable / platform restricted, and the parent UI
 * flags are reported to the API (device capabilities) instead of pretending to detect distraction.
 */
import { Platform } from 'react-native';

export type CapabilityStatus =
  'IMPLEMENTED' | 'PARTIAL' | 'PLATFORM_RESTRICTED' | 'UNAVAILABLE' | 'REQUIRES_EXTERNAL_CONFIG';

export interface PhoneUsageCapabilities {
  safedriveForegroundWhileMoving: CapabilityStatus;
  screenOnWhileMoving: CapabilityStatus;
  otherAppUsage: CapabilityStatus;
  typingInOtherApps: CapabilityStatus;
  callDetection: CapabilityStatus;
}

export function phoneUsageCapabilities(): PhoneUsageCapabilities {
  return {
    safedriveForegroundWhileMoving: 'IMPLEMENTED',
    // AppState tells us only about our own app; screen state for others is not exposed.
    screenOnWhileMoving: 'PARTIAL',
    // Android UsageStatsManager needs a special-access permission and a native module;
    // iOS Screen Time APIs do not expose per-app usage to third parties.
    otherAppUsage: Platform.OS === 'android' ? 'REQUIRES_EXTERNAL_CONFIG' : 'PLATFORM_RESTRICTED',
    typingInOtherApps: 'PLATFORM_RESTRICTED',
    callDetection: 'PLATFORM_RESTRICTED',
  };
}

/** Min speed (km/h) above which interacting with SafeDrive counts as phone usage. */
export const PHONE_USAGE_MIN_KMH = 15;
/** At most one report per this many ms (avoid flooding on every touch). */
export const PHONE_USAGE_COOLDOWN_MS = 60_000;

export class PhoneUsageDetector {
  private lastReportAt = 0;
  constructor(
    private readonly report: (
      data: Record<string, string | number | boolean | null>,
    ) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Called on user interaction with SafeDrive while a trip is live. */
  async onInteraction(speedKmh: number | null, demo: boolean): Promise<boolean> {
    if (demo || speedKmh === null || speedKmh < PHONE_USAGE_MIN_KMH) return false;
    const t = this.now();
    if (t - this.lastReportAt < PHONE_USAGE_COOLDOWN_MS) return false;
    this.lastReportAt = t;
    await this.report({ source: 'safedrive_foreground', speedKmh: Math.round(speedKmh) });
    return true;
  }
}
