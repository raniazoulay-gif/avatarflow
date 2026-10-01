import { countryProfile } from '@safedrive/core';
import { type Db, withTx } from '../db/pool.js';
import { inviteCode, sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from './audit.js';

export const CONSENT_VERSION = '2026-10-01';
const INVITE_TTL_DAYS = 7;

export class FamilyService {
  constructor(private readonly db: Db) {}

  async create(
    userId: string,
    input: { name: string; countryCode?: string; isDemo?: boolean; parentDisplayName?: string },
  ) {
    const profile = countryProfile(input.countryCode ?? 'IL');
    return withTx(this.db, async (c) => {
      const u = await c.query<{ display_name: string }>(
        'SELECT display_name FROM users WHERE id = $1',
        [userId],
      );
      const f = await c.query<{ id: string }>(
        `INSERT INTO families (name, country_code, timezone, is_demo, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [input.name.trim(), profile.code, profile.timezone, input.isDemo ?? false, userId],
      );
      const familyId = (f.rows[0] as { id: string }).id;
      await c.query(
        `INSERT INTO family_members (family_id, user_id, role, display_name) VALUES ($1, $2, 'PARENT', $3)`,
        [familyId, userId, input.parentDisplayName ?? u.rows[0]?.display_name ?? 'Parent'],
      );
      await audit(c, {
        actorId: userId,
        familyId,
        action: 'family.create',
        targetType: 'family',
        targetId: familyId,
      });
      return {
        id: familyId,
        name: input.name.trim(),
        countryCode: profile.code,
        timezone: profile.timezone,
        isDemo: input.isDemo ?? false,
      };
    });
  }

  async listForUser(userId: string) {
    const { rows } = await this.db.query(
      `SELECT f.id, f.name, f.country_code AS "countryCode", f.timezone, f.is_demo AS "isDemo", m.role,
              (SELECT d.id FROM drivers d WHERE d.member_id = m.id AND d.deleted_at IS NULL) AS "driverId"
       FROM family_members m JOIN families f ON f.id = m.family_id
       WHERE m.user_id = $1 AND m.removed_at IS NULL AND f.deleted_at IS NULL ORDER BY f.created_at`,
      [userId],
    );
    return rows;
  }

  async detail(familyId: string) {
    const f = await this.db.query(
      `SELECT id, name, country_code AS "countryCode", timezone, is_demo AS "isDemo", created_at AS "createdAt"
       FROM families WHERE id = $1 AND deleted_at IS NULL`,
      [familyId],
    );
    if (!f.rowCount) throw notFound('Family not found');
    const members = await this.db.query(
      `SELECT m.id, m.user_id AS "userId", m.role, m.display_name AS "displayName", m.joined_at AS "joinedAt",
              d.id AS "driverId", d.safety_score AS "safetyScore"
       FROM family_members m LEFT JOIN drivers d ON d.member_id = m.id AND d.deleted_at IS NULL
       WHERE m.family_id = $1 AND m.removed_at IS NULL ORDER BY m.joined_at`,
      [familyId],
    );
    return {
      ...f.rows[0],
      members: members.rows,
      emergencyNumbers: countryProfile(f.rows[0].countryCode).emergencyNumbers,
    };
  }

  async createInvite(
    userId: string,
    familyId: string,
    role: 'PARENT' | 'DRIVER',
    displayName: string,
  ) {
    const code = inviteCode(8);
    const r = await this.db.query<{ id: string; expires_at: Date }>(
      `INSERT INTO family_invites (family_id, code_hash, role, display_name, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval) RETURNING id, expires_at`,
      [familyId, sha256(code), role, displayName.trim(), userId, String(INVITE_TTL_DAYS)],
    );
    const inv = r.rows[0] as { id: string; expires_at: Date };
    await audit(this.db, {
      actorId: userId,
      familyId,
      action: 'family.invite',
      targetType: 'invite',
      targetId: inv.id,
      details: { role },
    });
    // The plain code is returned once and never stored.
    return { id: inv.id, code, role, displayName, expiresAt: inv.expires_at.toISOString() };
  }

  /**
   * Joining as DRIVER requires explicit consent to transparent trip monitoring
   * (recorded with its version). There is no way to add a driver without it.
   */
  async acceptInvite(userId: string, code: string, consent: boolean) {
    return withTx(this.db, async (c) => {
      const r = await c.query<{
        id: string;
        family_id: string;
        role: 'PARENT' | 'DRIVER';
        display_name: string;
        expires_at: Date;
      }>(
        `SELECT id, family_id, role, display_name, expires_at FROM family_invites
         WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE`,
        [sha256(code.trim().toUpperCase())],
      );
      const inv = r.rows[0];
      if (!inv || inv.expires_at < new Date()) throw notFound('Invite code is invalid or expired');
      if (inv.role === 'DRIVER' && !consent)
        throw badRequest('Driver consent to trip monitoring is required');
      const exists = await c.query(
        'SELECT 1 FROM family_members WHERE family_id = $1 AND user_id = $2 AND removed_at IS NULL',
        [inv.family_id, userId],
      );
      if (exists.rowCount) throw conflict('You are already a member of this family');
      const m = await c.query<{ id: string }>(
        `INSERT INTO family_members (family_id, user_id, role, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
        [inv.family_id, userId, inv.role, inv.display_name],
      );
      const memberId = (m.rows[0] as { id: string }).id;
      let driverId: string | null = null;
      if (inv.role === 'DRIVER') {
        const d = await c.query<{ id: string }>(
          `INSERT INTO drivers (family_id, member_id, user_id, display_name, consent_at, consent_version)
           VALUES ($1, $2, $3, $4, now(), $5) RETURNING id`,
          [inv.family_id, memberId, userId, inv.display_name, CONSENT_VERSION],
        );
        driverId = (d.rows[0] as { id: string }).id;
      }
      await c.query('UPDATE family_invites SET used_at = now(), used_by = $2 WHERE id = $1', [
        inv.id,
        userId,
      ]);
      await audit(c, {
        actorId: userId,
        familyId: inv.family_id,
        action: 'family.join',
        targetType: 'member',
        targetId: memberId,
        details: { role: inv.role, consentVersion: inv.role === 'DRIVER' ? CONSENT_VERSION : null },
      });
      return { familyId: inv.family_id, role: inv.role, memberId, driverId };
    });
  }

  async removeMember(actorId: string, familyId: string, memberId: string) {
    const r = await this.db.query<{ user_id: string; role: string }>(
      'SELECT user_id, role FROM family_members WHERE id = $1 AND family_id = $2 AND removed_at IS NULL',
      [memberId, familyId],
    );
    const m = r.rows[0];
    if (!m) throw notFound('Member not found');
    if (m.role === 'PARENT') {
      const parents = await this.db.query(
        `SELECT count(*)::int AS n FROM family_members WHERE family_id = $1 AND role = 'PARENT' AND removed_at IS NULL`,
        [familyId],
      );
      if ((parents.rows[0] as { n: number }).n <= 1)
        throw forbidden('A family needs at least one administrator');
    }
    await withTx(this.db, async (c) => {
      await c.query('UPDATE family_members SET removed_at = now() WHERE id = $1', [memberId]);
      await c.query('UPDATE drivers SET deleted_at = now() WHERE member_id = $1', [memberId]);
      await audit(c, {
        actorId,
        familyId,
        action: 'family.remove_member',
        targetType: 'member',
        targetId: memberId,
      });
    });
  }

  /**
   * Account deletion: personal data is removed or anonymised; raw telemetry of the
   * user's own trips is deleted. Audit rows keep only ids (legal retention).
   */
  async deleteAccount(userId: string) {
    await withTx(this.db, async (c) => {
      const drivers = await c.query<{ id: string }>('SELECT id FROM drivers WHERE user_id = $1', [
        userId,
      ]);
      const ids = drivers.rows.map((d) => d.id);
      if (ids.length) {
        await c.query(
          `UPDATE trips SET ended_at = coalesce(ended_at, now()), state = 'COMPLETED' WHERE driver_id = ANY($1) AND ended_at IS NULL`,
          [ids],
        );
        await c.query(
          'DELETE FROM telemetry_points WHERE trip_id IN (SELECT id FROM trips WHERE driver_id = ANY($1))',
          [ids],
        );
        await c.query(
          `UPDATE trips SET start_lat = NULL, start_lon = NULL, end_lat = NULL, end_lon = NULL, live = '{}'::jsonb,
             engine_state = '{}'::jsonb WHERE driver_id = ANY($1)`,
          [ids],
        );
        await c.query('UPDATE safety_events SET lat = NULL, lon = NULL WHERE driver_id = ANY($1)', [
          ids,
        ]);
        await c.query(
          'UPDATE speeding_events SET start_lat = NULL, start_lon = NULL, max_lat = NULL, max_lon = NULL WHERE trip_id IN (SELECT id FROM trips WHERE driver_id = ANY($1))',
          [ids],
        );
        await c.query('UPDATE sos_events SET lat = NULL, lon = NULL WHERE driver_id = ANY($1)', [
          ids,
        ]);
        await c.query(
          `UPDATE drivers SET deleted_at = now(), display_name = 'deleted' WHERE id = ANY($1)`,
          [ids],
        );
      }
      await c.query(
        `UPDATE family_members SET removed_at = now(), display_name = 'deleted' WHERE user_id = $1 AND removed_at IS NULL`,
        [userId],
      );
      await c.query('UPDATE devices SET revoked_at = now(), push_token = NULL WHERE user_id = $1', [
        userId,
      ]);
      await c.query(
        'UPDATE device_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
        [userId],
      );
      await c.query('DELETE FROM notifications WHERE recipient_id = $1', [userId]);
      await c.query(
        `UPDATE users SET deleted_at = now(), email = 'deleted-' || id || '@invalid', display_name = 'deleted',
           password_hash = 'deleted', status = 'suspended' WHERE id = $1`,
        [userId],
      );
      await audit(c, {
        actorId: userId,
        action: 'user.delete',
        targetType: 'user',
        targetId: userId,
      });
    });
  }
}
