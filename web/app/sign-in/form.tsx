'use client';

/**
 * Sign in, or make an account.
 *
 * Google is offered only when it is actually configured — an OAuth client has
 * to be created by hand in Google Cloud Console, and a button that fails on
 * click is worse than no button. Email and password always works, so the app
 * is usable before anyone sets Google up, and for people who would rather not
 * use it.
 */

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { authClient } from '../lib/auth-client.ts';

type Mode = 'in' | 'up';

export function SignInForm({ googleEnabled }: { googleEnabled: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    start(async () => {
      const result =
        mode === 'in'
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name: name.trim() || email });

      if (result.error) {
        setError(result.error.message ?? 'that did not work');
        return;
      }

      router.push('/meetings');
      router.refresh();
    });
  };

  return (
    <section className="card">
      {googleEnabled && (
        <>
          <button
            type="button"
            className="secondary"
            style={{ width: '100%' }}
            disabled={busy}
            onClick={() =>
              void authClient.signIn.social({ provider: 'google', callbackURL: '/meetings' })
            }
          >
            Continue with Google
          </button>
          <p className="hint" style={{ textAlign: 'center', margin: '0.9rem 0' }}>
            or with an email address
          </p>
        </>
      )}

      <form onSubmit={submit}>
        {mode === 'up' && (
          <div className="field">
            <label htmlFor="name">Name</label>
            <input
              id="name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="text"
            inputMode="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
            required
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {mode === 'up' && <p className="hint">At least 8 characters.</p>}
        </div>

        {error !== null && <div className="notice bad">{error}</div>}

        <button type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Working…' : mode === 'in' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <p className="hint" style={{ textAlign: 'center', marginTop: '1rem' }}>
        {mode === 'in' ? 'No account yet? ' : 'Already have an account? '}
        <button
          type="button"
          className="secondary"
          style={{ padding: '0.1rem 0.4rem', fontSize: '0.8rem' }}
          onClick={() => {
            setMode(mode === 'in' ? 'up' : 'in');
            setError(null);
          }}
        >
          {mode === 'in' ? 'Create one' : 'Sign in'}
        </button>
      </p>
    </section>
  );
}
