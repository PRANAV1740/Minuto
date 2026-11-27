'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

import { authClient } from './lib/auth-client.ts';

export function Nav({ user }: { user: { name: string; email: string } | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();

  return (
    <nav className="topbar">
      <Link href="/" className="brand">
        Minuto
      </Link>

      <div className="topbar-right">
        {user === null ? (
          <Link href="/sign-in" className="chip">
            sign in
          </Link>
        ) : (
          <>
            <Link href="/meetings" className="chip">
              meetings
            </Link>
            <span className="chip on" title={user.email}>
              {user.name}
            </span>
            <button
              type="button"
              className="secondary"
              style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
              disabled={busy}
              onClick={() =>
                start(async () => {
                  await authClient.signOut();
                  router.push('/sign-in');
                  router.refresh();
                })
              }
            >
              sign out
            </button>
          </>
        )}
      </div>
    </nav>
  );
}
