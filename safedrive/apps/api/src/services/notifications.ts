/**
 * Notification engine: decides (core rules: preferences, de-duplication, cooldown),
 * stores the in-app notification, pushes it to connected clients over the realtime
 * bus and queues push delivery. One message per meaningful change - never per second.
 */
import {
  decideNotification,
  DEFAULT_NOTIFICATION_PREFERENCES,
  t,
  type NotificationPreferences,
  type NotificationType,
  type Severity,
} from '@safedrive/core';
import { type Db, type Queryable } from '../db/pool.js';
import { type RealtimeBus, userChannel } from '../realtime/bus.js';
import { type PushNotificationProvider } from '../providers/push/push.js';
import { type Metrics } from './metrics.js';

export interface NotifyInput {
  familyId: string;
  type: NotificationType;
  severity?: Exclude<Severity, 'SAFE'>;
  driverId?: string | null;
  tripId?: string | null;
  /** Identical keys are never sent twice to the same recipient. */
  dedupeKey: string;
  /** Rate-limit group, e.g. `${driverId}:SPEEDING_ATTENTION`. Defaults to `${driverId}:${type}`. */
  cooldownGroup?: string;
  titleKey: string;
  bodyKey: string;
  vars: Record<string, string | number>;
  data?: Record<string, unknown>;
  isDemo?: boolean;
  at?: number;
}

export interface StoredNotification {
  id: string;
  type: string;
  priority: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  sound: boolean;
  createdAt: string;
  readAt: string | null;
  driverId: string | null;
  tripId: string | null;
  isDemo: boolean;
}

export async function loadPreferences(
  db: Queryable,
  userId: string,
  familyId: string,
): Promise<NotificationPreferences> {
  const r = await db.query<{ prefs: Partial<NotificationPreferences> }>(
    'SELECT prefs FROM notification_preferences WHERE user_id = $1 AND family_id = $2',
    [userId, familyId],
  );
  return { ...DEFAULT_NOTIFICATION_PREFERENCES, ...(r.rows[0]?.prefs ?? {}) };
}

export class NotificationService {
  constructor(
    private readonly db: Db,
    private readonly bus: RealtimeBus,
    private readonly push: PushNotificationProvider,
    private readonly metrics: Metrics,
  ) {}

  /** Notifies every PARENT of the family. */
  async notifyParents(input: NotifyInput): Promise<number> {
    const { rows } = await this.db.query<{ user_id: string; locale: string }>(
      `SELECT m.user_id, u.locale FROM family_members m JOIN users u ON u.id = m.user_id
       WHERE m.family_id = $1 AND m.role = 'PARENT' AND m.removed_at IS NULL AND u.deleted_at IS NULL AND u.status = 'active'`,
      [input.familyId],
    );
    let sent = 0;
    for (const r of rows) if (await this.notifyUser(r.user_id, r.locale, input)) sent += 1;
    return sent;
  }

