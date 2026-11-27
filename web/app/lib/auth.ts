/**
 * Sign-in, with accounts in Minuto's own database.
 *
 * Better Auth rather than a hosted provider, for the reason the architecture
 * gives (docs/ARCHITECTURE.md §7): the product has to cost its users nothing
 * and its author nothing, and a hosted auth vendor is a bill and a dashboard
 * on top of a database that already exists. Users, sessions and accounts live
 * in the same Postgres as the meetings.
 *
 * Google is the sign-in that matters — Minuto reads a Meet calendar eventually,
 * and asking for that later is far easier when Google is already the identity.
 * It is only offered when credentials for it exist, because they can only be
 * created by hand in Google Cloud Console.
 *
 * Email and password is always on, so the app is usable before anyone has set
 * up a Google client, and for people who would rather not use Google at all.
 */

import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { Pool } from 'pg';

const googleId = process.env.GOOGLE_CLIENT_ID?.trim();
const googleSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();

/** Shown in the UI, so the sign-in page offers only what actually works. */
export const googleEnabled = Boolean(googleId && googleSecret);

/**
 * Exported separately from `auth` so the migration script can build the
 * schema from exactly the configuration the app runs with — a migration
 * derived from a second, slightly different config is how tables drift.
 */
export const authOptions = {
  database: new Pool({ connectionString: process.env.DATABASE_URL }),

  emailAndPassword: { enabled: true },

  ...(googleEnabled
    ? {
        socialProviders: {
          google: {
            clientId: googleId!,
            clientSecret: googleSecret!,
            // Calendar is not requested yet: a read-only calendar scope is an
            // extra consent screen, and nothing uses it until meetings are
            // matched to calendar events.
          },
        },
      }
    : {}),

  session: {
    // Signed cookie cache, so most requests skip a database round trip.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  // Must stay last: it is what lets a Server Action set the session cookie.
  plugins: [nextCookies()],
};

export const auth = betterAuth(authOptions);
