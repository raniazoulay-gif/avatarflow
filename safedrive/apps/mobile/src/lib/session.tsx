import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { call, clearSession, restoreSession, saveSession, type User } from './api';

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

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [families, setFamilies] = useState<FamilyRef[]>([]);

  const reload = useCallback(async () => {
    const r = await call<{ user: User; families: FamilyRef[] }>('/me');
    setUser(r.user);
    setFamilies(r.families);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (await restoreSession()) await reload();
      } catch {
        // offline start: the driver can still see the cached trip once signed in
      } finally {
        setReady(true);
      }
    })();
  }, [reload]);

  const signIn = useCallback(
    async (path: '/auth/login' | '/auth/register', body: Record<string, string>) => {
      const r = await call<{ accessToken: string; refreshToken: string }>(path, 'POST', body, false);
      await saveSession(r);
      await reload();
    },
    [reload],
  );

  const signOut = useCallback(async () => {
    await call('/auth/logout', 'POST', {}).catch(() => undefined);
    await clearSession();
    setUser(null);
    setFamilies([]);
  }, []);

  return <SessionCtx.Provider value={{ ready, user, families, reload, signIn, signOut }}>{children}</SessionCtx.Provider>;
}

export function useSession(): Ctx {
  const c = useContext(SessionCtx);
  if (!c) throw new Error('SessionProvider missing');
  return c;
}
