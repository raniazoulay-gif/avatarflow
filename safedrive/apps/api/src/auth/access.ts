/**
 * Family-level data isolation. Every route that touches family data goes through
 * one of these helpers. Not-a-member is answered with 404 (never reveals existence).
 */
import { type Queryable } from '../db/pool.js';
import { forbidden, notFound } from '../lib/errors.js';

export interface Membership {
  member_id: string;
  family_id: string;
  role: 'PARENT' | 'DRIVER';
  display_name: string;
}

export async function membership(db: Queryable, userId: string, familyId: string): Promise<Membership | null> {
  const { rows } = await db.query<Membership>(
    `SELECT m.id AS member_id, m.family_id, m.role, m.display_name
     FROM family_members m JOIN families f ON f.id = m.family_id
     WHERE m.user_id = $1 AND m.family_id = $2 AND m.removed_at IS NULL AND f.deleted_at IS NULL`,
    [userId, familyId],
  );
  return rows[0] ?? null;
}

export async function requireMember(db: Queryable, userId: string, familyId: string): Promise<Membership> {
  const m = await membership(db, userId, familyId);
  if (!m) throw notFound('Family not found');
  return m;
}

export async function requireParent(db: Queryable, userId: string, familyId: string): Promise<Membership> {
  const m = await requireMember(db, userId, familyId);
  if (m.role !== 'PARENT') throw forbidden('Family administrators only');
  return m;
}

export interface DriverRow {
  id: string;
  family_id: string;
  user_id: string;
  display_name: string;
  safety_score: number | null;
}

/** Driver access: the driver themself, or a PARENT of the driver's family. */
export async function requireDriverAccess(
  db: Queryable,
  userId: string,
  driverId: string,
): Promise<{ driver: DriverRow; as: 'self' | 'parent' }> {
  const { rows } = await db.query<DriverRow>(
    `SELECT id, family_id, user_id, display_name, safety_score FROM drivers WHERE id = $1 AND deleted_at IS NULL`,
    [driverId],
  );
  const d = rows[0];
  if (!d) throw notFound('Driver not found');
  if (d.user_id === userId) return { driver: d, as: 'self' };
  const m = await membership(db, userId, d.family_id);
  if (m?.role === 'PARENT') return { driver: d, as: 'parent' };
  throw notFound('Driver not found');
}

export async function requireTripAccess(
  db: Queryable,
  userId: string,
  tripId: string,
): Promise<{ tripId: string; driver: DriverRow; as: 'self' | 'parent' }> {
  const { rows } = await db.query<{ driver_id: string }>('SELECT driver_id FROM trips WHERE id = $1', [tripId]);
  const t = rows[0];
  if (!t) throw notFound('Trip not found');
  try {
    const a = await requireDriverAccess(db, userId, t.driver_id);
    return { tripId, ...a };
  } catch {
    throw notFound('Trip not found');
  }
}

export async function parentUserIds(db: Queryable, familyId: string): Promise<string[]> {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT user_id FROM family_members WHERE family_id = $1 AND role = 'PARENT' AND removed_at IS NULL`,
    [familyId],
  );
  return rows.map((r) => r.user_id);
}
