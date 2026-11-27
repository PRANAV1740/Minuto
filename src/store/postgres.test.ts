/**
 * Runs the storage contract against a real Postgres.
 *
 * Skipped unless MINUTO_TEST_DATABASE_URL is set, so the suite stays runnable
 * on a machine with no database. A separate variable from DATABASE_URL on
 * purpose: these tests wipe every table between cases, and pointing them at a
 * development database by accident should not be possible.
 *
 *   $env:MINUTO_TEST_DATABASE_URL = "postgresql://postgres:pw@localhost:5432/minuto_test"
 *   npm test
 */

import { test } from 'node:test';

import { testStoreContract } from './contract.ts';
import { createPostgresStore } from './postgres.ts';

const url = process.env.MINUTO_TEST_DATABASE_URL;

if (url === undefined || url.trim() === '') {
  test('postgres: skipped — set MINUTO_TEST_DATABASE_URL to run', { skip: true }, () => {});
} else {
  testStoreContract('postgres', async () => {
    const store = await createPostgresStore({ connectionString: url, migrate: true });

    // Each case starts empty. The cascade from meetings clears everything
    // below it, so one statement is enough.
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url });
    await pool.query('DELETE FROM meetings');
    await pool.end();

    return store;
  });
}
