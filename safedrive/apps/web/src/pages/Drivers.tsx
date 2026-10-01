import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { fmtTime, tr } from '../lib/i18n';
import { useApp } from '../lib/state';
import { DemoFlag, ErrorBox, dur, kmh } from '../components/ui';

interface DriverLite {
  id: string;
  displayName: string;
  safetyScore: number | null;
}
interface TripRow {
  id: string;
  isDemo: boolean;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  distanceM: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  speedingCount: number;
  criticalCount: number;
  score: number;
  state: string;
}

export function DriversPage() {
  const { family } = useApp();
  const nav = useNavigate();
  const [drivers, setDrivers] = useState<DriverLite[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trips, setTrips] = useState<TripRow[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!family) return;
    if (family.role === 'PARENT') {
      void get<DriverLite[]>(`/families/${family.id}/drivers`)
        .then((d) => {
          setDrivers(d);
          setSelected((s) => s ?? d[0]?.id ?? null);
        })
        .catch(setError);
    } else if (family.driverId) {
      void get<DriverLite>(`/drivers/${family.driverId}`).then((d) => {
        setDrivers([d]);
        setSelected(d.id);
      });
    }
  }, [family]);

  useEffect(() => {
    if (selected)
      void get<TripRow[]>(`/drivers/${selected}/trips?limit=100`).then(setTrips).catch(setError);
  }, [selected]);

  const current = drivers.find((d) => d.id === selected);
  return (
    <>
      <div className="top">
        <h1>{tr('nav.drivers')}</h1>
        <div className="row">
          {drivers.map((d) => (
            <button
              key={d.id}
              className={`btn ${d.id === selected ? '' : 'secondary'}`}
              onClick={() => setSelected(d.id)}
            >
              {d.displayName}
            </button>
          ))}
        </div>
      </div>
      <ErrorBox error={error} />
      {current && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="spread">
            <div>
              <div className="muted small">{tr('score.title')}</div>
              <div className="score">{current.safetyScore ?? '—'}</div>
              <div className="small muted">
                {document.documentElement.lang === 'he'
                  ? 'ממוצע משוקלל לפי מרחק של 20 הנסיעות האחרונות (ללא הדגמות). מדד מוצר בלבד, לא מדד מדעי או משפטי.'
                  : 'Distance-weighted average of the last 20 trips (demo excluded). A product indicator, not a scientific or legal measure.'}
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="card">
        {trips.length === 0 ? (
          <div className="muted">{tr('drivers.noTrips')}</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{tr('trip.date')}</th>
                <th>{tr('trip.duration')}</th>
                <th>{tr('trip.distance')}</th>
                <th>{tr('trip.avg')}</th>
                <th>{tr('trip.max')}</th>
                <th>{tr('trip.speeding')}</th>
                <th>{tr('trip.critical')}</th>
                <th>{tr('trip.score')}</th>
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => (
                <tr key={t.id} className="click" onClick={() => nav(`/trips/${t.id}`)}>
                  <td>
                    {fmtTime(t.startedAt)} <DemoFlag show={t.isDemo} />{' '}
                    {!t.endedAt && <span className="badge sev-SAFE">LIVE</span>}
                  </td>
                  <td>{dur(t.durationSec)}</td>
                  <td>
                    {(t.distanceM / 1000).toFixed(1)} {tr('common.km')}
                  </td>
                  <td>
                    {t.avgSpeedKmh} {kmh()}
                  </td>
                  <td>
                    {t.maxSpeedKmh} {kmh()}
                  </td>
                  <td>{t.speedingCount}</td>
                  <td>
                    {t.criticalCount ? (
                      <span className="badge sev-CRITICAL">{t.criticalCount}</span>
                    ) : (
                      0
                    )}
                  </td>
                  <td>
                    <strong>{t.score}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
