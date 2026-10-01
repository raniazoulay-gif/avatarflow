import { type Db } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { type RealtimeBus, familyChannel } from '../realtime/bus.js';
import { audit } from './audit.js';
import { type NotificationService } from './notifications.js';

export interface SosInput {
  clientId: string;
  driverId: string;
  tripId?: string | null;
  lat?: number | null;
  lon?: number | null;
  accuracyM?: number | null;
  speedMs?: number | null;
  triggeredAt?: number;
}

/**
 * SOS: stores the event with the last known location/speed and alerts every parent
 * (critical priority, cannot be disabled). Emergency CALLS are never placed
 * automatically - the app offers 100/101/102 buttons that the user taps.
 */
export class SosService {
  constructor(
    private readonly db: Db,
    private readonly bus: RealtimeBus,
    private readonly notifications: NotificationService,
  ) {}

  async trigger(userId: string, input: SosInput, ip?: string): Promise<Record<string, unknown>> {
    const d = await this.db.query<{
      id: string;
      family_id: string;
      user_id: string;
      display_name: string;
      is_demo: boolean;
    }>(
      `SELECT d.id, d.family_id, d.user_id, d.display_name, f.is_demo FROM drivers d JOIN families f ON f.id = d.family_id
       WHERE d.id = $1 AND d.deleted_at IS NULL`,
      [input.driverId],
    );
    const drv = d.rows[0];
    if (!drv || drv.user_id !== userId) throw notFound('Driver not found');
    let tripId = input.tripId ?? null;
    let isDemo = drv.is_demo;
    let lat = input.lat ?? null;
    let lon = input.lon ?? null;
    let speedKmh =
      input.speedMs !== null && input.speedMs !== undefined ? input.speedMs * 3.6 : null;
    const trip = await this.db.query<{
      id: string;
      is_demo: boolean;
      live: { lat?: number; lon?: number; speedKmh?: number };
      state: string;
    }>(
      tripId
        ? 'SELECT id, is_demo, live, state FROM trips WHERE id = $1 AND driver_id = $2'
        : 'SELECT id, is_demo, live, state FROM trips WHERE driver_id = $2 AND ended_at IS NULL AND $1::uuid IS NULL',
      [tripId, drv.id],
    );
    const tr = trip.rows[0];
    if (tripId && !tr) throw badRequest('Unknown trip');
    if (tr) {
      tripId = tr.id;
      isDemo = isDemo || tr.is_demo;
      lat = lat ?? tr.live.lat ?? null;
      lon = lon ?? tr.live.lon ?? null;
      speedKmh = speedKmh ?? tr.live.speedKmh ?? null;
    }
    const ins = await this.db.query<{ id: string; triggered_at: Date }>(
      `INSERT INTO sos_events (family_id, driver_id, trip_id, client_id, lat, lon, accuracy_m, speed_kmh, triggered_at, is_demo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (client_id) DO UPDATE SET client_id = EXCLUDED.client_id RETURNING id, triggered_at`,
      [
        drv.family_id,
        drv.id,
        tripId,
        input.clientId,
        lat,
        lon,
        input.accuracyM ?? null,
        speedKmh,
        new Date(input.triggeredAt ?? Date.now()),
        isDemo,
      ],
    );
    const sos = ins.rows[0] as { id: string; triggered_at: Date };
    await this.db.query(
      `INSERT INTO safety_events (family_id, driver_id, trip_id, type, severity, occurred_at, lat, lon, data, is_demo, dedupe_key)
       VALUES ($1, $2, $3, 'SOS', 'CRITICAL', $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [
        drv.family_id,
        drv.id,
        tripId,
        sos.triggered_at,
        lat,
        lon,
        { sosId: sos.id, speedKmh },
        isDemo,
        `SOS:${sos.id}`,
      ],
    );
    if (tr && tr.state !== 'SOS') {
      await this.db.query(
        `UPDATE trips SET state = 'SOS', updated_at = now() WHERE id = $1 AND ended_at IS NULL`,
        [tr.id],
      );
    }
    await audit(this.db, {
      actorId: userId,
      familyId: drv.family_id,
      action: 'sos.trigger',
      targetType: 'sos',
      targetId: sos.id,
      ip: ip ?? null,
    });
    const view = {
      id: sos.id,
      driverId: drv.id,
      driverName: drv.display_name,
      tripId,
      lat,
      lon,
      speedKmh: speedKmh === null ? null : Math.round(speedKmh),
      triggeredAt: sos.triggered_at.toISOString(),
      status: 'OPEN',
      isDemo,
    };
    await this.bus.publish(familyChannel(drv.family_id), { type: 'sos', data: view });
    await this.notifications.notifyParents({
      familyId: drv.family_id,
      type: 'SOS',
      driverId: drv.id,
      tripId,
      dedupeKey: `sos:${sos.id}`,
      cooldownGroup: `sos:${sos.id}`,
      titleKey: 'event.SOS',
      bodyKey: 'notify.sos',
      vars: { name: drv.display_name },
      data: { sosId: sos.id, lat, lon },
      isDemo,
    });
    return view;
  }

  async setStatus(
    userId: string,
    sosId: string,
    status: 'ACKNOWLEDGED' | 'RESOLVED',
    canAct: (familyId: string) => Promise<void>,
  ): Promise<void> {
    const r = await this.db.query<{ family_id: string; trip_id: string | null }>(
      'SELECT family_id, trip_id FROM sos_events WHERE id = $1',
      [sosId],
    );
    const s = r.rows[0];
    if (!s) throw notFound('SOS not found');
    await canAct(s.family_id);
    if (status === 'ACKNOWLEDGED') {
      await this.db.query(
        `UPDATE sos_events SET status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND status = 'OPEN'`,
        [sosId, userId],
      );
    } else {
      await this.db.query(
        `UPDATE sos_events SET status = 'RESOLVED', resolved_at = now() WHERE id = $1`,
        [sosId],
      );
      if (s.trip_id)
        await this.db.query(
          `UPDATE trips SET state = 'ACTIVE' WHERE id = $1 AND state = 'SOS' AND ended_at IS NULL`,
          [s.trip_id],
        );
    }
    await audit(this.db, {
      actorId: userId,
      familyId: s.family_id,
      action: `sos.${status.toLowerCase()}`,
      targetType: 'sos',
      targetId: sosId,
    });
    await this.bus.publish(familyChannel(s.family_id), {
      type: 'sos.status',
      data: { id: sosId, status },
    });
  }
}
