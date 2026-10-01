import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { fmtTime, tr } from '../lib/i18n';
import { subscribe } from '../lib/realtime';
import { DemoFlag, ErrorBox } from '../components/ui';

interface Note {
  id: string;
  type: string;
  priority: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  tripId: string | null;
  isDemo: boolean;
  data: Record<string, unknown>;
}

const PRIORITY_CLASS: Record<string, string> = {
  critical: 'sev-CRITICAL',
  high: 'sev-WARNING',
  normal: 'sev-ATTENTION',
  low: 'sev-NONE',
};

export function NotificationsPage() {
  const [items, setItems] = useState<Note[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const load = () =>
    get<{ items: Note[]; unread: number }>('/notifications?limit=100')
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
      })
      .catch(setError);
  useEffect(() => {
    void load();
    return subscribe((m) => m.type === 'notification' && void load());
  }, []);
  const he = document.documentElement.lang !== 'en';
  return (
    <>
      <div className="top">
        <h1>
          {tr('nav.notifications')}{' '}
          {unread > 0 && (
            <span className="badge sev-CRITICAL">
              {unread} {tr('common.unread')}
            </span>
          )}
        </h1>
        <button
          className="btn secondary"
          onClick={() => void post('/notifications/read-all').then(load)}
        >
          {tr('common.markAll')}
        </button>
      </div>
      <ErrorBox error={error} />
      <div className="card">
        <table>
          <tbody>
            {items.map((n) => (
              <tr
                key={n.id}
                style={{ fontWeight: n.readAt ? 400 : 700 }}
                onClick={() => !n.readAt && void post(`/notifications/${n.id}/read`).then(load)}
              >
                <td style={{ width: 170 }} className="small">
                  {fmtTime(n.createdAt)}
                </td>
                <td>
                  <span className={`badge ${PRIORITY_CLASS[n.priority] ?? 'sev-NONE'}`}>
                    {n.title}
                  </span>
                </td>
                <td>
                  {n.body} <DemoFlag show={n.isDemo} />
                </td>
                <td>{n.tripId && <Link to={`/trips/${n.tripId}`}>→</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted" style={{ marginBottom: 0 }}>
          {he
            ? 'התראות מוצגות כאן ובזמן אמת. התראות Push נשלחות למכשירים רשומים, אך מערכות ההפעלה לא מבטיחות מסירה או צליל (למשל במצב שקט / ריכוז).'
            : 'Notifications appear here in real time. Push is sent to registered devices, but iOS/Android do not guarantee delivery or sound (e.g. silent / focus modes).'}
        </p>
      </div>
    </>
  );
}
