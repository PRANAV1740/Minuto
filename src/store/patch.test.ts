import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseActionItemPatch, describeStore } from './patch.ts';

const ok = (input: unknown) => {
  const result = parseActionItemPatch(input);
  assert.ok(result.ok, `expected a valid patch, got: ${result.ok ? '' : result.error}`);
  return result.patch;
};

const bad = (input: unknown): string => {
  const result = parseActionItemPatch(input);
  assert.equal(result.ok, false, 'expected the patch to be rejected');
  return result.ok ? '' : result.error;
};

// ---------- owner ----------

test('an owner name is kept', () => {
  assert.equal(ok({ ownerName: 'Asha R' }).ownerName, 'Asha R');
});

test('an owner name is trimmed', () => {
  assert.equal(ok({ ownerName: '  Asha R  ' }).ownerName, 'Asha R');
});

test('an empty owner clears the assignment', () => {
  assert.equal(ok({ ownerName: '   ' }).ownerName, null);
});

test('an explicit null clears the assignment', () => {
  assert.equal(ok({ ownerName: null }).ownerName, null);
});

test('a placeholder owner clears the assignment', () => {
  for (const value of ['unassigned', 'N/A', 'none', 'TBD']) {
    assert.equal(ok({ ownerName: value }).ownerName, null, `for "${value}"`);
  }
});

test('an absurdly long owner is refused', () => {
  assert.match(bad({ ownerName: 'x'.repeat(200) }), /owner/i);
});

test('an owner that is not text is refused', () => {
  assert.match(bad({ ownerName: 42 }), /owner/i);
});

// ---------- due date ----------

test('a real date is kept', () => {
  assert.equal(ok({ dueDate: '2026-12-01' }).dueDate, '2026-12-01');
});

test('an empty date clears it', () => {
  assert.equal(ok({ dueDate: '' }).dueDate, null);
});

test('a date in the wrong shape is refused', () => {
  assert.match(bad({ dueDate: '1st December' }), /date/i);
});

test('a date that does not exist is refused', () => {
  assert.match(bad({ dueDate: '2026-02-31' }), /date/i);
});

test('a date with a silly month is refused', () => {
  assert.match(bad({ dueDate: '2026-13-01' }), /date/i);
});

// ---------- status ----------

test('each real status is accepted', () => {
  for (const status of ['open', 'done', 'dropped']) {
    assert.equal(ok({ status }).status, status);
  }
});

test('an unknown status is refused', () => {
  assert.match(bad({ status: 'maybe' }), /status/i);
});

// ---------- shape ----------

test('only the keys given are included', () => {
  const patch = ok({ status: 'done' });
  assert.equal('ownerName' in patch, false);
  assert.equal('dueDate' in patch, false);
});

test('unknown keys are ignored rather than trusted', () => {
  const patch = ok({ status: 'done', meetingId: 'somebody-elses', task: 'rewritten' });
  assert.deepEqual(Object.keys(patch), ['status']);
});

test('an empty patch is allowed and changes nothing', () => {
  assert.deepEqual(ok({}), {});
});

test('input that is not an object is refused', () => {
  assert.match(bad('done'), /object|patch/i);
  assert.match(bad(null), /object|patch/i);
});

// ---------- describeStore ----------

test('with no database URL the store is in memory', () => {
  const chosen = describeStore({});
  assert.equal(chosen.kind, 'memory');
  assert.match(chosen.reason, /no database/i);
});

test('a database URL selects postgres', () => {
  const chosen = describeStore({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/minuto' });
  assert.equal(chosen.kind, 'postgres');
});

test('a local database needs no TLS', () => {
  const chosen = describeStore({ DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/minuto' });
  assert.equal(chosen.kind === 'postgres' && chosen.ssl, false);
});

test('a hosted database is given TLS', () => {
  const chosen = describeStore({ DATABASE_URL: 'postgresql://u:p@ep-cool.neon.tech/minuto' });
  assert.equal(chosen.kind === 'postgres' && chosen.ssl, true);
});

test('localhost by name also counts as local', () => {
  const chosen = describeStore({ DATABASE_URL: 'postgresql://u:p@localhost:5433/minuto' });
  assert.equal(chosen.kind === 'postgres' && chosen.ssl, false);
});

test('a blank database URL falls back to memory', () => {
  assert.equal(describeStore({ DATABASE_URL: '   ' }).kind, 'memory');
});

test('a database URL that is not a URL falls back to memory and says why', () => {
  const chosen = describeStore({ DATABASE_URL: 'not a url' });
  assert.equal(chosen.kind, 'memory');
  assert.match(chosen.reason, /could not be read|invalid/i);
});

test('the description never contains the password', () => {
  const chosen = describeStore({ DATABASE_URL: 'postgresql://user:hunter2@localhost:5433/minuto' });
  assert.equal(chosen.reason.includes('hunter2'), false);
});
