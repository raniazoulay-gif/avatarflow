import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { get, post, setSession } from './lib/api';
import { getLang, setLang, tr } from './lib/i18n';
import { onRealtimeStatus, startRealtime, subscribe, type RtStatus } from './lib/realtime';
import { useApp } from './lib/state';
import { setTileConfig } from './components/MapView';
import { LoginPage } from './pages/Login';
import { OnboardingPage } from './pages/Onboarding';
import { LivePage } from './pages/Live';
import { DriversPage } from './pages/Drivers';
import { TripPage } from './pages/Trip';
import { NotificationsPage } from './pages/Notifications';
import { SosPage } from './pages/Sos';
import { FamilyPage } from './pages/Family';
import { DemoPage } from './pages/Demo';
import { AdminPage } from './pages/admin/Admin';

function Toasts() {
  const [items, setItems] = useState<
    Array<{ id: string; title: string; body: string; type: string }>
  >([]);
  useEffect(
    () =>
      subscribe((m) => {
        if (m.type !== 'notification') return;
        const n = m.data as { id: string; title: string; body: string; type: string };
        setItems((x) => (x.some((i) => i.id === n.id) ? x : [...x.slice(-2), n]));
        setTimeout(() => setItems((x) => x.filter((i) => i.id !== n.id)), 7000);
      }),
    [],
  );
  return (
    <>
      {items.map((n, i) => (
        <div
          key={n.id}
          className={`toast ${n.type.replace('SPEEDING_', '')}`}
          style={{ bottom: 18 + i * 76 }}
          role="status"
        >
          <strong>{n.title}</strong>
          <div>{n.body}</div>
        </div>
      ))}
    </>
  );
}

export function App() {
  const { session, families, family, selectFamily } = useApp();
  const [rt, setRt] = useState<RtStatus>('offline');
  const [, force] = useState(0);
  const [demoEnabled, setDemoEnabled] = useState(false);

  useEffect(() => {
    void get<{ map: { tileUrl: string; attribution: string }; demo: { enabled: boolean } }>(
      '/config/client',
    )
      .then((c) => {
        setTileConfig(c.map);
        setDemoEnabled(c.demo.enabled);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (session) startRealtime();
  }, [session]);
  useEffect(() => onRealtimeStatus(setRt), []);

  if (!session) return <LoginPage />;
  if (families.length === 0 && !session.user.isSystemAdmin) return <OnboardingPage />;

  const isParent = family?.role === 'PARENT';
  const logout = async () => {
    await post('/auth/logout').catch(() => undefined);
    setSession(null);
  };
  return (
    <div className="shell">
      <nav className="side" aria-label="main">
        <div className="logo">SafeDrive</div>
        <div className="tag">{tr('app.tagline')}</div>
        {families.length > 1 && (
          <select
            value={family?.id}
            onChange={(e) => selectFamily(e.target.value)}
            aria-label="family"
          >
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
        {isParent && <NavLink to="/live">{tr('nav.live')}</NavLink>}
        {family && <NavLink to="/drivers">{tr('nav.drivers')}</NavLink>}
        <NavLink to="/notifications">{tr('nav.notifications')}</NavLink>
        {isParent && <NavLink to="/sos">{tr('nav.sos')}</NavLink>}
        {family && <NavLink to="/family">{tr('nav.family')}</NavLink>}
        {demoEnabled && <NavLink to="/demo">{tr('nav.demo')}</NavLink>}
        {session.user.isSystemAdmin && <NavLink to="/admin">{tr('nav.admin')}</NavLink>}
        <div className="spacer" />
        <div className="small" style={{ padding: '6px 12px' }}>
          <span className={`dot ${rt === 'online' ? 'online' : 'offline'}`} />{' '}
          {tr(rt === 'online' ? 'common.realtime.online' : 'common.realtime.offline')}
        </div>
        <button
          className="navbtn"
          onClick={() => {
            setLang(getLang() === 'he' ? 'en' : 'he');
            force((n) => n + 1);
          }}
        >
          {getLang() === 'he' ? 'English' : 'עברית'}
        </button>
        <button className="navbtn" onClick={() => void logout()}>
          {tr('nav.logout')} · {session.user.displayName}
        </button>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/live" element={<LivePage />} />
          <Route path="/drivers" element={<DriversPage />} />
          <Route path="/trips/:id" element={<TripPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/sos" element={<SosPage />} />
          <Route path="/family" element={<FamilyPage />} />
          <Route path="/demo" element={<DemoPage />} />
          <Route path="/admin/*" element={<AdminPage />} />
          <Route
            path="*"
            element={<Navigate to={isParent ? '/live' : family ? '/drivers' : '/admin'} replace />}
          />
        </Routes>
      </main>
      <Toasts />
    </div>
  );
}
