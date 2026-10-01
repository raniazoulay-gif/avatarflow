import { useState } from 'react';
import { post } from '../lib/api';
import { tr } from '../lib/i18n';
import { useApp } from '../lib/state';
import { restartRealtime } from '../lib/realtime';

export function OnboardingPage() {
  const { reload } = useApp();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/families', { name });
      await reload();
      restartRealtime();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await post('/invites/accept', { code, consent });
      await reload();
      restartRealtime();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="grid cols-2" style={{ width: 'min(860px, 100%)' }}>
        <form className="card" onSubmit={create}>
          <h2 style={{ marginTop: 0 }}>{tr('family.create')}</h2>
          <div className="field">
            <label htmlFor="fname">{tr('family.name')}</label>
            <input
              id="fname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          </div>
          <button className="btn">{tr('family.create')}</button>
        </form>
        <form className="card" onSubmit={join}>
          <h2 style={{ marginTop: 0 }}>{tr('family.join')}</h2>
          <div className="field">
            <label htmlFor="code">{tr('family.code')}</label>
            <input
              id="code"
              className="ltr"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              required
              maxLength={20}
            />
          </div>
          <div className="notice small">
            <strong>{tr('consent.title')}</strong>
            <p style={{ margin: '6px 0' }}>{tr('consent.text')}</p>
            <label className="row">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />{' '}
              {tr('consent.accept')}
            </label>
          </div>
          <button className="btn" style={{ marginTop: 12 }}>
            {tr('family.join')}
          </button>
        </form>
        {error && <div className="err">{error}</div>}
      </div>
    </div>
  );
}
