import { useEffect, useState } from 'react';
import { get, post } from '../lib/api';
import { fmtTime, tr } from '../lib/i18n';
import { subscribe } from '../lib/realtime';
import { useApp } from '../lib/state';
import { MapView } from '../components/MapView';
import { DemoFlag, ErrorBox } from '../components/ui';

interface Sos {
  id: string;
  driverName: string;
  tripId: string | null;
  lat: number | null;
  lon: number | null;
  speedKmh: number | null;
  triggeredAt: string;
  status: string;
  isDemo: boolean;
}

export function SosPage() {
  const { family } = useApp();
  const [items, setItems] = useState<Sos[]>([]);
  const [numbers, setNumbers] = useState<Array<{ number: string; labelKey: string }>>([]);
  const [error, setError] = useState<unknown>(null);
  const load = () =>
    family && get<Sos[]>(`/families/${family.id}/sos`).then(setItems).catch(setError);
  useEffect(() => {
    void load();
    if (family)
      void get<{ emergencyNumbers: Array<{ number: string; labelKey: string }> }>(
        `/families/${family.id}`,
      ).then((f) => setNumbers(f.emergencyNumbers));
    return subscribe((m) => (m.type === 'sos' || m.type === 'sos.status') && void load());
  }, [family?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = items.filter((s) => s.status !== 'RESOLVED');
  return (
    <>
      <div className="top">
        <h1>SOS</h1>
        <div className="row">
          {numbers.map((n) => (
            <a key={n.number} className="btn danger" href={`tel:${n.number}`}>
              {tr(n.labelKey)} {n.number}
            </a>
          ))}
        </div>
      </div>
      <ErrorBox error={error} />
      {open.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <MapView
            markers={open
              .filter((s) => s.lat !== null)
              .map((s) => ({
                id: s.id,
                lat: s.lat!,
                lon: s.lon!,
                label: `SOS · ${s.driverName}`,
                color: '#dc2626',
              }))}
            height={320}
          />
        </div>
      )}
      <div className="card">
        <table>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td className="small">{fmtTime(s.triggeredAt)}</td>
                <td>
                  <strong>{s.driverName}</strong> <DemoFlag show={s.isDemo} />
                </td>
                <td className="small ltr">
                  {s.lat !== null ? `${s.lat.toFixed(5)}, ${s.lon?.toFixed(5)}` : '—'}
                </td>
                <td className="small">
                  {s.speedKmh ?? '—'} {tr('unit.kmh')}
                </td>
                <td>
                  <span
                    className={`badge ${s.status === 'OPEN' ? 'sev-CRITICAL' : s.status === 'ACKNOWLEDGED' ? 'sev-ATTENTION' : 'sev-SAFE'}`}
                  >
                    {s.status}
                  </span>
                </td>
                <td className="row">
                  {s.status === 'OPEN' && (
                    <button
                      className="btn"
                      onClick={() => void post(`/sos/${s.id}/ack`).then(load)}
                    >
                      {tr('sos.ack')}
                    </button>
                  )}
                  {s.status !== 'RESOLVED' && (
                    <button
                      className="btn secondary"
                      onClick={() => void post(`/sos/${s.id}/resolve`).then(load)}
                    >
                      {tr('sos.resolve')}
                    </button>
                  )}
                  {s.lat !== null && (
                    <a
                      className="btn secondary"
                      target="_blank"
                      rel="noreferrer"
                      href={`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=17/${s.lat}/${s.lon}`}
                    >
                      🗺
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
