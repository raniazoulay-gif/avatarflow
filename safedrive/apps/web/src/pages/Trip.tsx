import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { severityForExcess, computeExcess, DEFAULT_SAFETY_CONFIG } from '@safedrive/core';
import { get } from '../lib/api';
import { fmtTime, tr } from '../lib/i18n';
import { subscribe } from '../lib/realtime';
import { MapView, SEVERITY_COLORS, type RouteSegment } from '../components/MapView';
import { SpeedChart, type ChartPoint } from '../components/SpeedChart';
import { DemoFlag, ErrorBox, Loading, Metric, SeverityBadge, dur, kmh } from '../components/ui';

interface Point extends ChartPoint {
  lat: number;
  lon: number;
  seq: number;
}
interface SpeedingEvent {
  id: string;
  status: string;
  startTime: string;
  endTime: string | null;
  durationSec: number;
  maxSpeedKmh: number;
  speedLimitKmh: number;
  maxExcessKmh: number;
  maxExcessPct: number;
  severity: 'ATTENTION' | 'WARNING' | 'CRITICAL';
  road: string | null;
}
interface TripDetail {
  id: string;
  driverName: string;
  isDemo: boolean;
  state: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  distanceM: number;
  maxSpeedKmh: number;
  avgSpeedKmh: number;
  score: number;
  scoreBreakdown: Record<string, number>;
  counts: Record<string, number>;
  speedingEvents: SpeedingEvent[];
  events: Array<{
    id: string;
    type: string;
    severity: string;
    occurredAt: string;
    data: Record<string, unknown>;
  }>;
}

/** Colours the route by the severity of each stretch (same thresholds as the engine). */
function colouredRoute(points: Point[]): RouteSegment[] {
  const out: RouteSegment[] = [];
  let cur: RouteSegment | undefined;
  for (const p of points) {
    const sev =
      p.speedKmh !== null && p.limitKmh !== null
        ? severityForExcess(
            computeExcess(p.speedKmh, p.limitKmh).excessPct,
            DEFAULT_SAFETY_CONFIG.speeding.thresholds,
          )
        : 'SAFE';
    const color = SEVERITY_COLORS[sev] ?? '#15803d';
    if (!cur || cur.color !== color) {
      const prev: [number, number] | undefined = cur
        ? cur.points[cur.points.length - 1]
        : undefined;
      cur = { color, points: prev ? [prev] : [] };
      out.push(cur);
    }
    cur.points.push([p.lat, p.lon]);
  }
  return out;
}

