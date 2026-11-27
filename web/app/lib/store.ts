/**
 * The app's one storage connection.
 *
 * Postgres when DATABASE_URL is set, memory otherwise — so a fresh clone runs
 * with nothing installed, and says plainly that nothing is being saved rather
 * than quietly losing work.
 *
 * Created lazily and cached. Building the connection at module scope would run
 * it during `next build`, before any environment exists.
 */

import { createMemoryStore } from '../../../src/store/memory.ts';
import { createPostgresStore } from '../../../src/store/postgres.ts';
import { describeStore } from '../../../src/store/patch.ts';
import type { MinutoStore } from '../../../src/store/types.ts';

/** Safe to show: it never contains the password. */
export const storeChoice = describeStore(process.env);

let pending: Promise<MinutoStore> | null = null;

export function getStore(): Promise<MinutoStore> {
  pending ??=
    storeChoice.kind === 'postgres'
      ? createPostgresStore({
          connectionString: storeChoice.connectionString,
          ssl: storeChoice.ssl,
          migrate: true,
        })
      : Promise.resolve(createMemoryStore());

  return pending;
}

// Ownership now comes from the signed-in user — see ./session.ts.
