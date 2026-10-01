/** Speed vs speed-limit chart (inline SVG, no chart library). */
import { useMemo } from 'react';

export interface ChartPoint {
  t: number;
  speedKmh: number | null;
  limitKmh: number | null;
}

export function SpeedChart({
  points,
  cursorIndex,
}: {
  points: ChartPoint[];
  cursorIndex?: number;
}) {
  const W = 900;
  const H = 220;
  const pad = 30;
  const data = useMemo(() => {
    if (points.length < 2) return null;
    const t0 = points[0]!.t;
    const t1 = points[points.length - 1]!.t;
    const vmax =
      Math.max(60, ...points.map((p) => Math.max(p.speedKmh ?? 0, p.limitKmh ?? 0))) * 1.1;
    const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad * 2);
    const y = (v: number) => H - pad - (v / vmax) * (H - pad * 2);
    const path = (key: 'speedKmh' | 'limitKmh') => {
      let d = '';
      let pen = false;
      for (const p of points) {
        const v = p[key];
        if (v === null) {
          pen = false;
          continue;
        }
        d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    const ticks = [0, Math.round(vmax / 2 / 10) * 10, Math.round((vmax * 0.9) / 10) * 10];
    return { speed: path('speedKmh'), limit: path('limitKmh'), x, y, ticks };
  }, [points]);
  if (!data) return null;
  const cur = cursorIndex !== undefined ? points[cursorIndex] : undefined;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: 'auto', direction: 'ltr' }}
      role="img"
      aria-label="speed chart"
    >
      {data.ticks.map((v) => (
        <g key={v}>
          <line x1={pad} x2={W - pad} y1={data.y(v)} y2={data.y(v)} stroke="#e2e8f0" />
          <text x={4} y={data.y(v) + 4} fontSize="11" fill="#64748b">
            {v}
          </text>
        </g>
      ))}
      <path d={data.limit} fill="none" stroke="#dc2626" strokeWidth={2} strokeDasharray="6 4" />
      <path d={data.speed} fill="none" stroke="#2563eb" strokeWidth={2.5} />
      {cur && (
        <line
          x1={data.x(cur.t)}
          x2={data.x(cur.t)}
          y1={pad / 2}
          y2={H - pad}
          stroke="#0b1b33"
          strokeWidth={1.5}
        />
      )}
    </svg>
  );
}
