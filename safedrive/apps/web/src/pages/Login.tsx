import { useState } from 'react';
import { post, setSession, type Session } from '../lib/api';
import { tr } from '../lib/i18n';

export function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const s =
        mode === 'login'
          ? await post<Session>('/auth/login', { email, password })
          : await post<Session>('/auth/register', {
              email,
              password,
              displayName: name,
              locale: 'he',
            });
      setSession(s);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <form className="card auth" onSubmit={submit}>
        <h1 style={{ margin: '0 0 2px' }}>SafeDrive</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          {tr('app.tagline')}
        </p>
        {mode === 'register' && (
          <div className="field">
            <label htmlFor="name">{tr('auth.name')}</label>
            <input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="email">{tr('auth.email')}</label>
          <input
            id="email"
            className="ltr"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="pw">{tr('auth.password')}</label>
          <input
            id="pw"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="btn" style={{ width: '100%' }} disabled={busy}>
          {tr(mode === 'login' ? 'auth.login' : 'auth.register')}
        </button>
        {error && <div className="err">{error}</div>}
        <p style={{ textAlign: 'center', marginBottom: 0 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              setMode(mode === 'login' ? 'register' : 'login');
            }}
          >
            {tr(mode === 'login' ? 'auth.noAccount' : 'auth.haveAccount')}
          </a>
        </p>
      </form>
    </div>
  );
}
