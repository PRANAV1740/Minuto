import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fuse, fuseAligned, tokenSimilarity, type SpeakerSample } from './fuse.ts';
import type { CaptionLine } from './captions.ts';
import type { Word } from '../asr/stitch.ts';

const w = (text: string, tStartMs: number, tEndMs: number): Word => ({ text, tStartMs, tEndMs });
const cap = (speaker: string, startMs: number, endMs: number, text: string): CaptionLine =>
  ({ speaker, startMs, endMs, text });
const samp = (atMs: number, speaker: string): SpeakerSample => ({ atMs, speaker });

const summary = (segments: ReturnType<typeof fuse>) =>
  segments.map((s) => [s.speaker, s.text]);

// ---------- token similarity ----------

test('identical text is fully similar', () => {
  assert.equal(tokenSimilarity('so we will ship', 'so we will ship'), 1);
});

test('unrelated text is not similar at all', () => {
  assert.equal(tokenSimilarity('so we will ship', 'nothing alike here'), 0);
});

test('similarity ignores casing and punctuation', () => {
  assert.equal(tokenSimilarity('So we will ship.', 'so we will ship'), 1);
});

test('half-shared text is half similar', () => {
  assert.equal(tokenSimilarity('one two three four', 'one two'), 1);
  assert.equal(tokenSimilarity('one two', 'one zebra'), 0.5);
});

test('empty text is not similar to anything', () => {
  assert.equal(tokenSimilarity('', 'something'), 0);
});

// ---------- fusion ----------

test('nothing in, nothing out', () => {
  assert.deepEqual(fuse([], [], []), []);
});

test('a single speaker from the captions is attributed with high confidence', () => {
  const out = fuse([w('so', 0, 500), w('we', 500, 1000)], [cap('Pranav', 0, 1000, 'so we')], []);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.speaker, 'Pranav');
  assert.equal(out[0]!.text, 'so we');
  assert.equal(out[0]!.confidence, 0.98);
  assert.equal(out[0]!.source, 'fused');
});

test('the accurate ASR wording wins over the garbled caption', () => {
  const out = fuse(
    [w('the', 0, 300), w('Geodesis', 300, 900), w('demo', 900, 1200)],
    [cap('Pranav', 0, 1200, 'the geodasist demo')],
    [],
  );
  assert.equal(out[0]!.text, 'the Geodesis demo');
  assert.equal(out[0]!.speaker, 'Pranav');
});

test('two speakers become two segments', () => {
  const out = fuse(
    [w('yes', 0, 500), w('no', 2000, 2500)],
    [cap('Pranav', 0, 600, 'yes'), cap('Asha', 1900, 2600, 'no')],
    [],
  );
  assert.deepEqual(summary(out), [
    ['Pranav', 'yes'],
    ['Asha', 'no'],
  ]);
});

test('a speaker change between adjacent words splits them', () => {
  const out = fuse(
    [w('yes', 0, 400), w('but', 500, 900)],
    [cap('Pranav', 0, 450, 'yes'), cap('Asha', 480, 950, 'but')],
    [],
  );
  assert.deepEqual(summary(out), [
    ['Pranav', 'yes'],
    ['Asha', 'but'],
  ]);
});

test('the active-speaker log attributes a word when no caption covers it', () => {
  const out = fuse([w('hello', 1000, 1500)], [], [samp(1100, 'Asha'), samp(1400, 'Asha')]);
  assert.equal(out[0]!.speaker, 'Asha');
  assert.equal(out[0]!.confidence, 0.85);
});

test('the active-speaker log is settled by majority', () => {
  const out = fuse(
    [w('hello', 1000, 2000)],
    [],
    [samp(1100, 'Asha'), samp(1500, 'Asha'), samp(1900, 'Pranav')],
  );
  assert.equal(out[0]!.speaker, 'Asha');
});

