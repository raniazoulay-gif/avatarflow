/**
 * Remote monitoring requests. A parent can ASK; the driver's device shows the request
 * and the driver decides. SafeDrive never starts tracking silently: iOS/Android do not
 * allow a server to switch on background location without the user and the app.
 */
import { t } from '@safedrive/core';
import { type Db } from '../db/pool.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { type RealtimeBus, familyChannel, userChannel } from '../realtime/bus.js';
import { audit } from './audit.js';
import { type NotificationService } from './notifications.js';

export type MonitoringStatus =
  | 'REQUESTED'
  | 'PENDING'
  | 'ACTIVE'
  | 'DECLINED'
  | 'UNAVAILABLE'
  | 'PERMISSION_REQUIRED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'COMPLETED';

const REQUEST_TTL_MINUTES = 15;

export class MonitoringService {
  constructor(
    private readonly db: Db,
    private readonly bus: RealtimeBus,
    private readonly notifications: NotificationService,
  ) {}

  async request(parentId: string, driverId: string, ip?: string): Promise<Record<string, unknown>> {
    const d = await this.db.query<{
      id: string;
      family_id: string;
      user_id: string;
      display_name: string;
      locale: string;
    }>(
      `SELECT d.id, d.family_id, d.user_id, d.display_name, u.locale FROM drivers d JOIN users u ON u.id = d.user_id
       WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [driverId],
    );
    const drv = d.rows[0];
    if (!drv) throw notFound('Driver not found');
    const live = await this.db.query(
      'SELECT id FROM trips WHERE driver_id = $1 AND ended_at IS NULL',
      [driverId],
    );
    if (live.rowCount) throw conflict('The driver already has an active trip');
    await this.db.query(
      `UPDATE monitoring_requests SET status = 'CANCELLED', updated_at = now()
       WHERE driver_id = $1 AND status IN ('REQUESTED', 'PENDING')`,
      [driverId],
    );
    // Capability check: does the driver have a device that can receive the request?
    const devices = await this.db.query<{
      push_token: string | null;
      capabilities: Record<string, unknown>;
    }>('SELECT push_token, capabilities FROM devices WHERE user_id = $1 AND revoked_at IS NULL', [
      drv.user_id,
    ]);
    const reachable = devices.rows.some((x) => x.push_token);
    const status: MonitoringStatus =
      devices.rowCount === 0 ? 'UNAVAILABLE' : reachable ? 'REQUESTED' : 'PENDING';
    const ins = await this.db.query<{ id: string; created_at: Date; expires_at: Date }>(
      `INSERT INTO monitoring_requests (family_id, driver_id, requested_by, status, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' minutes')::interval) RETURNING id, created_at, expires_at`,
      [
        drv.family_id,
        drv.id,
        parentId,
        status,
        devices.rowCount === 0 ? 'no_registered_device' : reachable ? null : 'no_push_token',
        String(REQUEST_TTL_MINUTES),
      ],
    );
    const req = ins.rows[0] as { id: string; created_at: Date; expires_at: Date };
    await audit(this.db, {
      actorId: parentId,
      familyId: drv.family_id,
      action: 'monitoring.request',
      targetType: 'driver',
      targetId: drv.id,
      ip: ip ?? null,
      details: { status },
    });
    const view = {
      id: req.id,
      driverId: drv.id,
      status,
      createdAt: req.created_at.toISOString(),
      expiresAt: req.expires_at.toISOString(),
    };
    if (status !== 'UNAVAILABLE') {
      const parent = await this.db.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id = $1',
        [parentId],
      );
      await this.notifications.notifyUser(drv.user_id, drv.locale, {
        familyId: drv.family_id,
        type: 'MONITORING_REQUEST',
        driverId: drv.id,
        dedupeKey: `monitoring:${req.id}`,
        cooldownGroup: `monitoring:${req.id}`,
        titleKey: 'app.name',
        bodyKey: 'notify.monitoringRequest',
        vars: { name: parent.rows[0]?.display_name ?? t(drv.locale, 'app.name') },
        data: { monitoringRequestId: req.id, action: 'monitoring_request' },
      });
      await this.bus.publish(userChannel(drv.user_id), { type: 'monitoring.request', data: view });
    }
    await this.bus.publish(familyChannel(drv.family_id), { type: 'monitoring.status', data: view });
    return view;
  }

  /** Driver device answers: declined, or cannot (permission missing / unavailable). Accepting = starting a trip. */
  async respond(
    userId: string,
    requestId: string,
    status: 'DECLINED' | 'PERMISSION_REQUIRED' | 'UNAVAILABLE' | 'PENDING',
  ): Promise<Record<string, unknown>> {
    const r = await this.db.query<{
      id: string;
      family_id: string;
      driver_id: string;
      user_id: string;
      status: string;
      expires_at: Date;
    }>(
      `SELECT m.id, m.family_id, m.driver_id, d.user_id, m.status, m.expires_at FROM monitoring_requests m
       JOIN drivers d ON d.id = m.driver_id WHERE m.id = $1`,
      [requestId],
    );
    const req = r.rows[0];
    if (!req || req.user_id !== userId) throw notFound('Request not found');
    if (!['REQUESTED', 'PENDING', 'PERMISSION_REQUIRED'].includes(req.status))
      throw conflict('Request is no longer open');
    if (req.expires_at < new Date()) throw badRequest('Request expired');
    await this.db.query(
      'UPDATE monitoring_requests SET status = $2, updated_at = now() WHERE id = $1',
      [requestId, status],
    );
    await audit(this.db, {
      actorId: userId,
      familyId: req.family_id,
      action: 'monitoring.respond',
      targetType: 'monitoring_request',
      targetId: requestId,
      details: { status },
    });
    const view = { id: requestId, driverId: req.driver_id, status };
    await this.bus.publish(familyChannel(req.family_id), { type: 'monitoring.status', data: view });
    return view;
  }

  async expireOld(): Promise<number> {
    const r = await this.db.query(
      `UPDATE monitoring_requests SET status = 'EXPIRED', updated_at = now()
       WHERE status IN ('REQUESTED', 'PENDING', 'PERMISSION_REQUIRED') AND expires_at < now()`,
    );
    return r.rowCount ?? 0;
  }
}
