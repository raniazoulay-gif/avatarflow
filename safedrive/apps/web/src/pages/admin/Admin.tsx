import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { type LiveTripView } from '@safedrive/core';
import { get, post, put } from '../../lib/api';
import { fmtAgo, fmtTime, tr } from '../../lib/i18n';
import { subscribe } from '../../lib/realtime';
import { MapView, SEVERITY_COLORS } from '../../components/MapView';
import { DemoFlag, ErrorBox, Loading, Metric, SeverityBadge } from '../../components/ui';

const he = () => document.documentElement.lang !== 'en';

/* eslint-disable @typescript-eslint/no-explicit-any */
function useLoad<T>(
  path: string | null,
  deps: unknown[] = [],
): { data: T | null; error: unknown; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (path) void get<T>(path).then(setData).catch(setError);
  }, [path, n, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: () => setN((x) => x + 1) };
}

function Health() {
  const { data, error, reload } = useLoad<any>('/admin/health');
  useEffect(() => {
    const t = setInterval(reload, 10_000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const ok = (b: boolean) => (
    <span className={`badge ${b ? 'sev-SAFE' : 'sev-CRITICAL'}`}>{b ? 'OK' : 'DOWN'}</span>
  );
  const t = data.metrics.timings;
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid cols-4">
        <div className="card">
          <Metric label="API" value={ok(data.status === 'ok')} />
        </div>
        <div className="card">
          <Metric
            label={he() ? 'מסד נתונים' : 'Database'}
            value={ok(data.database.ok)}
            unit={`${data.database.latencyMs} ms`}
          />
        </div>
        <div className="card">
          <Metric label={he() ? 'נסיעות פעילות' : 'Active trips'} value={data.activeTrips} />
        </div>
        <div className="card">
          <Metric
            label="WebSocket"
            value={data.realtime.websocketConnections}
            unit={data.realtime.bus}
          />
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{he() ? 'תור התראות' : 'Notification queue'}</h3>
          <table>
            <tbody>
              <tr>
                <td>Provider</td>
                <td>{data.notificationQueue.provider}</td>
              </tr>
              <tr>
                <td>Pending</td>
                <td>{data.notificationQueue.pending}</td>
              </tr>
              <tr>
                <td>Failed (24h)</td>
                <td>{data.notificationQueue.failedLast24h}</td>
              </tr>
              <tr>
                <td>{he() ? 'אחוז הצלחה' : 'Success rate'}</td>
                <td>{data.notificationQueue.successRate ?? '—'}%</td>
              </tr>
              <tr>
                <td>Oldest pending</td>
                <td>
                  {data.notificationQueue.oldestPendingAt
                    ? fmtAgo(data.notificationQueue.oldestPendingAt)
                    : '—'}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{he() ? 'ספקים חיצוניים' : 'External providers'}</h3>
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>{he() ? 'מוגדר' : 'Configured'}</th>
                <th>Calls</th>
                <th>Errors</th>
                <th>Avg ms</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {data.providers.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>{ok(p.available)}</td>
                  <td>{p.calls}</td>
                  <td>{p.errors}</td>
                  <td>{p.avgLatencyMs}</td>
                  <td className="small">{p.lastError ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{he() ? 'ביצועים' : 'Performance'}</h3>
          <table>
            <tbody>
              {Object.entries(t).map(([k, v]: [string, any]) => (
                <tr key={k}>
                  <td className="small">{k}</td>
                  <td>{v.count}</td>
                  <td>avg {v.avgMs} ms</td>
                  <td>max {v.maxMs} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{he() ? 'מונים' : 'Counters'}</h3>
          <table>
            <tbody>
              {Object.entries(data.metrics.counters).map(([k, v]) => (
                <tr key={k}>
                  <td className="small">{k}</td>
                  <td>{String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="small muted">uptime {data.metrics.uptimeSec}s</div>
        </div>
      </div>
    </div>
  );
}

function Users() {
  const [q, setQ] = useState('');
  const { data, error, reload } = useLoad<any[]>(`/admin/users?q=${encodeURIComponent(q)}`);
  const nav = useNavigate();
  return (
    <div className="card">
      <ErrorBox error={error} />
      <input
        placeholder={he() ? 'חיפוש לפי אימייל או שם' : 'Search email or name'}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{
          padding: 10,
          border: '1px solid var(--line)',
          borderRadius: 10,
          width: 320,
          marginBottom: 12,
        }}
      />
      <table>
        <thead>
          <tr>
            <th>Email</th>
            <th>{tr('auth.name')}</th>
            <th>Status</th>
            <th>Families</th>
            <th>Last login</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((u) => (
            <tr key={u.id} className="click" onClick={() => nav(`/admin/users/${u.id}`)}>
              <td className="ltr">{u.email}</td>
              <td>
                {u.displayName} {u.isSystemAdmin && <span className="badge sev-NONE">admin</span>}
              </td>
              <td>
                <span className={`badge ${u.status === 'active' ? 'sev-SAFE' : 'sev-CRITICAL'}`}>
                  {u.status}
                </span>
              </td>
              <td>{u.families}</td>
              <td className="small">{u.lastLoginAt ? fmtTime(u.lastLoginAt) : '—'}</td>
              <td onClick={(e) => e.stopPropagation()}>
                {!u.isSystemAdmin && (
                  <button
                    className="btn secondary"
                    onClick={() =>
                      void post(
                        `/admin/users/${u.id}/${u.status === 'active' ? 'suspend' : 'unsuspend'}`,
                      ).then(reload)
                    }
                  >
                    {u.status === 'active'
                      ? he()
                        ? 'השעיה'
                        : 'Suspend'
                      : he()
                        ? 'ביטול השעיה'
                        : 'Unsuspend'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UserDetail() {
  const { id } = useParams();
  const { data, error } = useLoad<any>(`/admin/users/${id}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{data.displayName}</h3>
        <div className="ltr">{data.email}</div>
        <p className="small">
          Status: {data.status} · Sessions: {data.activeSessions} · Failed logins:{' '}
          {data.failedLogins}
        </p>
        <h4>Families</h4>
        {data.families.map((f: any) => (
          <div key={f.id}>
            {f.name} · {f.role}
          </div>
        ))}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Devices</h3>
        <table>
          <tbody>
            {data.devices.map((d: any) => (
              <tr key={d.id}>
                <td>{d.platform}</td>
                <td>{d.model}</td>
                <td>{d.appVersion}</td>
                <td>{d.pushReady ? 'push ✓' : 'no push'}</td>
                <td className="small">{d.lastSeenAt ? fmtAgo(d.lastSeenAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Families() {
  const { data, error } = useLoad<any[]>('/admin/families');
  const nav = useNavigate();
  return (
    <div className="card">
      <ErrorBox error={error} />
      <table>
        <thead>
          <tr>
            <th>{tr('family.name')}</th>
            <th>Members</th>
            <th>Drivers</th>
            <th>Trips</th>
            <th>Active</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((f) => (
            <tr key={f.id} className="click" onClick={() => nav(`/admin/families/${f.id}`)}>
              <td>
                {f.name} <DemoFlag show={f.isDemo} />
              </td>
              <td>{f.members}</td>
              <td>{f.drivers}</td>
              <td>{f.trips}</td>
              <td>{f.activeTrips}</td>
              <td className="small">{fmtTime(f.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FamilyDetail() {
  const { id } = useParams();
  const { data, error } = useLoad<any>(`/admin/families/${id}`);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="grid cols-2">
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{data.name}</h3>
        {data.members.map((m: any) => (
          <div key={m.id}>
            {m.displayName} · {m.role}
          </div>
        ))}
        <h4>Devices</h4>
        {data.devices.map((d: any) => (
          <div key={d.id} className="small">
            {d.owner} · {d.platform} {d.model ?? ''} · {d.pushReady ? 'push ✓' : 'no push'}
          </div>
        ))}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Trips</h3>
        <table>
          <tbody>
            {data.trips.map((t: any) => (
              <tr key={t.id}>
                <td className="small">{fmtTime(t.startedAt)}</td>
                <td>{t.driverName}</td>
                <td>{t.state}</td>
                <td>{(t.distanceM / 1000).toFixed(1)} km</td>
                <td>{t.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActiveTrips() {
  const { data, error, reload } =
    useLoad<Array<LiveTripView & { familyName: string }>>('/admin/trips/active');
  useEffect(() => {
    const t = setInterval(reload, 5000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const trips = data ?? [];
  return (
    <div className="grid" style={{ gap: 16 }}>
      <ErrorBox error={error} />
      <MapView
        markers={trips
          .filter((t) => t.location)
          .map((t) => ({
            id: t.tripId,
            lat: t.location!.lat,
            lon: t.location!.lon,
            label: `${t.driverName} ${t.speedKmh ?? '—'}`,
            color: SEVERITY_COLORS[t.severity] ?? '#15803d',
          }))}
      />
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Family</th>
              <th>Driver</th>
              <th>{tr('speed.current')}</th>
              <th>{tr('speed.limit')}</th>
              <th>Severity</th>
              <th>Connection</th>
            </tr>
          </thead>
          <tbody>
            {trips.map((t) => (
              <tr key={t.tripId}>
                <td>
                  {t.familyName} <DemoFlag show={t.isDemo} />
                </td>
                <td>{t.driverName}</td>
                <td>{t.speedKmh ?? '—'}</td>
                <td>{t.limitKmh ?? '—'}</td>
                <td>
                  <SeverityBadge severity={t.severity} />
                </td>
                <td>
                  <span className={`dot ${t.connection}`} /> {t.connection}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Audit() {
  const [action, setAction] = useState('');
  const { data, error } = useLoad<any[]>(`/admin/audit?action=${encodeURIComponent(action)}`);
  return (
    <div className="card">
      <ErrorBox error={error} />
      <select
        value={action}
        onChange={(e) => setAction(e.target.value)}
        style={{ padding: 10, marginBottom: 12 }}
      >
        {['', 'auth.', 'user.', 'family.', 'monitoring.', 'trip.', 'sos.', 'device.', 'admin.'].map(
          (a) => (
            <option key={a} value={a}>
              {a || 'all'}
            </option>
          ),
        )}
      </select>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Target</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((a) => (
            <tr key={a.id}>
              <td className="small">{fmtTime(a.at)}</td>
              <td>
                <code>{a.action}</code>
              </td>
              <td className="small ltr">{a.actorEmail ?? a.actorId ?? 'system'}</td>
              <td className="small">
                {a.targetType}:{String(a.targetId ?? '').slice(0, 8)}
              </td>
              <td className="small">{a.ip ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Providers() {
  const { data } = useLoad<any[]>('/admin/provider-usage');
  return (
    <div className="card">
      <p className="small muted">
        {he()
          ? 'שימוש בספקים חיצוניים (לניטור עלויות). "cache" = תשובות שנענו מהמטמון בלי קריאה בתשלום.'
          : 'External provider usage (cost monitoring). "cache" = answers served without a paid call.'}
      </p>
      <table>
        <thead>
          <tr>
            <th>Day</th>
            <th>Provider</th>
            <th>Calls</th>
            <th>Errors</th>
            <th>Cache hits</th>
            <th>Avg ms</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((r) => (
            <tr key={`${r.day}-${r.provider}`}>
              <td className="small">{String(r.day).slice(0, 10)}</td>
              <td>{r.provider}</td>
              <td>{r.calls}</td>
              <td>{r.errors}</td>
              <td>{r.cacheHits}</td>
              <td>{r.avgMs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Config() {
  const [scope, setScope] = useState('global');
  const [attention, setA] = useState(10);
  const [warning, setW] = useState(30);
  const [critical, setC] = useState(50);
  const [confirm, setConfirm] = useState(10);
  const [msg, setMsg] = useState('');
  const save = async () => {
    try {
      await put('/admin/config/safety', {
        scope,
        value: {
          speeding: {
            thresholds: { attentionPct: attention, warningPct: warning, criticalPct: critical },
            confirmationSeconds: confirm,
          },
        },
      });
      setMsg('✓');
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const num = (v: number, set: (n: number) => void, label: string) => (
    <div className="field">
      <label>{label}</label>
      <input type="number" value={v} onChange={(e) => set(Number(e.target.value))} />
    </div>
  );
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <div className="field">
        <label>Scope</label>
        <input
          className="ltr"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          placeholder="global | country:IL | family:uuid"
        />
      </div>
      {num(attention, setA, 'ATTENTION %')}
      {num(warning, setW, 'WARNING %')}
      {num(critical, setC, 'CRITICAL %')}
      {num(confirm, setConfirm, he() ? 'שניות אישור רצופות' : 'Confirmation seconds')}
      <button className="btn" onClick={() => void save()}>
        {tr('common.save')}
      </button>{' '}
      <span>{msg}</span>
    </div>
  );
}

export function AdminPage() {
  const [, setTick] = useState(0);
  useEffect(() => subscribe(() => setTick((n) => n + 1)), []);
  const tabs: Array<[string, string]> = [
    ['/admin', he() ? 'בריאות מערכת' : 'Health'],
    ['/admin/trips', he() ? 'נסיעות פעילות' : 'Active trips'],
    ['/admin/users', he() ? 'משתמשים' : 'Users'],
    ['/admin/families', he() ? 'משפחות' : 'Families'],
    ['/admin/audit', he() ? 'יומן ביקורת' : 'Audit log'],
    ['/admin/providers', he() ? 'שימוש בספקים' : 'Provider usage'],
    ['/admin/config', he() ? 'הגדרות בטיחות' : 'Safety config'],
  ];
  return (
    <>
      <div className="top">
        <h1>{tr('nav.admin')}</h1>
      </div>
      <div className="row" style={{ marginBottom: 16 }}>
        {tabs.map(([to, label]) => (
          <NavLink
            key={to}
            to={to}
            end
            className={({ isActive }) => `btn ${isActive ? '' : 'secondary'}`}
          >
            {label}
          </NavLink>
        ))}
      </div>
      <Routes>
        <Route index element={<Health />} />
        <Route path="trips" element={<ActiveTrips />} />
        <Route path="users" element={<Users />} />
        <Route path="users/:id" element={<UserDetail />} />
        <Route path="families" element={<Families />} />
        <Route path="families/:id" element={<FamilyDetail />} />
        <Route path="audit" element={<Audit />} />
        <Route path="providers" element={<Providers />} />
        <Route path="config" element={<Config />} />
      </Routes>
    </>
  );
}