test('a nearby caption is used when none overlaps', () => {
  const out = fuse([w('hello', 1000, 1500)], [cap('Asha', 1600, 2000, 'hello there')], []);
  assert.equal(out[0]!.speaker, 'Asha');
  assert.equal(out[0]!.confidence, 0.7);
});

test('a word with no evidence at all is left unattributed', () => {
  const out = fuse([w('hello', 1000, 1500)], [], []);
  assert.equal(out[0]!.speaker, null);
  assert.equal(out[0]!.confidence, 0.5);
});

test('a caption too far away is not used', () => {
  const out = fuse([w('hello', 1000, 1500)], [cap('Asha', 20_000, 21_000, 'much later')], []);
  assert.equal(out[0]!.speaker, null);
});

test('a segment carries the lowest confidence of its words', () => {
  const out = fuse(
    [w('a', 0, 500), w('b', 600, 1000)],
    [cap('Pranav', 0, 550, 'a')],
    [samp(700, 'Pranav')],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.confidence, 0.85);
});

test('a long pause splits one speaker into two segments', () => {
  const out = fuse(
    [w('first', 0, 500), w('second', 10_000, 10_500)],
    [cap('Pranav', 0, 11_000, 'first second')],
    [],
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.speaker), ['Pranav', 'Pranav']);
});

test('a segment spans its own words', () => {
  const out = fuse([w('so', 200, 500), w('we', 500, 1300)], [cap('Pranav', 0, 2000, 'so we')], []);
  assert.deepEqual([out[0]!.tStartMs, out[0]!.tEndMs], [200, 1300]);
});

test('a stray unattributed word is absorbed by the utterance that follows', () => {
  const out = fuse(
    [w('So', 0, 300), w('we', 1300, 1800)],
    [cap('Pranav', 1200, 2000, 'we')],
    [],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.speaker, 'Pranav');
  assert.equal(out[0]!.text, 'So we');
});

test('absorbing a stray word lowers the segment confidence', () => {
  const out = fuse(
    [w('So', 0, 300), w('we', 1300, 1800)],
    [cap('Pranav', 1200, 2000, 'we')],
    [],
  );
  assert.equal(out[0]!.confidence, 0.6);
});

test('a stray word is absorbed by the utterance before it when that is adjacent', () => {
  const out = fuse(
    [w('yes', 0, 500), w('indeed', 1500, 1700)],
    [cap('Pranav', 0, 600, 'yes')],
    [],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.speaker, 'Pranav');
  assert.equal(out[0]!.text, 'yes indeed');
});

test('an unattributed run too long to be a stray keeps its own segment', () => {
  const out = fuse(
    [w('a', 0, 200), w('b', 200, 400), w('c', 400, 600), w('d', 1500, 2000)],
    [cap('Pranav', 1450, 2100, 'd')],
    [],
  );
  assert.equal(out.length, 2);
  assert.equal(out[0]!.speaker, null);
  assert.equal(out[0]!.text, 'a b c');
  assert.equal(out[1]!.speaker, 'Pranav');
});

test('a stray word with no attributed neighbour stays unattributed', () => {
  const out = fuse([w('a', 0, 200), w('b', 300, 500)], [], []);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.speaker, null);
});

test('a caption the ASR missed entirely is recovered', () => {
  const out = fuse(
    [w('hello', 0, 500)],
    [cap('Pranav', 0, 600, 'hello'), cap('Asha', 5000, 6000, 'I agree with that')],
    [],
  );
  assert.equal(out.length, 2);
  assert.equal(out[1]!.source, 'caption-only');
  assert.equal(out[1]!.text, 'I agree with that');
  assert.equal(out[1]!.speaker, 'Asha');
  assert.equal(out[1]!.confidence, 0.55);
});

test('a recovered caption is not marked disputed', () => {
  const out = fuse([], [cap('Asha', 5000, 6000, 'I agree with that')], []);
  assert.equal(out[0]!.disputed, false);
});

