import { randomUUID } from 'node:crypto';
import { type Db } from '../db/pool.js';
import {
  hashPassword,
  verifyPassword,
  passwordProblem,
  sha256,
  randomToken,
} from '../lib/crypto.js';
import { badRequest, conflict, unauthorized, tooMany } from '../lib/errors.js';
import { type TokenService } from '../auth/tokens.js';
import { audit } from './audit.js';

const MAX_FAILED = 10;
const LOCK_MINUTES = 15;

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  locale: string;
  is_system_admin: boolean;
  status: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
}

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  locale: string;
  isSystemAdmin: boolean;
}

export const publicUser = (u: UserRow): PublicUser => ({
  id: u.id,
  email: u.email,
  displayName: u.display_name,
  locale: u.locale,
  isSystemAdmin: u.is_system_admin,
});

interface Meta {
  ip?: string;
  userAgent?: string;
  deviceId?: string | null;
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly tokens: TokenService,
    private readonly accessTtl: number,
    private readonly refreshTtlDays: number,
    private readonly bootstrapAdminEmail?: string,
  ) {}

  async register(
    input: { email: string; password: string; displayName: string; locale?: string },
    meta: Meta,
  ): Promise<SessionTokens> {
    const email = input.email.trim().toLowerCase();
    const problem = passwordProblem(input.password);
    if (problem) throw badRequest(problem);
    const exists = await this.db.query(
      'SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL',
      [email],
    );
    if (exists.rowCount) throw conflict('An account with this email already exists');
    const hash = await hashPassword(input.password);
    const admin = !!this.bootstrapAdminEmail && this.bootstrapAdminEmail.toLowerCase() === email;
    const { rows } = await this.db.query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name, locale, is_system_admin)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name, locale, is_system_admin, status`,
      [email, hash, input.displayName.trim(), input.locale ?? 'he', admin],
    );
    const user = rows[0] as UserRow;
    await audit(this.db, {
      actorId: user.id,
      action: 'user.register',
      targetType: 'user',
      targetId: user.id,
      ip: meta.ip ?? null,
    });
    return this.issue(user, meta);
  }

  async login(emailRaw: string, password: string, meta: Meta): Promise<SessionTokens> {
    const email = emailRaw.trim().toLowerCase();
    const { rows } = await this.db.query<
      UserRow & { password_hash: string; failed_logins: number; locked_until: Date | null }
    >(
      `SELECT id, email, display_name, locale, is_system_admin, status, password_hash, failed_logins, locked_until
       FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`,
      [email],
    );
    const u = rows[0];
    if (u?.locked_until && u.locked_until > new Date())
      throw tooMany('Too many failed attempts. Try again later.');
    // Always run a hash comparison so response time does not reveal whether the email exists.
    const ok = u
      ? await verifyPassword(password, u.password_hash)
      : await verifyPassword(password, 'scrypt$16384$8$1$00$00').catch(() => false);
    if (!u || !ok) {
      if (u) {
        await this.db.query(
          `UPDATE users SET failed_logins = failed_logins + 1,
             locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
           WHERE id = $1`,
          [u.id, MAX_FAILED, String(LOCK_MINUTES)],
        );
        await audit(this.db, {
          actorId: u.id,
          action: 'auth.login_failed',
          targetType: 'user',
          targetId: u.id,
          ip: meta.ip ?? null,
        });
      }
      throw unauthorized('Invalid email or password');
    }
    if (u.status !== 'active') throw unauthorized('Account suspended');
    await this.db.query(
      'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1',
      [u.id],
    );
    await audit(this.db, {
      actorId: u.id,
      action: 'auth.login',
      targetType: 'user',
      targetId: u.id,
      ip: meta.ip ?? null,
    });
    return this.issue(u, meta);
  }

  private async issue(
    user: UserRow,
    meta: Meta,
    chainId: string = randomUUID(),
  ): Promise<SessionTokens> {
    const secret = randomToken();
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO device_sessions (user_id, device_id, chain_id, token_hash, expires_at, ip, user_agent)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' days')::interval, $6, $7) RETURNING id`,
      [
        user.id,
        meta.deviceId ?? null,
        chainId,
        sha256(secret),
        String(this.refreshTtlDays),
        meta.ip ?? null,
        meta.userAgent ?? null,
      ],
    );
    const sid = (rows[0] as { id: string }).id;
    const accessToken = await this.tokens.sign({ sub: user.id, sid, adm: user.is_system_admin });
    return {
      accessToken,
      refreshToken: `${sid}.${secret}`,
      expiresIn: this.accessTtl,
      user: publicUser(user),
    };
  }

  /** Rotates a refresh token. Reusing an already-rotated token revokes the whole chain. */
  async refresh(refreshToken: string, meta: Meta): Promise<SessionTokens> {
    const [sid, secret] = refreshToken.split('.');
    if (!sid || !secret || !/^[0-9a-f-]{36}$/.test(sid))
      throw unauthorized('Invalid refresh token');
    const { rows } = await this.db.query<{
      id: string;
      user_id: string;
      chain_id: string;
      token_hash: string;
      expires_at: Date;
      rotated_at: Date | null;
      revoked_at: Date | null;
      device_id: string | null;
    }>('SELECT * FROM device_sessions WHERE id = $1', [sid]);
    const s = rows[0];
    if (!s || s.token_hash !== sha256(secret)) throw unauthorized('Invalid refresh token');
    if (s.rotated_at || s.revoked_at) {
      await this.db.query(
        'UPDATE device_sessions SET revoked_at = coalesce(revoked_at, now()) WHERE chain_id = $1',
        [s.chain_id],
      );
      await audit(this.db, {
        actorId: s.user_id,
        action: 'auth.refresh_reuse_detected',
        targetType: 'session',
        targetId: s.id,
        ip: meta.ip ?? null,
      });
      throw unauthorized('Session revoked');
    }
    if (s.expires_at < new Date()) throw unauthorized('Session expired');
    const claimed = await this.db.query(
      'UPDATE device_sessions SET rotated_at = now() WHERE id = $1 AND rotated_at IS NULL AND revoked_at IS NULL',
      [s.id],
    );
    if (claimed.rowCount !== 1) throw unauthorized('Session revoked');
    const u = await this.db.query<UserRow>(
      'SELECT id, email, display_name, locale, is_system_admin, status FROM users WHERE id = $1 AND deleted_at IS NULL',
      [s.user_id],
    );
    const user = u.rows[0];
    if (!user || user.status !== 'active') throw unauthorized('Account unavailable');
    return this.issue(user, { ...meta, deviceId: s.device_id }, s.chain_id);
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.query(
      'UPDATE device_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [sessionId],
    );
  }

  async logoutAll(userId: string): Promise<void> {
    await this.db.query(
      'UPDATE device_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
  }

  /** Access-token check: valid JWT + live session + active user. */
  async authenticate(accessToken: string): Promise<{ user: UserRow; sessionId: string } | null> {
    const claims = await this.tokens.verify(accessToken);
    if (!claims) return null;
    const { rows } = await this.db.query<UserRow>(
      `SELECT u.id, u.email, u.display_name, u.locale, u.is_system_admin, u.status
       FROM device_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()
         AND u.deleted_at IS NULL AND u.status = 'active'`,
      [claims.sid, claims.sub],
    );
    const user = rows[0];
    return user ? { user, sessionId: claims.sid } : null;
  }
}
