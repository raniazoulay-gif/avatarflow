/**
 * API client. Access tokens are short-lived; the refresh token is rotated on every
 * refresh (server detects reuse). Tokens live in localStorage for this web console -
 * see SECURITY.md for the trade-off and the CSP/hardening that goes with it.
 */
const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';
const KEY = 'safedrive.session';

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; displayName: string; locale: string; isSystemAdmin: boolean };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

let session: Session | null = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
})();
const listeners = new Set<(s: Session | null) => void>();

export function getSession(): Session | null {
  return session;
}

export function setSession(s: Session | null): void {
  session = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: session lives in memory only */
  }
  for (const l of listeners) l(s);
}

export function onSession(fn: (s: Session | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (!session) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const r = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: session?.refreshToken }),
        });
        if (!r.ok) {
          setSession(null);
          return false;
        }
        setSession((await r.json()) as Session);
        return true;
      } catch {
        return false;
      } finally {
        setTimeout(() => (refreshing = null), 0);
      }
    })();
  }
  return refreshing;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  retry = true,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  const r = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401 && retry && session && !path.startsWith('/auth/')) {
    if (await refresh()) return api<T>(path, init, false);
  }
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok)
    throw new ApiError(r.status, data?.error ?? 'error', data?.message ?? `HTTP ${r.status}`);
  return data as T;
}

export const get = <T>(p: string) => api<T>(p);
export const post = <T>(p: string, body: unknown = {}) => api<T>(p, { method: 'POST', body });
export const put = <T>(p: string, body: unknown = {}) => api<T>(p, { method: 'PUT', body });
export const del = <T>(p: string, body?: unknown) => api<T>(p, { method: 'DELETE', body });

export function wsUrl(): string {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}
