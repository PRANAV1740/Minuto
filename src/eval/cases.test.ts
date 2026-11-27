import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseTruth, loadCases } from './cases.ts';

const MINIMAL = {
  segments: [{ startMs: 0, endMs: 1000, speaker: 'Pranav', text: 'hello there' }],
};

// ---------- parseTruth ----------

test('a minimal case parses', () => {
  const truth = parseTruth(MINIMAL, 'my-case');
  assert.equal(truth.segments.length, 1);
});

test('the folder name is used when no name is given', () => {
  assert.equal(parseTruth(MINIMAL, 'my-case').name, 'my-case');
});

test('an explicit name wins over the folder name', () => {
  assert.equal(parseTruth({ ...MINIMAL, name: 'chosen' }, 'my-case').name, 'chosen');
});

test('the glossary defaults to empty', () => {
  assert.deepEqual(parseTruth(MINIMAL, 'my-case').glossary, []);
});

test('a glossary is kept when given', () => {
  const truth = parseTruth({ ...MINIMAL, glossary: ['Geodesis'] }, 'my-case');
  assert.deepEqual(truth.glossary, ['Geodesis']);
});

test('captions parse when present', () => {
  const truth = parseTruth(
    { ...MINIMAL, captions: [{ speaker: 'Pranav', startMs: 0, endMs: 900, text: 'hello' }] },
    'my-case',
  );
  assert.equal(truth.captions?.length, 1);
});

test('speaker samples parse when present', () => {
  const truth = parseTruth(
    { ...MINIMAL, speakerSamples: [{ atMs: 400, speaker: 'Pranav' }] },
    'my-case',
  );
  assert.equal(truth.speakerSamples?.length, 1);
});

test('a case with no segments is rejected by name', () => {
  assert.throws(() => parseTruth({ segments: [] }, 'broken-case'), /broken-case/);
});

test('a segment missing its text is rejected', () => {
  assert.throws(
    () => parseTruth({ segments: [{ startMs: 0, endMs: 10, speaker: 'P' }] }, 'broken-case'),
    /text/i,
  );
});

test('a segment that ends before it starts is rejected', () => {
  assert.throws(
    () => parseTruth({ segments: [{ startMs: 500, endMs: 100, speaker: 'P', text: 'x' }] }, 'bad'),
    /end/i,
  );
});

test('a completely wrong shape is rejected', () => {
  assert.throws(() => parseTruth('not an object', 'bad'), /bad/);
});

// ---------- loadCases ----------

let root = '';

async function makeCase(name: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content);
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'minuto-cases-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test('a case folder with audio and truth is found', async () => {
  await makeCase('alpha', { 'truth.json': JSON.stringify(MINIMAL), 'audio.wav': 'x' });
  const cases = await loadCases(root);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]!.truth.name, 'alpha');
  assert.match(cases[0]!.audioPath, /audio\.wav$/);
});

test('any supported audio extension is accepted', async () => {
  await makeCase('beta', { 'truth.json': JSON.stringify(MINIMAL), 'audio.m4a': 'x' });
  const cases = await loadCases(root);
  assert.ok(cases.some((c) => c.audioPath.endsWith('audio.m4a')));
});

test('a folder without a truth file is ignored', async () => {
  await makeCase('no-truth', { 'audio.wav': 'x' });
  const cases = await loadCases(root);
  assert.ok(!cases.some((c) => c.truth.name === 'no-truth'));
});

test('a case with no audio is reported rather than skipped silently', async () => {
  await makeCase('no-audio', { 'truth.json': JSON.stringify(MINIMAL) });
  await assert.rejects(loadCases(root), /no-audio/);
});

test('cases come back in name order', async () => {
  const fresh = await mkdtemp(join(tmpdir(), 'minuto-order-'));
  const previous = root;
  root = fresh;
  await makeCase('zulu', { 'truth.json': JSON.stringify(MINIMAL), 'audio.wav': 'x' });
  await makeCase('alpha', { 'truth.json': JSON.stringify(MINIMAL), 'audio.wav': 'x' });
  const cases = await loadCases(fresh);
  assert.deepEqual(cases.map((c) => c.truth.name), ['alpha', 'zulu']);
  root = previous;
  await rm(fresh, { recursive: true, force: true });
});

test('a missing cases directory yields no cases', async () => {
  assert.deepEqual(await loadCases(join(root, 'does-not-exist')), []);
});
