/**
 * Who is asking, on the server.
 *
 * Every page and action that touches stored data goes through `requireUser`,
 * so there is exactly one place where "signed in" is decided. The store was
 * already scoped by owner before sign-in existed, which is why adding it
 * changed one function rather than every query.
 */

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { auth } from './auth.ts';

export type SessionUser = {
  id: string;
  name: string;
  email: string;
};

export async function currentUser(): Promise<SessionUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) return null;

  return {
    id: session.user.id,
    name: session.user.name ?? session.user.email,
    email: session.user.email,
  };
}

/** For anything that must not be reachable without an account. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (user === null) redirect('/sign-in');
  return user;
}
