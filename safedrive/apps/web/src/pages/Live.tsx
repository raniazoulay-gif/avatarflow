import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type LiveTripView } from '@safedrive/core';
import { get, post } from '../lib/api';
import { fmtAgo, tr } from '../lib/i18n';
import { subscribe } from '../lib/realtime';
import { useApp } from '../lib/state';
import { MapView, SEVERITY_COLORS } from '../components/MapView';
import { DemoFlag, ErrorBox, Metric, SeverityBadge, dur, kmh } from '../components/ui';

interface DriverRow {
  id: string;
  displayName: string;
  safetyScore: number | null;
  activeTripId: string | null;
  lastTripAt: string | null;
  lastMonitoringRequest: { id: string; status: string; createdAt: string } | null;
  devices: Array<{ platform: string; pushReady: boolean; lastSeenAt: string | null }> | null;
}

const MONITORING_LABELS: Record<string, { he: string; en: string }> = {
  REQUESTED: { he: 'נשלחה בקשה', en: 'Requested' },
  PENDING: { he: 'ממתין למכשיר', en: 'Pending' },
  ACTIVE: { he: 'פעיל', en: 'Active' },
  DECLINED: { he: 'נדחה', en: 'Declined' },
  UNAVAILABLE: { he: 'לא זמין (אין מכשיר רשום)', en: 'Unavailable (no device)' },
  PERMISSION_REQUIRED: { he: 'נדרשת הרשאת מיקום', en: 'Permission required' },
  EXPIRED: { he: 'פג תוקף', en: 'Expired' },
  CANCELLED: { he: 'בוטל', en: 'Cancelled' },
  COMPLETED: { he: 'הסתיים', en: 'Completed' },
};

export function LivePage() {
  const { family } = useApp();
  const [trips, setTrips] = useState<LiveTripView[]>([]);
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [, tick] = useState(0);

  const load = async () => {
    if (!family) return;
    try {
      const [l, d] = await Promise.all([
        get<LiveTripView[]>(`/families/${family.id}/live`),
        get<DriverRow[]>(`/families/${family.id}/drivers`),
      ]);
      setTrips(l);
      setDrivers(d);
    } catch (e) {
      setError(e);
    }
  };

  useEffect(() => {
    void load();
    const off = subscribe((m) => {
      if (m.type === 'trip.update' || m.type === 'trip.started') {
        const v = m.data as LiveTripView;
        setTrips((xs) =>
          [...xs.filter((x) => x.tripId !== v.tripId), v].sort((a, b) =>
            a.startedAt.localeCompare(b.startedAt),
          ),
        );
      } else if (m.type === 'trip.ended') {
        setTrips((xs) => xs.filter((x) => x.tripId !== (m.data as LiveTripView).tripId));
        void load();
      } else if (m.type === 'monitoring.status' || m.type === 'sos') {
        void load();
      }
    });
    const t = setInterval(() => tick((n) => n + 1), 1000); // refresh "x seconds ago"
    return () => {
      off();
      clearInterval(t);
    };
  }, [family?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const markers = useMemo(
    () =>
      trips
        .filter((t) => t.location)
        .map((t) => ({
          id: t.tripId,
          lat: t.location!.lat,
          lon: t.location!.lon,
          label: `${t.driverName} · ${t.speedKmh ?? '—'} ${kmh()}`,
          color: SEVERITY_COLORS[t.severity] ?? '#15803d',
        })),
    [trips],
  );

  const request = async (driverId: string) => {
    try {
      await post(`/drivers/${driverId}/monitoring-requests`);
      await load();
    } catch (e) {
      setError(e);
    }
  };
  const lang = document.documentElement.lang === 'en' ? 'en' : 'he';

  return (
    <>
      <div className="top">
        <h1>{tr('nav.live')}</h1>
        <span className="muted small">{family?.name}</span>
      </div>
      <ErrorBox error={error} />
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)', gap: 16 }}>
        <MapView markers={markers} />
        {trips.length === 0 && <div className="card muted">{tr('live.none')}</div>}
        <div className="grid cols-2">
          {trips.map((t) => (
            <div key={t.tripId} className={`card live-card ${t.severity}`}>
              <div className="spread">
                <div className="row">
                  <strong style={{ fontSize: 18 }}>{t.driverName}</strong>
                  <SeverityBadge
                    severity={
                      t.limitKmh === null && t.state === 'SPEED_LIMIT_UNAVAILABLE'
                        ? 'LIMIT_UNAVAILABLE'
                        : t.severity
                    }
                    confirming={t.confirming}
                  />
                  <DemoFlag show={t.isDemo} />
                </div>
                <span className="small">
                  <span className={`dot ${t.connection}`} /> {tr(`live.connection.${t.connection}`)}
                </span>
              </div>
              <div className="grid cols-4" style={{ marginTop: 14 }}>
                <Metric label={tr('speed.current')} value={t.speedKmh ?? '—'} unit={kmh()} />
                <Metric
                  label={tr('speed.limit')}
                  value={t.limitKmh ?? '—'}
                  unit={t.limitKmh ? kmh() : undefined}
                />
                <Metric
                  label={tr('speed.excess')}
                  value={t.excessKmh > 0 ? `+${Math.round(t.excessKmh)}` : '0'}
                  unit={t.excessKmh > 0 ? `${kmh()} · +${Math.round(t.excessPct)}%` : undefined}
                />
                <Metric label={tr('speed.duration')} value={dur(t.speedingSeconds)} />
              </div>
              <div className="spread small muted" style={{ marginTop: 12 }}>
                <span>
                  {tr('score.title')}: <strong>{t.score}</strong>
                </span>
                <span>
                  {tr('live.lastUpdate')}: {fmtAgo(t.lastUpdateAt)} · {tr('live.accuracy')}:{' '}
                  {t.location?.accuracyM ? `${Math.round(t.location.accuracyM)} m` : '—'}
                </span>
                <Link to={`/trips/${t.tripId}`}>→</Link>
              </div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{tr('nav.drivers')}</h3>
          <table>
            <thead>
              <tr>
                <th></th>
                <th>{tr('score.title')}</th>
                <th>{tr('trip.date')}</th>
                <th>{tr('live.requestMonitoring')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => {
                const st = d.lastMonitoringRequest?.status;
                return (
                  <tr key={d.id}>
                    <td>
                      <strong>{d.displayName}</strong>{' '}
                      {d.activeTripId ? (
                        <span className="badge sev-SAFE">
                          {tr('trip.monitoringActive').split(' - ')[0]}
                        </span>
                      ) : null}
                    </td>
                    <td>{d.safetyScore ?? '—'}</td>
                    <td className="small">{d.lastTripAt ? fmtAgo(d.lastTripAt) : '—'}</td>
                    <td className="small">{st ? (MONITORING_LABELS[st]?.[lang] ?? st) : '—'}</td>
                    <td>
                      {!d.activeTripId && (
                        <button className="btn secondary" onClick={() => void request(d.id)}>
                          {tr('live.requestMonitoring')}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="small muted" style={{ marginBottom: 0 }}>
            {lang === 'he'
              ? 'בקשת ניטור נשלחת למכשיר של הנהג/ת. מערכות ההפעלה לא מאפשרות להפעיל מעקב מיקום מרחוק ללא אישור והרשאה של המשתמש, ולכן הניטור יתחיל רק כשהנהג/ת יאשר/תאשר במכשיר.'
              : 'A monitoring request is sent to the driver’s device. iOS/Android do not allow starting location tracking remotely without the user’s permission, so monitoring starts only when the driver accepts on the device.'}
          </p>
        </div>
      </div>
    </>
  );
}
