import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, getSession, onSession, type Session } from './api';

export interface FamilyRef {
  id: string;
  name: string;
  countryCode: string;
  timezone: string;
  isDemo: boolean;
  role: 'PARENT' | 'DRIVER';
  driverId: string | null;
}

interface AppState {
  session: Session | null;
  families: FamilyRef[];
  family: FamilyRef | null;
  selectFamily: (id: string) => void;
  reload: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [session, setS] = useState<Session | null>(getSession());
  const [families, setFamilies] = useState<FamilyRef[]>([]);
  const [familyId, setFamilyId] = useState<string | null>(() =>
    localStorage.getItem('safedrive.family'),
  );

  useEffect(() => onSession(setS), []);

  const reload = useCallback(async () => {
    if (!getSession()) {
      setFamilies([]);
      return;
    }
    const me = await get<{ families: FamilyRef[] }>('/me');
    setFamilies(me.families);
  }, []);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [session, reload]);

  const selectFamily = (id: string) => {
    setFamilyId(id);
    localStorage.setItem('safedrive.family', id);
  };
  const family =
    families.find((f) => f.id === familyId) ??
    families.find((f) => f.role === 'PARENT') ??
    families[0] ??
    null;
  return (
    <Ctx.Provider value={{ session, families, family, selectFamily, reload }}>
      {children}
    </Ctx.Provider>
  );
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppStateProvider missing');
  return v;
}
