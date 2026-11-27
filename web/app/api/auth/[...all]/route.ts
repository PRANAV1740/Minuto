/**
 * Every auth endpoint: sign-up, sign-in, sign-out, session, OAuth callbacks.
 * Better Auth routes them all from this one handler.
 */

import { toNextJsHandler } from 'better-auth/next-js';

import { auth } from '../../../lib/auth.ts';

export const { GET, POST } = toNextJsHandler(auth);
