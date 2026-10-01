/** WebSocket client with auth handshake, heartbeat and exponential reconnect. */
import { getSession, onSession, wsUrl } from './api';

export interface RtMessage {
  type: string;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

type Handler = (m: RtMessage) => void;
const handlers = new Set<Handler>();
const statusHandlers = new Set<(s: RtStatus) => void>();
export type RtStatus = 'connecting' | 'online' | 'offline';

let ws: WebSocket | null = null;
let attempt = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let ping: ReturnType<typeof setInterval> | null = null;
let status: RtStatus = 'offline';

function setStatus(s: RtStatus) {
  status = s;
  for (const h of statusHandlers) h(s);
}

function connect() {
  const s = getSession();
  if (!s || ws) return;
  setStatus('connecting');
  const sock = new WebSocket(wsUrl());
  ws = sock;
  sock.onopen = () => sock.send(JSON.stringify({ type: 'auth', token: getSession()?.accessToken }));
  sock.onmessage = (e) => {
    if (ws !== sock) return; // a replaced socket must never deliver messages
    const m = JSON.parse(String(e.data)) as RtMessage;
    if (m.type === 'ready') {
      attempt = 0;
      setStatus('online');
      ping = setInterval(
        () => sock.readyState === WebSocket.OPEN && sock.send('{"type":"ping"}'),
        25_000,
      );
    }
    for (const h of handlers) h(m);
  };
  sock.onclose = () => {
    if (ws !== sock) return; // closed on purpose by restart/stop: the new socket owns the state
    ws = null;
    if (ping) clearInterval(ping);
    setStatus('offline');
    if (!getSession()) return;
    const delay = Math.min(30_000, 1000 * 2 ** attempt++) + Math.random() * 500;
    timer = setTimeout(connect, delay);
  };
}

export function startRealtime(): void {
  connect();
}

export function stopRealtime(): void {
  if (timer) clearTimeout(timer);
  if (ping) clearInterval(ping);
  const old = ws;
  ws = null;
  old?.close();
  setStatus('offline');
}

/** Reconnect to pick up new families / a refreshed token. */
export function restartRealtime(): void {
  stopRealtime();
  attempt = 0;
  connect();
}

export function subscribe(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}

export function onRealtimeStatus(h: (s: RtStatus) => void): () => void {
  statusHandlers.add(h);
  h(status);
  return () => statusHandlers.delete(h);
}

onSession((s) => (s ? restartRealtime() : stopRealtime()));
