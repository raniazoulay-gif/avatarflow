/* eslint-disable no-console -- CLI output */
/**
 * Grants or revokes system-admin rights (operators with database access only):
 *   DATABASE_URL=... npm run admin:grant -- someone@example.com [--revoke]
 */
import { createPool } from '../db/pool.js';
import { audit } from '../services/audit.js';

async function main(): Promise<void> {
  const [email, flag] = process.argv.slice(2);
  if (!email || !process.env.DATABASE_URL)
    throw new Error('Usage: DATABASE_URL=... admin:grant EMAIL [--revoke]');
  const db = createPool(process.env.DATABASE_URL, 2);
  const grant = flag !== '--revoke';
  const r = await db.query<{ id: string }>(
    'UPDATE users SET is_system_admin = $2, updated_at = now() WHERE lower(email) = lower($1) AND deleted_at IS NULL RETURNING id',
    [email, grant],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error('No such user');
  await audit(db, {
    actorId: null,
    action: grant ? 'admin.grant_cli' : 'admin.revoke_cli',
    targetType: 'user',
    targetId: id,
  });
  console.log(`${email}: system admin ${grant ? 'granted' : 'revoked'}`);
  await db.end();
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
