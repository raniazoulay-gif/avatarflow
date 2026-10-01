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

export function registerWebSocket(app: FastifyInstance, ctx: AppContext): void {
  let connections = 0;
  app.get('/ws', { websocket: true }, (socket: WebSocket) => {
    const unsubs: Array<() => void> = [];
    let authed = false;
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
        unsubs.push(ctx.bus.subscribe(userChannel(a.user.id), send));
        const fams = await ctx.db.query<{ family_id: string }>(
          `SELECT family_id FROM family_members WHERE user_id = $1 AND role = 'PARENT' AND removed_at IS NULL`,
          [a.user.id],
        );
        for (const f of fams.rows) unsubs.push(ctx.bus.subscribe(familyChannel(f.family_id), send));
        send({ type: 'ready', data: { families: fams.rows.map((f) => f.family_id) } });
      })().catch(() => socket.close(1011, 'error'));
    });
    socket.on('close', () => {
      clearTimeout(timer);
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
