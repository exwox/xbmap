import { useState } from 'react';
import { Icon } from './Icon';
import { login } from '../lib/authApi';

interface LoginGateProps {
  onSuccess: () => void;
}

/**
 * Phase 6 foundation: full-screen credential gate rendered when the gateway
 * reports that authentication is required and no valid session exists.
 */
export function LoginGate({ onSuccess }: LoginGateProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await login(username, password);
      // Full reload guarantees a clean socket/buffer state under the new
      // session cookie; symbol switching stays reload-free during normal use.
      window.location.reload();
      onSuccess();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <span className="brand-mark login-brand"><Icon name="activity" size={20} /></span>
        <strong className="login-title">LiquidMap</strong>
        <small className="login-subtitle">Masuk untuk mengakses terminal</small>

        {error && <p className="login-error">{error}</p>}

        <label className="login-field">
          <span>Username</span>
          <input
            autoComplete="username"
            onChange={(event) => setUsername(event.target.value)}
            required
            type="text"
            value={username}
          />
        </label>
        <label className="login-field">
          <span>Password</span>
          <input
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
            required
            type="password"
            value={password}
          />
        </label>

        <button className="submit-button" disabled={pending} type="submit">
          {pending ? 'Memproses…' : 'Masuk'}
        </button>

        <small className="login-footnote">
          Data publik exchange · Alat bantu analisis, bukan nasihat keuangan.
        </small>
      </form>
    </div>
  );
}