export function TripPage() {
  const { id } = useParams();
  const [trip, setTrip] = useState<TripDetail | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = async () => {
    try {
      const [t, p] = await Promise.all([
        get<TripDetail>(`/trips/${id}`),
        get<Point[]>(`/trips/${id}/points`),
      ]);
      setTrip(t);
      setPoints(p);
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    void load();
    return subscribe((m) => {
      if (
        (m.type === 'trip.update' || m.type === 'trip.ended' || m.type.startsWith('speeding.')) &&
        m.data?.tripId === id
      )
        void load();
    });
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!playing) return;
    const t = setInterval(
      () => setCursor((c) => (c + 1 < points.length ? c + 1 : (setPlaying(false), c))),
      120,
    );
    return () => clearInterval(t);
  }, [playing, points.length]);

  const route = useMemo(() => colouredRoute(points), [points]);
  if (error) return <ErrorBox error={error} />;
  if (!trip) return <Loading />;
  const cur = points[cursor];
  const he = document.documentElement.lang !== 'en';

  return (
    <>
      <div className="top">
        <h1>
          {trip.driverName} · {fmtTime(trip.startedAt)}
        </h1>
        <div className="row">
          <DemoFlag show={trip.isDemo} />
          <span className="badge sev-NONE">{trip.state}</span>
        </div>
      </div>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="card">
          <Metric label={tr('trip.duration')} value={dur(trip.durationSec)} />
        </div>
        <div className="card">
          <Metric
            label={tr('trip.distance')}
            value={(trip.distanceM / 1000).toFixed(1)}
            unit={tr('common.km')}
          />
        </div>
        <div className="card">
          <Metric label={tr('trip.max')} value={trip.maxSpeedKmh} unit={kmh()} />
        </div>
        <div className="card">
          <Metric label={tr('trip.avg')} value={trip.avgSpeedKmh} unit={kmh()} />
        </div>
      </div>
      <div className="grid cols-2" style={{ marginBottom: 16, alignItems: 'start' }}>
        <MapView route={route} cursor={cur ? [cur.lat, cur.lon] : null} height={420} />
        <div className="card">
          <div className="muted small">{tr('score.title')}</div>
          <div className="score">{trip.score}</div>
          <table>
            <tbody>
              {(['speeding', 'hardBraking', 'hardAcceleration', 'phoneUsage'] as const).map((k) => (
                <tr key={k}>
                  <td>{tr(`score.${k}`)}</td>
                  <td className="ltr" style={{ textAlign: 'end' }}>
                    {trip.scoreBreakdown[k] ?? 0}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>{tr('trip.events')}</h3>
          {trip.speedingEvents.length === 0 && <div className="muted small">—</div>}
          {trip.speedingEvents.map((e) => (
            <div key={e.id} className="card" style={{ padding: 12, marginBottom: 8 }}>
              <div className="spread">
                <strong>{tr('event.speeding')}</strong>
                <SeverityBadge severity={e.severity} />
              </div>
              <div className="small" style={{ lineHeight: 1.8 }}>
                {tr('speed.duration')}: <strong>{dur(e.durationSec)}</strong> · {tr('speed.max')}:{' '}
                <strong>
                  {e.maxSpeedKmh} {kmh()}
                </strong>{' '}
                · {tr('speed.limit')}: {e.speedLimitKmh} {kmh()} · {tr('speed.excess')}:{' '}
                <strong className="ltr">
                  +{e.maxExcessKmh} {kmh()} / +{e.maxExcessPct}%
                </strong>
                {e.road ? ` · ${e.road}` : ''} · {fmtTime(e.startTime)}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="spread">
          <h3 style={{ margin: 0 }}>{tr('trip.speedChart')}</h3>
          <div className="row small">
            <span style={{ color: '#2563eb' }}>━ {tr('speed.current')}</span>
            <span style={{ color: '#dc2626' }}>┅ {tr('speed.limit')}</span>
          </div>
        </div>
        <SpeedChart points={points} cursorIndex={cursor} />
        {points.length > 1 && (
          <div className="row" style={{ marginTop: 8 }}>
            <button
              className="btn secondary"
              onClick={() => setPlaying((p) => !p)}
              aria-label={tr('trip.replay')}
            >
              {playing ? '❚❚' : '▶'} {tr('trip.replay')}
            </button>
            <input
              type="range"
              min={0}
              max={points.length - 1}
              value={cursor}
              onChange={(e) => setCursor(Number(e.target.value))}
              style={{ flex: 1 }}
              aria-label="replay position"
            />
            <span className="small ltr" style={{ minWidth: 190 }}>
              {cur
                ? `${fmtTime(cur.t)} · ${cur.speedKmh ?? '—'} / ${cur.limitKmh ?? '—'} ${kmh()}`
                : ''}
            </span>
          </div>
        )}
        {points.length === 0 && (
          <div className="muted small">
            {he
              ? 'נתוני ה-GPS הגולמיים נמחקו לפי מדיניות שמירת הנתונים, או שאין עדיין נקודות.'
              : 'Raw GPS data was removed by the retention policy, or there are no points yet.'}
          </div>
        )}
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>{tr('trip.timeline')}</h3>
        <table>
          <tbody>
            {trip.events.map((e) => (
              <tr key={e.id}>
                <td className="small" style={{ width: 170 }}>
                  {fmtTime(e.occurredAt)}
                </td>
                <td>
                  {tr(`event.${e.type}`) === `event.${e.type}` ? e.type : tr(`event.${e.type}`)}
                </td>
                <td>
                  {e.severity !== 'SAFE' && <SeverityBadge severity={e.severity as 'ATTENTION'} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
