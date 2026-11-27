import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stitchWindows, type Word } from './stitch.ts';

/** Builds words on a 200ms grid starting at `fromMs`. */
function words(fromMs: number, ...texts: string[]): Word[] {
  return texts.map((text, i) => ({
    text,
    tStartMs: fromMs + i * 200,
    tEndMs: fromMs + i * 200 + 200,
  }));
}

const texts = (ws: readonly Word[]): string[] => ws.map((w) => w.text);

test('an empty window list yields no words', () => {
  assert.deepEqual(stitchWindows([]), []);
});

test('a single window passes through unchanged', () => {
  const only = { words: words(0, 'we', 'will', 'ship') };
  assert.deepEqual(texts(stitchWindows([only])), ['we', 'will', 'ship']);
});

test('a repeated overlap is emitted once', () => {
  const a = { words: words(0, 'we', 'will', 'ship', 'the', 'demo') };
  const b = { words: words(600, 'the', 'demo', 'by', 'friday') };
  assert.deepEqual(texts(stitchWindows([a, b])), ['we', 'will', 'ship', 'the', 'demo', 'by', 'friday']);
});

test('the overlap match ignores casing and punctuation', () => {
  const a = { words: words(0, 'ship', 'the', 'Demo.') };
  const b = { words: words(400, 'demo', 'by', 'friday') };
  assert.deepEqual(texts(stitchWindows([a, b])), ['ship', 'the', 'Demo.', 'by', 'friday']);
});

test('the longest overlap wins, not the first word that happens to match', () => {
  const a = { words: words(0, 'demo', 'we', 'will', 'ship', 'the', 'demo') };
  const b = { words: words(800, 'the', 'demo', 'on', 'friday') };
  assert.deepEqual(texts(stitchWindows([a, b])), ['demo', 'we', 'will', 'ship', 'the', 'demo', 'on', 'friday']);
});

test('no textual overlap falls back to cutting on time', () => {
  const a = { words: [{ text: 'ship', tStartMs: 0, tEndMs: 1000 }] };
  const b = {
    words: [
      { text: 'umm', tStartMs: 900, tEndMs: 1100 },
      { text: 'next', tStartMs: 1100, tEndMs: 1300 },
    ],
  };
  assert.deepEqual(texts(stitchWindows([a, b])), ['ship', 'next']);
});

test('a single repeated word at the seam is still deduped', () => {
  const a = { words: [{ text: 'the', tStartMs: 0, tEndMs: 1000 }] };
  const b = {
    words: [
      { text: 'the', tStartMs: 500, tEndMs: 700 },
      { text: 'budget', tStartMs: 1100, tEndMs: 1300 },
    ],
  };
  assert.deepEqual(texts(stitchWindows([a, b])), ['the', 'budget']);
});

test('windows with no words are skipped', () => {
  const a = { words: words(0, 'we', 'will') };
  const empty = { words: [] };
  const b = { words: words(400, 'will', 'ship', 'it') };
  assert.deepEqual(texts(stitchWindows([a, empty, b])), ['we', 'will', 'ship', 'it']);
});

test('three windows stitch in sequence', () => {
  const a = { words: words(0, 'one', 'two', 'three') };
  const b = { words: words(400, 'three', 'four', 'five') };
  const c = { words: words(1000, 'five', 'six') };
  assert.deepEqual(texts(stitchWindows([a, b, c])), ['one', 'two', 'three', 'four', 'five', 'six']);
});

test('word timings survive stitching', () => {
  const a = { words: words(0, 'ship', 'the', 'demo') };
  const b = { words: words(200, 'the', 'demo', 'friday') };
  const out = stitchWindows([a, b]);
  assert.deepEqual(
    out.map((w) => [w.text, w.tStartMs]),
    [
      ['ship', 0],
      ['the', 200],
      ['demo', 400],
      ['friday', 600],
    ],
  );
});

test('a window fully contained in what came before adds nothing', () => {
  const a = { words: words(0, 'we', 'will', 'ship', 'the', 'demo') };
  const b = { words: words(200, 'will', 'ship') };
  assert.deepEqual(texts(stitchWindows([a, b])), ['we', 'will', 'ship', 'the', 'demo']);
});
