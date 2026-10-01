/**
 * WebSocket endpoint. The client sends {"type":"auth","token":...} first (the token is
 * never put in the URL, so it does not land in proxy logs). Parents are subscribed
 * to their families' channels; everybody to their own user channel.
 */
import { type FastifyInstance } from 'fastify';
import '@fastify/websocket';
import { type WebSocket } from 'ws';
import { type AppContext } from '../context.js';
import { familyChannel, userChannel, type RealtimeMessage } from './bus.js';

const AUTH_TIMEOUT_MS = 10_000;
/** Access is re-checked periodically: logout, suspension or removal from a family stop the stream. */
const RECHECK_MS = 30_000;

export function registerWebSocket(app: FastifyInstance, ctx: AppContext): void {
  let connections = 0;
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const unsubs: Array<() => void> = [];
    let authed = false;
    let recheck: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    const send = (m: RealtimeMessage) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
    };
    const timer = setTimeout(() => {
      if (!authed) socket.close(4001, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    socket.on('message', (raw) => {
      void (async () => {
        let msg: { type?: string; token?: string };
        try {
          msg = JSON.parse(String(raw)) as { type?: string; token?: string };
        } catch {
          return;
        }
        if (msg.type === 'ping') return send({ type: 'pong', data: Date.now() });
        if (msg.type !== 'auth' || authed) return;
        const a = msg.token ? await ctx.auth.authenticate(msg.token) : null;
        if (!a) {
          socket.close(4003, 'unauthorized');
          return;
        }
        authed = true;
        clearTimeout(timer);
        connections += 1;
        ctx.metrics.inc('ws_connections_opened');
        if (closed) return;
        unsubs.push(ctx.bus.subscribe(userChannel(a.user.id), send));
        const families = new Map<string, () => void>();
        const syncFamilies = async (): Promise<string[]> => {
          const fams = await ctx.db.query<{ family_id: string }>(
            `SELECT family_id FROM family_members WHERE user_id = $1 AND role = 'PARENT' AND removed_at IS NULL`,
            [a.user.id],
          );
          const now = new Set(fams.rows.map((f) => f.family_id));
          for (const [id, unsub] of families)
            if (!now.has(id)) {
              unsub();
              families.delete(id);
            }
          for (const id of now)
            if (!closed && !families.has(id))
              families.set(id, ctx.bus.subscribe(familyChannel(id), send));
          return [...now];
        };
        unsubs.push(() => {
          for (const u of families.values()) u();
          families.clear();
        });
        send({ type: 'ready', data: { families: await syncFamilies() } });
        if (closed) return;
        recheck = setInterval(() => {
          void (async () => {
            // The session chain must still have a live head (refresh rotation keeps the chain).
            const ok = await ctx.db.query(
              `SELECT 1 FROM device_sessions s JOIN users u ON u.id = s.user_id
               WHERE s.chain_id = (SELECT chain_id FROM device_sessions WHERE id = $1)
                 AND s.revoked_at IS NULL AND s.expires_at > now()
                 AND u.status = 'active' AND u.deleted_at IS NULL LIMIT 1`,
              [a.sessionId],
            );
            if (!ok.rowCount) return socket.close(4003, 'session ended');
            await syncFamilies();
          })().catch(() => socket.close(1011, 'error'));
        }, RECHECK_MS);
        recheck.unref?.();
      })().catch(() => socket.close(1011, 'error'));
    });
    socket.on('close', () => {
      closed = true;
      clearTimeout(timer);
      if (recheck) clearInterval(recheck);
      if (authed) connections -= 1;
      for (const u of unsubs) u();
    });
  });
  app.decorate('wsConnections', () => connections);
}

declare module 'fastify' {
  interface FastifyInstance {
    wsConnections: () => number;
  }
}
