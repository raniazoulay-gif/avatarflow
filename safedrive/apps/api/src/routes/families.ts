import { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@safedrive/core';
import { type AppContext } from '../context.js';
import { me } from '../auth/plugin.js';
import { requireMember, requireParent } from '../auth/access.js';
import { parse } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { liveView, type TripRow } from '../services/live.js';
import { loadPreferences } from '../services/notifications.js';

const id = z.object({ id: z.string().uuid() });
const severities = z.enum(['ATTENTION', 'WARNING', 'CRITICAL']);
const notificationTypes = z.enum([
  'TRIP_STARTED', 'TRIP_ENDED', 'SPEEDING_ATTENTION', 'SPEEDING_WARNING', 'SPEEDING_CRITICAL', 'SPEEDING_ENDED',
  'HARD_BRAKING', 'HARD_ACCELERATION', 'SOS', 'DRIVER_OFFLINE', 'GPS_UNAVAILABLE', 'PERMISSION_PROBLEM',
  'MONITORING_REQUEST', 'MONITORING_RESPONSE', 'SYSTEM_ERROR',
]);

export function familyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: app.requireAuth };

  app.post('/families', auth, async (req) => {
    const b = parse(z.object({ name: z.string().trim().min(1).max(80), countryCode: z.string().length(2).optional() }), req.body);
    return ctx.families.create(me(req).id, b);
  });

  app.get('/families', auth, async (req) => ctx.families.listForUser(me(req).id));

  app.get('/families/:id', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    const m = await requireMember(ctx.db, me(req).id, familyId);
    const detail = await ctx.families.detail(familyId);
    return { ...detail, myRole: m.role };
  });

  app.post('/families/:id/invites', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    await requireParent(ctx.db, me(req).id, familyId);
    const b = parse(z.object({ role: z.enum(['PARENT', 'DRIVER']), displayName: z.string().trim().min(1).max(80) }), req.body);
    return ctx.families.createInvite(me(req).id, familyId, b.role, b.displayName);
  });

  app.post('/invites/accept', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ code: z.string().trim().min(6).max(20), consent: z.boolean().default(false) }), req.body);
    return ctx.families.acceptInvite(me(req).id, b.code, b.consent);
  });

  app.delete('/families/:id/members/:memberId', auth, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), memberId: z.string().uuid() }), req.params);
    await requireParent(ctx.db, me(req).id, p.id);
    await ctx.families.removeMember(me(req).id, p.id, p.memberId);
    return { ok: true };
  });

  /** Live view of every active trip in the family (parents). */
  app.get('/families/:id/live', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    await requireParent(ctx.db, me(req).id, familyId);
    const { rows } = await ctx.db.query<TripRow & { display_name: string }>(
      `SELECT t.*, d.display_name FROM trips t JOIN drivers d ON d.id = t.driver_id
       WHERE t.family_id = $1 AND t.ended_at IS NULL ORDER BY t.started_at`,
      [familyId],
    );
    return rows.map((r) => liveView(r, r.display_name, ctx.env.OFFLINE_AFTER_SECONDS));
  });

  /** Drivers with status: active trip?, score, last trip. */
  app.get('/families/:id/drivers', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    await requireParent(ctx.db, me(req).id, familyId);
    const { rows } = await ctx.db.query(
      `SELECT d.id, d.display_name AS "displayName", d.safety_score AS "safetyScore", d.consent_at AS "consentAt",
              (SELECT t.id FROM trips t WHERE t.driver_id = d.id AND t.ended_at IS NULL) AS "activeTripId",
              (SELECT max(t.started_at) FROM trips t WHERE t.driver_id = d.id) AS "lastTripAt",
              (SELECT row_to_json(m) FROM (SELECT id, status, created_at AS "createdAt" FROM monitoring_requests
                 WHERE driver_id = d.id ORDER BY created_at DESC LIMIT 1) m) AS "lastMonitoringRequest",
              (SELECT json_agg(json_build_object('platform', dv.platform, 'lastSeenAt', dv.last_seen_at,
                 'capabilities', dv.capabilities, 'pushReady', dv.push_token IS NOT NULL))
               FROM devices dv WHERE dv.user_id = d.user_id AND dv.revoked_at IS NULL) AS devices
       FROM drivers d WHERE d.family_id = $1 AND d.deleted_at IS NULL ORDER BY d.created_at`,
      [familyId],
    );
    return rows;
  });

  app.get('/families/:id/sos', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    await requireParent(ctx.db, me(req).id, familyId);
    const { rows } = await ctx.db.query(
      `SELECT s.id, s.driver_id AS "driverId", d.display_name AS "driverName", s.trip_id AS "tripId", s.lat, s.lon,
              s.speed_kmh AS "speedKmh", s.triggered_at AS "triggeredAt", s.status, s.is_demo AS "isDemo",
              s.acknowledged_at AS "acknowledgedAt", s.resolved_at AS "resolvedAt"
       FROM sos_events s JOIN drivers d ON d.id = s.driver_id WHERE s.family_id = $1 ORDER BY s.triggered_at DESC LIMIT 100`,
      [familyId],
    );
    return rows;
  });

  // Emergency contacts
  app.get('/families/:id/emergency-contacts', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    await requireMember(ctx.db, me(req).id, familyId);
    const { rows } = await ctx.db.query(
      'SELECT id, name, phone, relation FROM emergency_contacts WHERE family_id = $1 AND deleted_at IS NULL ORDER BY created_at',
      [familyId],
    );
    return rows;
  });

  app.post('/families/:id/emergency-contacts', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    await requireParent(ctx.db, me(req).id, familyId);
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(80), phone: z.string().trim().regex(/^\+?[0-9 ()-]{3,20}$/), relation: z.string().trim().max(40).optional() }),
      req.body,
    );
    const r = await ctx.db.query(
      'INSERT INTO emergency_contacts (family_id, name, phone, relation, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, phone, relation',
      [familyId, b.name, b.phone, b.relation ?? null, me(req).id],
    );
    await audit(ctx.db, { actorId: me(req).id, familyId, action: 'family.emergency_contact_add', targetType: 'emergency_contact', targetId: r.rows[0].id });
    return r.rows[0];
  });

  app.delete('/families/:id/emergency-contacts/:contactId', auth, async (req) => {
    const p = parse(z.object({ id: z.string().uuid(), contactId: z.string().uuid() }), req.params);
    await requireParent(ctx.db, me(req).id, p.id);
    await ctx.db.query('UPDATE emergency_contacts SET deleted_at = now() WHERE id = $1 AND family_id = $2', [p.contactId, p.id]);
    return { ok: true };
  });

  // Notification preferences (per parent per family)
  app.get('/families/:id/notification-preferences', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    await requireMember(ctx.db, me(req).id, familyId);
    return loadPreferences(ctx.db, me(req).id, familyId);
  });

  app.put('/families/:id/notification-preferences', auth, async (req) => {
    const { id: familyId } = parse(id, req.params);
    await requireMember(ctx.db, me(req).id, familyId);
    const b = parse(
      z.object({
        disabledTypes: z.array(notificationTypes).max(20).default([]),
        minSpeedingSeverity: severities.default(DEFAULT_NOTIFICATION_PREFERENCES.minSpeedingSeverity),
        soundFromSeverity: severities.default(DEFAULT_NOTIFICATION_PREFERENCES.soundFromSeverity),
        cooldownSeconds: z.number().int().min(0).max(3600).default(DEFAULT_NOTIFICATION_PREFERENCES.cooldownSeconds),
      }),
      req.body,
    );
    await ctx.db.query(
      `INSERT INTO notification_preferences (user_id, family_id, prefs) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, family_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
      [me(req).id, familyId, b],
    );
    return b;
  });
}