test('agreeing sources are not disputed', () => {
  const out = fuse([w('so', 0, 500), w('we', 500, 1000)], [cap('Pranav', 0, 1000, 'so we')], []);
  assert.equal(out[0]!.disputed, false);
});

test('badly disagreeing sources are flagged as disputed', () => {
  const out = fuse(
    [w('completely', 0, 500), w('different', 500, 1000)],
    [cap('Pranav', 0, 1000, 'nothing like that at all')],
    [],
  );
  assert.equal(out[0]!.disputed, true);
});

test('a segment with no caption to compare against is not disputed', () => {
  const out = fuse([w('hello', 1000, 1500)], [], [samp(1100, 'Asha')]);
  assert.equal(out[0]!.disputed, false);
});

test('segments are numbered from one in time order', () => {
  const out = fuse(
    [w('yes', 0, 500), w('no', 3000, 3500)],
    [cap('Pranav', 0, 600, 'yes'), cap('Asha', 2900, 3600, 'no')],
    [],
  );
  assert.deepEqual(out.map((s) => s.seq), [1, 2]);
  assert.ok(out[0]!.tStartMs < out[1]!.tStartMs);
});

// ---------- fuseAligned ----------

const SENTENCE = ['so', 'we', 'will', 'ship', 'the', 'demo'];
const spoken = (fromMs: number): Word[] =>
  SENTENCE.map((text, i) => w(text, fromMs + i * 400, fromMs + i * 400 + 400));
const captionedAt = (fromMs: number, text = SENTENCE.join(' ')) =>
  cap('Pranav', fromMs, fromMs + 2400, text);

test('lagging captions are aligned before fusing, restoring full confidence', () => {
  const lagging = fuse(spoken(0), [captionedAt(2000)], []);
  const aligned = fuseAligned(spoken(0), [captionedAt(2000)], []);

  // Unaligned, the words sit outside the caption and attribution degrades.
  assert.ok(
    lagging.every((s) => s.confidence < 0.98),
    'expected the unaligned fusion to lose confidence',
  );

  assert.equal(aligned.alignment.offsetMs, 2000);
  assert.equal(aligned.segments.length, 1);
  assert.equal(aligned.segments[0]!.speaker, 'Pranav');
  assert.equal(aligned.segments[0]!.confidence, 0.98);
});

test('already-aligned input is fused without a shift', () => {
  const result = fuseAligned(spoken(0), [captionedAt(0)], []);
  assert.equal(result.alignment.offsetMs, 0);
  assert.equal(result.segments[0]!.confidence, 0.98);
});

test('aligned segment times are on the caption clock', () => {
  const result = fuseAligned(spoken(0), [captionedAt(2000)], []);
  assert.equal(result.segments[0]!.tStartMs, 2000);
});

test('an estimate with too little agreement is not applied', () => {
  const words = [w('alpha', 0, 400), w('beta', 400, 800), w('gamma', 800, 1200)];
  const result = fuseAligned(words, [cap('Pranav', 0, 1200, 'so we will')], []);

  assert.equal(result.alignment.confident, false);
  assert.equal(result.alignment.offsetMs, 0);
  assert.equal(result.segments[0]!.speaker, 'Pranav');
  assert.equal(result.segments[0]!.disputed, true);
});

test('the alignment is reported alongside the segments', () => {
  const result = fuseAligned(spoken(0), [captionedAt(2000)], []);
  assert.equal(result.alignment.matched, SENTENCE.length);
  assert.equal(result.alignment.confident, true);
});

test('caption rewrites are collapsed before fusion', () => {
  const out = fuse(
    [w('so', 0, 400), w('we', 400, 900), w('ship', 900, 1400)],
    [
      cap('Pranav', 0, 400, 'so'),
      cap('Pranav', 0, 900, 'so we'),
      cap('Pranav', 0, 1400, 'so we ship'),
    ],
    [],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.text, 'so we ship');
});