  async notifyUser(userId: string, locale: string, input: NotifyInput): Promise<boolean> {
    const at = input.at ?? Date.now();
    const prefs = await loadPreferences(this.db, userId, input.familyId);
    const group = input.cooldownGroup ?? `${input.driverId ?? 'family'}:${input.type}`;
    const last = await this.db.query<{ created_at: Date }>(
      `SELECT created_at FROM notifications WHERE recipient_id = $1 AND data->>'cooldownGroup' = $2
       AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 1`,
      [userId, group],
    );
    const dup = await this.db.query(
      'SELECT 1 FROM notifications WHERE recipient_id = $1 AND dedupe_key = $2',
      [userId, input.dedupeKey],
    );
    const decision = decideNotification(
      { type: input.type, severity: input.severity, dedupeKey: input.dedupeKey, at },
      prefs,
      last.rows[0] ? last.rows[0].created_at.getTime() : null,
      (dup.rowCount ?? 0) > 0,
    );
    if (!decision.send) {
      this.metrics.inc(`notification_suppressed_${decision.reason ?? 'other'}`);
      return false;
    }
    const devices = await this.db.query(
      'SELECT 1 FROM devices WHERE user_id = $1 AND revoked_at IS NULL AND push_token IS NOT NULL LIMIT 1',
      [userId],
    );
    const title = t(locale, input.titleKey, input.vars);
    const body = t(locale, input.bodyKey, input.vars);
    const data = { ...(input.data ?? {}), cooldownGroup: group };
    const ins = await this.db.query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (family_id, recipient_id, driver_id, trip_id, type, priority, title, body, data,
         dedupe_key, sound, is_demo, push_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (recipient_id, dedupe_key) DO NOTHING RETURNING id, created_at`,
      [
        input.familyId,
        userId,
        input.driverId ?? null,
        input.tripId ?? null,
        input.type,
        decision.priority,
        title,
        body,
        data,
        input.dedupeKey,
        decision.sound,
        input.isDemo ?? false,
        devices.rowCount ? 'pending' : 'skipped',
      ],
    );
    const row = ins.rows[0];
    if (!row) return false;
    this.metrics.inc('notification_created');
    const n: StoredNotification = {
      id: row.id,
      type: input.type,
      priority: decision.priority,
      title,
      body,
      data,
      sound: decision.sound,
      createdAt: row.created_at.toISOString(),
      readAt: null,
      driverId: input.driverId ?? null,
      tripId: input.tripId ?? null,
      isDemo: input.isDemo ?? false,
    };
    await this.bus.publish(userChannel(userId), { type: 'notification', data: n });
    return true;
  }

  /** Push worker step: claims due notifications (SKIP LOCKED, safe with many workers). */
  async deliverPending(limit = 50): Promise<{ sent: number; failed: number }> {
    const claimed = await this.db.query<{
      id: string;
      recipient_id: string;
      title: string;
      body: string;
      data: Record<string, unknown>;
      sound: boolean;
      priority: 'low' | 'normal' | 'high' | 'critical';
      push_attempts: number;
      type: string;
    }>(
      `UPDATE notifications SET push_attempts = push_attempts + 1,
         next_attempt_at = now() + (least(300, power(2, push_attempts) * 5) || ' seconds')::interval
       WHERE id IN (SELECT id FROM notifications WHERE push_status = 'pending' AND next_attempt_at <= now()
                    ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
       RETURNING id, recipient_id, title, body, data, sound, priority, push_attempts, type`,
      [limit],
    );
    let sent = 0;
    let failed = 0;
    for (const n of claimed.rows) {
      const tokens = await this.db.query<{ id: string; push_token: string }>(
        'SELECT id, push_token FROM devices WHERE user_id = $1 AND revoked_at IS NULL AND push_token IS NOT NULL',
        [n.recipient_id],
      );
      if (!tokens.rowCount) {
        await this.db.query(`UPDATE notifications SET push_status = 'skipped' WHERE id = $1`, [
          n.id,
        ]);
        continue;
      }
      const results = await this.push.send(
        tokens.rows.map((d) => ({
          token: d.push_token,
          title: n.title,
          body: n.body,
          data: { ...n.data, notificationId: n.id, type: n.type },
          sound: n.sound,
          priority: n.priority,
        })),
      );
      let anyOk = false;
      let lastErr = '';
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r?.ok) anyOk = true;
        else if (r) {
          lastErr = r.error;
          if (r.permanent) {
            await this.db.query('UPDATE devices SET push_token = NULL WHERE id = $1', [
              tokens.rows[i]?.id,
            ]);
          }
        }
      }
      if (anyOk) {
        sent += 1;
        this.metrics.inc('push_sent');
        await this.db.query(
          `UPDATE notifications SET push_status = 'sent', push_error = NULL WHERE id = $1`,
          [n.id],
        );
      } else {
        failed += 1;
        this.metrics.inc('push_failed');
        await this.db.query(
          `UPDATE notifications SET push_error = $2, push_status = CASE WHEN push_attempts >= 5 THEN 'failed' ELSE 'pending' END WHERE id = $1`,
          [n.id, lastErr.slice(0, 300)],
        );
      }
    }
    return { sent, failed };
  }
}
