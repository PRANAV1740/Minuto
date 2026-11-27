import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateOffset, applyOffset } from './align.ts';
import type { CaptionLine } from './captions.ts';
import type { Word } from '../asr/stitch.ts';

const SENTENCE = ['so', 'we', 'will', 'ship', 'the', 'demo'];

/** The sentence as words on a 400ms grid, starting at `fromMs`. */
function spoken(fromMs: number): Word[] {
  return SENTENCE.map((text, i) => ({
    text,
    tStartMs: fromMs + i * 400,
    tEndMs: fromMs + i * 400 + 400,
  }));
}

/** One caption line covering the same sentence, starting at `fromMs`. */
function captioned(fromMs: number, text = SENTENCE.join(' ')): CaptionLine {
  return { speaker: 'Pranav', startMs: fromMs, endMs: fromMs + 2400, text };
}

// ---------- estimateOffset ----------

test('already-aligned sources need no shift', () => {
  const result = estimateOffset(spoken(0), [captioned(0)]);
  assert.equal(result.offsetMs, 0);
  assert.equal(result.confident, true);
});

test('captions that lag the audio are recovered', () => {
  const result = estimateOffset(spoken(0), [captioned(2000)]);
  assert.equal(result.offsetMs, 2000);
  assert.equal(result.confident, true);
});

test('captions that lead the audio are recovered', () => {
  const result = estimateOffset(spoken(1500), [captioned(0)]);
  assert.equal(result.offsetMs, -1500);
  assert.equal(result.confident, true);
});

test('a large lag is still recovered', () => {
  const result = estimateOffset(spoken(0), [captioned(12_000)]);
  assert.equal(result.offsetMs, 12_000);
});

test('the number of agreeing words is reported', () => {
  const result = estimateOffset(spoken(0), [captioned(2000)]);
  assert.equal(result.matched, SENTENCE.length);
});

test('no words means no shift and no confidence', () => {
  const result = estimateOffset([], [captioned(2000)]);
  assert.equal(result.offsetMs, 0);
  assert.equal(result.confident, false);
});

test('no captions means no shift and no confidence', () => {
  const result = estimateOffset(spoken(0), []);
  assert.equal(result.offsetMs, 0);
  assert.equal(result.confident, false);
});

test('text that shares nothing produces no shift and no confidence', () => {
  const result = estimateOffset(spoken(0), [captioned(2000, 'entirely unrelated wording here')]);
  assert.equal(result.offsetMs, 0);
  assert.equal(result.confident, false);
  assert.equal(result.matched, 0);
});

test('too few agreeing words is not confident', () => {
  const oneWord: Word[] = [{ text: 'demo', tStartMs: 0, tEndMs: 400 }];
  const result = estimateOffset(oneWord, [captioned(2000)]);
  assert.equal(result.confident, false);
});

test('a lag beyond the search range is not claimed as found', () => {
  const result = estimateOffset(spoken(0), [captioned(50_000)], { maxOffsetMs: 10_000 });
  assert.ok(Math.abs(result.offsetMs) <= 10_000);
  assert.equal(result.confident, false);
});

test('only the opening of the call is used for the estimate', () => {
  // The first minute says +2000. A later stretch says 0, and must not vote.
  const words = [...spoken(0), ...spoken(300_000)];
  const captions = [captioned(2000), captioned(300_000)];
  const result = estimateOffset(words, captions, { windowMs: 60_000 });
  assert.equal(result.offsetMs, 2000);
});

test('casing and punctuation do not affect the estimate', () => {
  const shouty: Word[] = SENTENCE.map((text, i) => ({
    text: `${text.toUpperCase()},`,
    tStartMs: i * 400,
    tEndMs: i * 400 + 400,
  }));
  const result = estimateOffset(shouty, [captioned(2000)]);
  assert.equal(result.offsetMs, 2000);
});

// ---------- applyOffset ----------

test('applying an offset shifts both ends of every word', () => {
  const shifted = applyOffset(spoken(1000), 500);
  assert.deepEqual(
    shifted.slice(0, 2).map((w) => [w.tStartMs, w.tEndMs]),
    [
      [1500, 1900],
      [1900, 2300],
    ],
  );
});

test('applying a zero offset changes nothing', () => {
  const words = spoken(1000);
  assert.deepEqual(applyOffset(words, 0), words);
});

test('applying an offset keeps the words themselves', () => {
  const shifted = applyOffset(spoken(0), 2000);
  assert.deepEqual(shifted.map((w) => w.text), SENTENCE);
});

test('a negative offset never produces a negative time', () => {
  const shifted = applyOffset(spoken(0), -5000);
  for (const word of shifted) {
    assert.ok(word.tStartMs >= 0, `start was ${word.tStartMs}`);
    assert.ok(word.tEndMs >= 0, `end was ${word.tEndMs}`);
  }
});

test('a negative offset still shifts what it can', () => {
  const shifted = applyOffset(spoken(2000), -1000);
  assert.equal(shifted[0]!.tStartMs, 1000);
});
