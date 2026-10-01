/**
 * Decides whether a safety occurrence becomes a parent notification, so parents get
 * one message per meaningful change (start, escalation, SOS...) - never a stream.
 */
import { type Severity, severityRank } from './config.js';

export type NotificationType =
  | 'TRIP_STARTED'
  | 'TRIP_ENDED'
  | 'SPEEDING_ATTENTION'
  | 'SPEEDING_WARNING'
  | 'SPEEDING_CRITICAL'
  | 'SPEEDING_ENDED'
  | 'HARD_BRAKING'
  | 'HARD_ACCELERATION'
  | 'SOS'
  | 'DRIVER_OFFLINE'
  | 'GPS_UNAVAILABLE'
  | 'PERMISSION_PROBLEM'
  | 'MONITORING_REQUEST'
  | 'MONITORING_RESPONSE'
  | 'SYSTEM_ERROR';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

export interface NotificationPreferences {
  /** Types the parent does not want at all. SOS can never be disabled. */
  disabledTypes: NotificationType[];
  /** Lowest speeding severity that notifies. */
  minSpeedingSeverity: Exclude<Severity, 'SAFE'>;
  /** Play sound for this severity and above (where the platform allows). */
  soundFromSeverity: Exclude<Severity, 'SAFE'>;
  /** Minimum seconds between notifications sharing a dedupe key. */
  cooldownSeconds: number;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  disabledTypes: [],
  minSpeedingSeverity: 'ATTENTION',
  soundFromSeverity: 'WARNING',
  cooldownSeconds: 60,
};

export const NEVER_DISABLED: readonly NotificationType[] = ['SOS'];

export function speedingType(sev: Exclude<Severity, 'SAFE'>): NotificationType {
  return `SPEEDING_${sev}` as NotificationType;
}

export function priorityFor(type: NotificationType): NotificationPriority {
  switch (type) {
    case 'SOS':
    case 'SPEEDING_CRITICAL':
      return 'critical';
    case 'SPEEDING_WARNING':
    case 'PERMISSION_PROBLEM':
    case 'DRIVER_OFFLINE':
      return 'high';
    case 'SPEEDING_ATTENTION':
    case 'TRIP_STARTED':
    case 'MONITORING_REQUEST':
    case 'MONITORING_RESPONSE':
    case 'GPS_UNAVAILABLE':
    case 'SYSTEM_ERROR':
      return 'normal';
    default:
      return 'low';
  }
}

export interface NotificationCandidate {
  type: NotificationType;
  severity?: Exclude<Severity, 'SAFE'>;
  /** e.g. `${tripId}:speeding:${eventId}:${severity}` - identical keys are de-duplicated. */
  dedupeKey: string;
  at: number;
}

export interface Decision {
  send: boolean;
  sound: boolean;
  priority: NotificationPriority;
  reason?: 'disabled' | 'below_min_severity' | 'duplicate' | 'cooldown';
}

/**
 * @param lastSentAt epoch ms of the last notification with the same dedupeKey, or null.
 * @param exactDuplicate true when a notification with this exact key already exists.
 */
export function decideNotification(
  c: NotificationCandidate,
  prefs: NotificationPreferences,
  lastSentAt: number | null,
  exactDuplicate: boolean,
): Decision {
  const priority = priorityFor(c.type);
  const sound =
    c.type === 'SOS' ||
    (c.severity !== undefined && severityRank(c.severity) >= severityRank(prefs.soundFromSeverity));
  if (!NEVER_DISABLED.includes(c.type) && prefs.disabledTypes.includes(c.type)) {
    return { send: false, sound: false, priority, reason: 'disabled' };
  }
  if (c.severity && severityRank(c.severity) < severityRank(prefs.minSpeedingSeverity)) {
    return { send: false, sound: false, priority, reason: 'below_min_severity' };
  }
  if (exactDuplicate) return { send: false, sound: false, priority, reason: 'duplicate' };
  if (
    c.type !== 'SOS' &&
    lastSentAt !== null &&
    (c.at - lastSentAt) / 1000 < prefs.cooldownSeconds
  ) {
    return { send: false, sound: false, priority, reason: 'cooldown' };
  }
  return { send: true, sound, priority };
}
