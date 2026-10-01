import { type Queryable } from '../db/pool.js';

export interface AuditEntry {
  actorId?: string | null;
  familyId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/** Append-only audit trail (login, permission/family/monitoring changes, SOS, admin actions). */
export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (actor_id, family_id, action, target_type, target_id, ip, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [e.actorId ?? null, e.familyId ?? null, e.action, e.targetType ?? null, e.targetId ?? null, e.ip ?? null, e.details ?? {}],
  );
}
