import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { type AuthService, type UserRow } from '../services/auth.js';
import { forbidden, unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: { user: UserRow; sessionId: string };
  }
}

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

export function registerAuth(app: FastifyInstance, auth: AuthService): void {
  app.decorateRequest('auth', undefined);
  app.decorate('requireAuth', async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const a = await auth.authenticate(token);
    if (!a) throw unauthorized('Session expired or revoked');
    req.auth = a;
  });
  app.decorate('requireSystemAdmin', async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const a = await auth.authenticate(token);
    if (!a) throw unauthorized('Session expired or revoked');
    if (!a.user.is_system_admin) throw forbidden('System administrators only');
    req.auth = a;
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest) => Promise<void>;
    requireSystemAdmin: (req: FastifyRequest) => Promise<void>;
  }
}

export function me(req: FastifyRequest): UserRow {
  if (!req.auth) throw unauthorized();
  return req.auth.user;
}
