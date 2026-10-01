import { useEffect, useState } from 'react';
import { del, get, post, put } from '../lib/api';
import { tr } from '../lib/i18n';
import { useApp } from '../lib/state';
import { ErrorBox } from '../components/ui';

interface Member {
  id: string;
  role: string;
  displayName: string;
  driverId: string | null;
  safetyScore: number | null;
}
interface Contact {
  id: string;
  name: string;
  phone: string;
  relation: string | null;
}
interface Prefs {
  disabledTypes: string[];
  minSpeedingSeverity: string;
  soundFromSeverity: string;
  cooldownSeconds: number;
}

const OPTIONAL_TYPES = [
  'TRIP_STARTED',
  'TRIP_ENDED',
  'SPEEDING_ENDED',
  'HARD_BRAKING',
  'HARD_ACCELERATION',
  'DRIVER_OFFLINE',
  'GPS_UNAVAILABLE',
];

export function FamilyPage() {
  const { family } = useApp();
  const [members, setMembers] = useState<Member[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [invite, setInvite] = useState<{ code: string; role: string; displayName: string } | null>(
    null,
  );
  const [inviteName, setInviteName] = useState('');
  const [contact, setContact] = useState({ name: '', phone: '', relation: '' });
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  const isParent = family?.role === 'PARENT';

  const load = async () => {
    if (!family) return;
    try {
      const f = await get<{ members: Member[] }>(`/families/${family.id}`);
      setMembers(f.members);
      setContacts(await get<Contact[]>(`/families/${family.id}/emergency-contacts`));
      setPrefs(await get<Prefs>(`/families/${family.id}/notification-preferences`));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    void load();
  }, [family?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!family) return null;

  const createInvite = async (role: 'DRIVER' | 'PARENT') => {
    try {
      setInvite(
        await post(`/families/${family.id}/invites`, {
          role,
          displayName: inviteName || (role === 'DRIVER' ? 'Driver' : 'Parent'),
        }),
      );
      setInviteName('');
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <div className="top">
        <h1>{family.name}</h1>
      </div>
      <ErrorBox error={error} />
      <div className="grid cols-2">
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{tr('family.members')}</h3>
          <table>
            <tbody>
              {members.map((m) => (
                <tr key={m.id}>
                  <td>
                    <strong>{m.displayName}</strong>
                  </td>
                  <td>
                    {m.role === 'PARENT'
                      ? document.documentElement.lang === 'en'
                        ? 'Administrator'
                        : 'מנהל/ת'
                      : document.documentElement.lang === 'en'
                        ? 'Driver'
                        : 'נהג/ת'}
                  </td>
                  <td>{m.safetyScore ?? ''}</td>
                  <td>
                    {isParent && (
                      <button
                        className="btn secondary"
                        onClick={() =>
                          void del(`/families/${family.id}/members/${m.id}`)
                            .then(load)
                            .catch(setError)
                        }
                      >
                        {tr('common.delete')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isParent && (
            <>
              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="iname">{tr('auth.name')}</label>
                <input
                  id="iname"
                  value={inviteName}
                  onChange={(e) => setInviteName(e.target.value)}
                  maxLength={80}
                />
              </div>
              <div className="row">
                <button className="btn" onClick={() => void createInvite('DRIVER')}>
                  {tr('family.inviteDriver')}
                </button>
                <button className="btn secondary" onClick={() => void createInvite('PARENT')}>
                  {tr('family.inviteParent')}
                </button>
              </div>
              {invite && (
                <div className="notice" style={{ marginTop: 12 }}>
                  {tr('family.inviteCreated')} <strong>{invite.displayName}</strong>
                  <div style={{ marginTop: 8 }}>
                    <span className="code">{invite.code}</span>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        <div className="card">
          <h3 style={{ marginTop: 0 }}>{tr('family.emergency')}</h3>
          <table>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong> <span className="muted small">{c.relation}</span>
                  </td>
                  <td className="ltr">
                    <a href={`tel:${c.phone}`}>{c.phone}</a>
                  </td>
                  <td>
                    {isParent && (
                      <button
                        className="btn secondary"
                        onClick={() =>
                          void del(`/families/${family.id}/emergency-contacts/${c.id}`).then(load)
                        }
                      >
                        {tr('common.delete')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isParent && (
            <form
              className="row"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault();
                void post(`/families/${family.id}/emergency-contacts`, {
                  ...contact,
                  relation: contact.relation || undefined,
                })
                  .then(() => {
                    setContact({ name: '', phone: '', relation: '' });
                    return load();
                  })
                  .catch(setError);
              }}
            >
              <input
                aria-label="name"
                placeholder={tr('auth.name')}
                value={contact.name}
                onChange={(e) => setContact({ ...contact, name: e.target.value })}
                required
                className="field"
                style={{
                  margin: 0,
                  padding: 10,
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                }}
              />
              <input
                aria-label="phone"
                placeholder="050-0000000"
                className="ltr"
                value={contact.phone}
                onChange={(e) => setContact({ ...contact, phone: e.target.value })}
                required
                style={{ padding: 10, border: '1px solid var(--line)', borderRadius: 10 }}
              />
              <button className="btn">{tr('common.add')}</button>
            </form>
          )}
        </div>
        {prefs && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>{tr('family.prefs')}</h3>
            <div className="field">
              <label>
                {document.documentElement.lang === 'en'
                  ? 'Notify about speeding from'
                  : 'התראה על מהירות החל מ'}
              </label>
              <select
                value={prefs.minSpeedingSeverity}
                onChange={(e) => setPrefs({ ...prefs, minSpeedingSeverity: e.target.value })}
              >
                {['ATTENTION', 'WARNING', 'CRITICAL'].map((s) => (
                  <option key={s} value={s}>
                    {tr(`severity.${s}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{document.documentElement.lang === 'en' ? 'Sound from' : 'צליל החל מ'}</label>
              <select
                value={prefs.soundFromSeverity}
                onChange={(e) => setPrefs({ ...prefs, soundFromSeverity: e.target.value })}
              >
                {['ATTENTION', 'WARNING', 'CRITICAL'].map((s) => (
                  <option key={s} value={s}>
                    {tr(`severity.${s}`)}
                  </option>
                ))}
              </select>
            </div>
            {OPTIONAL_TYPES.map((tp) => (
              <label key={tp} className="row small" style={{ marginBottom: 6 }}>
                <input
                  type="checkbox"
                  checked={!prefs.disabledTypes.includes(tp)}
                  onChange={(e) =>
                    setPrefs({
                      ...prefs,
                      disabledTypes: e.target.checked
                        ? prefs.disabledTypes.filter((x) => x !== tp)
                        : [...prefs.disabledTypes, tp],
                    })
                  }
                />
                {tp}
              </label>
            ))}
            <p className="small muted">
              {document.documentElement.lang === 'en'
                ? 'SOS alerts can never be turned off.'
                : 'התראות SOS לא ניתנות לכיבוי.'}
            </p>
            <button
              className="btn"
              onClick={() =>
                void put(`/families/${family.id}/notification-preferences`, prefs)
                  .then(() => setSaved(true))
                  .catch(setError)
              }
            >
              {tr('common.save')}
            </button>
            {saved && <span className="small muted"> ✓</span>}
          </div>
        )}
      </div>
    </>
  );
}
