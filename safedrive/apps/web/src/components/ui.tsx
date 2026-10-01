import { type ReactNode } from 'react';
import { formatDuration, type Severity } from '@safedrive/core';
import { tr } from '../lib/i18n';

export function SeverityBadge({
  severity,
  confirming,
}: {
  severity: Severity | 'LIMIT_UNAVAILABLE' | 'NONE';
  confirming?: boolean;
}) {
  if (severity === 'LIMIT_UNAVAILABLE')
    return <span className="badge sev-NONE">{tr('speed.limitUnavailable')}</span>;
  if (severity === 'NONE') return <span className="badge sev-NONE">—</span>;
  return (
    <span className={`badge sev-${severity}`}>
      {tr(`severity.${severity}`)}
      {confirming && severity === 'SAFE' ? ` · ${tr('live.confirming')}` : ''}
    </span>
  );
}

export function DemoFlag({ show }: { show: boolean }) {
  return show ? <span className="badge demo-flag">{tr('demo.badge')}</span> : null;
}

export function Metric({ label, value, unit }: { label: string; value: ReactNode; unit?: string }) {
  return (
    <div className="metric">
      <span className="l">{label}</span>
      <span className="v">
        {value}
        {unit ? (
          <span style={{ fontSize: 14, fontWeight: 600, marginInlineStart: 4 }}>{unit}</span>
        ) : null}
      </span>
    </div>
  );
}

export const kmh = () => tr('unit.kmh');
export const dur = (sec: number | null | undefined) =>
  sec === null || sec === undefined ? '—' : formatDuration(sec);

export function Loading() {
  return <div className="muted">{tr('common.loading')}</div>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice bad">{error instanceof Error ? error.message : String(error)}</div>;
}
