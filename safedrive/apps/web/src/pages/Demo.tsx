import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { tr } from '../lib/i18n';
import { restartRealtime } from '../lib/realtime';
import { useApp } from '../lib/state';
import { ErrorBox } from '../components/ui';

interface Scenario {
  id: string;
  name: string;
  description: string;
}
interface Run {
  id: string;
  tripId: string;
  scenarioId: string;
  status: string;
  progress: number;
  error?: string;
}

export function DemoPage() {
  const { families, reload, selectFamily } = useApp();
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [speed, setSpeed] = useState(5);
  const [error, setError] = useState<unknown>(null);
  const demoFamily = families.find((f) => f.isDemo && f.role === 'PARENT');
  const [driverId, setDriverId] = useState<string | null>(null);

  useEffect(() => {
    void get<{ demo: { scenarios: Scenario[] } }>('/config/client').then((c) =>
      setScenarios(c.demo.scenarios),
    );
    const t = setInterval(
      () =>
        void get<Run[]>('/demo/runs')
          .then(setRuns)
          .catch(() => undefined),
      1500,
    );
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (demoFamily)
      void get<Array<{ id: string }>>(`/families/${demoFamily.id}/drivers`).then((d) =>
        setDriverId(d[0]?.id ?? null),
      );
  }, [demoFamily?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const createFamily = async () => {
    try {
      const r = await post<{ familyId: string; driverId: string }>('/demo/families');
      await reload();
      selectFamily(r.familyId);
      setDriverId(r.driverId);
      restartRealtime();
    } catch (e) {
      setError(e);
    }
  };
  const run = async (scenarioId: string) => {
    try {
      if (demoFamily) selectFamily(demoFamily.id);
      await post('/demo/runs', { driverId, scenarioId, speedFactor: speed });
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <div className="top">
        <h1>{tr('demo.title')}</h1>
        <span className="badge demo-flag">{tr('demo.badge')}</span>
      </div>
      <div className="notice" style={{ marginBottom: 16 }}>
        {tr('demo.intro')}
      </div>
      <ErrorBox error={error} />
      {!demoFamily ? (
        <button className="btn" onClick={() => void createFamily()}>
          {tr('demo.createFamily')}
        </button>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 16 }}>
            <label className="small">{tr('demo.speed')}</label>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {[1, 2, 5, 10, 20].map((s) => (
                <option key={s} value={s}>
                  x{s}
                </option>
              ))}
            </select>
            <Link to="/live">{tr('nav.live')} →</Link>
          </div>
          <div className="grid cols-2">
            {scenarios.map((s) => (
              <div key={s.id} className="card">
                <div className="spread">
                  <strong>{s.name}</strong>
                  <button className="btn" disabled={!driverId} onClick={() => void run(s.id)}>
                    {tr('demo.run')}
                  </button>
                </div>
                <p className="small muted">{s.description}</p>
              </div>
            ))}
          </div>
          <div className="card" style={{ marginTop: 16 }}>
            <table>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.scenarioId}</td>
                    <td>
                      {r.status} {r.error ?? ''}
                    </td>
                    <td style={{ width: 200 }}>
                      <div style={{ background: '#e2e8f0', borderRadius: 6, height: 8 }}>
                        <div
                          style={{
                            width: `${r.progress}%`,
                            background: 'var(--brand)',
                            height: 8,
                            borderRadius: 6,
                          }}
                        />
                      </div>
                    </td>
                    <td>
                      <Link to={`/trips/${r.tripId}`}>→</Link>
                    </td>
                    <td>
                      {r.status === 'running' && (
                        <button
                          className="btn secondary"
                          onClick={() => void post(`/demo/runs/${r.id}/cancel`)}
                        >
                          ✕
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
