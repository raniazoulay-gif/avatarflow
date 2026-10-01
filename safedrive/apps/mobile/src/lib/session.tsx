import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  call,
  clearSession,
  hasStoredSession,
  restoreSession,
  saveSession,
  type User,
} from './api';
import { controller } from './location';
import { kv } from './storage';
import { s } from './i18n';

export interface FamilyRef {
  id: string;
  name: string;
  countryCode: string;
  timezone: string;
  isDemo: boolean;
  role: 'PARENT' | 'DRIVER';
  driverId: string | null;
}

interface Ctx {
  ready: boolean;
  user: User | null;
  families: FamilyRef[];
  reload(): Promise<void>;
  signIn(path: '/auth/login' | '/auth/register', body: Record<string, string>): Promise<void>;
  signOut(): Promise<void>;
}

const SessionCtx = createContext<Ctx | null>(null);
const K_PROFILE = 'sd.profile';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [families, setFamilies] = useState<FamilyRef[]>([]);

  const reload = useCallback(async () => {
    const r = await call<{ user: User; families: FamilyRef[] }>('/me');
    setUser(r.user);
    setFamilies(r.families);
    // Cached so a driver can still end a trip / send SOS after an offline restart.
    await kv.set(K_PROFILE, JSON.stringify(r));
  }, []);

  useEffect(() => {
    void (async () => {
      let ok = false;
      try {
        if (await restoreSession()) {
          await reload();
          ok = true;
        }
      } catch {
        // offline start: fall back to the cached profile below
      }
      try {
        const cached = !ok && (await hasStoredSession()) ? await kv.get(K_PROFILE) : null;
        if (cached) {
          const r = JSON.parse(cached) as { user: User; families: FamilyRef[] };
          setUser(r.user);
          setFamilies(r.families);
        }
      } finally {
        setReady(true);
      }
    })();
  }, [reload]);

  const signIn = useCallback(
    async (path: '/auth/login' | '/auth/register', body: Record<string, string>) => {
      const r = await call<{ accessToken: string; refreshToken: string }>(
        path,
        'POST',
        body,
        false,
      );
      await saveSession(r);
      await reload();
    },
    [reload],
  );

  const signOut = useCallback(async () => {
    // Never abandon a trip, a stop or an SOS that has not reached the server yet.
    if (controller.snapshot.tripId || controller.hasPendingWork)
      throw new Error(s('signOutBlocked'));
    await call('/auth/logout', 'POST', {}).catch(() => undefined);
    await kv.remove(K_PROFILE);
    await clearSession();
    setUser(null);
    setFamilies([]);
  }, []);

  return (
    <SessionCtx.Provider value={{ ready, user, families, reload, signIn, signOut }}>
      {children}
    </SessionCtx.Provider>
  );
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}
