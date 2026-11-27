import { test } from 'node:test';
import assert from 'node:assert/strict';

import { chunksToWords } from './whisper.ts';

const WINDOW_MS = 30_000;

test('timestamps in seconds become milliseconds', () => {
  const words = chunksToWords([{ text: 'hello', timestamp: [0.5, 1.25] }], WINDOW_MS);
  assert.deepEqual(words, [{ text: 'hello', tStartMs: 500, tEndMs: 1250 }]);
});

test('the leading space Whisper emits is trimmed', () => {
  const words = chunksToWords([{ text: ' hello', timestamp: [0, 1] }], WINDOW_MS);
  assert.equal(words[0]!.text, 'hello');
});

test('chunks with no text are dropped', () => {
  const words = chunksToWords(
    [
      { text: ' ', timestamp: [0, 1] },
      { text: 'real', timestamp: [1, 2] },
    ],
    WINDOW_MS,
  );
  assert.deepEqual(words.map((w) => w.text), ['real']);
});

test('a missing end timestamp borrows the next chunk start', () => {
  const words = chunksToWords(
    [
      { text: 'first', timestamp: [0, null] },
      { text: 'second', timestamp: [1.5, 2] },
    ],
    WINDOW_MS,
  );
  assert.equal(words[0]!.tEndMs, 1500);
});

test('a missing end timestamp on the last chunk falls back to the window end', () => {
  const words = chunksToWords([{ text: 'last', timestamp: [29, null] }], WINDOW_MS);
  assert.equal(words[0]!.tEndMs, WINDOW_MS);
});

test('a missing start timestamp continues from the previous word', () => {
  const words = chunksToWords(
    [
      { text: 'first', timestamp: [0, 1] },
      { text: 'second', timestamp: [null, 2] },
    ],
    WINDOW_MS,
  );
  assert.equal(words[1]!.tStartMs, 1000);
});

test('a first chunk with no start timestamp begins at zero', () => {
  const words = chunksToWords([{ text: 'first', timestamp: [null, 1] }], WINDOW_MS);
  assert.equal(words[0]!.tStartMs, 0);
});

test('an end before its start is clamped to the start', () => {
  const words = chunksToWords([{ text: 'odd', timestamp: [2, 1] }], WINDOW_MS);
  assert.equal(words[0]!.tEndMs, 2000);
});

test('a multi-word segment is split into words with interpolated timings', () => {
  const words = chunksToWords([{ text: ' we will ship', timestamp: [0, 3] }], WINDOW_MS);
  assert.deepEqual(words, [
    { text: 'we', tStartMs: 0, tEndMs: 1000 },
    { text: 'will', tStartMs: 1000, tEndMs: 2000 },
    { text: 'ship', tStartMs: 2000, tEndMs: 3000 },
  ]);
});

test('irregular spacing inside a segment does not create empty words', () => {
  const words = chunksToWords([{ text: 'we   will  ship', timestamp: [0, 3] }], WINDOW_MS);
  assert.deepEqual(words.map((w) => w.text), ['we', 'will', 'ship']);
});

test('a multi-word segment with no end timestamp interpolates to the window end', () => {
  const words = chunksToWords([{ text: 'one two', timestamp: [28, null] }], WINDOW_MS);
  assert.deepEqual(words, [
    { text: 'one', tStartMs: 28_000, tEndMs: 29_000 },
    { text: 'two', tStartMs: 29_000, tEndMs: 30_000 },
  ]);
});

test('a later segment continues from where the previous one ended', () => {
  const words = chunksToWords(
    [
      { text: 'we will', timestamp: [0, 2] },
      { text: 'ship it', timestamp: [2, 4] },
    ],
    WINDOW_MS,
  );
  assert.deepEqual(words.map((w) => [w.text, w.tStartMs]), [
    ['we', 0],
    ['will', 1000],
    ['ship', 2000],
    ['it', 3000],
  ]);
});

test('no chunks yields no words', () => {
  assert.deepEqual(chunksToWords([], WINDOW_MS), []);
});

test('a chunk missing its timestamp pair entirely is still placed', () => {
  const words = chunksToWords([{ text: 'orphan' }], WINDOW_MS);
  assert.deepEqual(words, [{ text: 'orphan', tStartMs: 0, tEndMs: WINDOW_MS }]);
});
