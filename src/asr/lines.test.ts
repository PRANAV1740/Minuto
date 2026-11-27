import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupIntoLines, formatAsTranscript } from './lines.ts';
import type { Word } from './stitch.ts';

/** Words on a 400ms grid unless a gap is given. */
function speak(...spec: [string, number][]): Word[] {
  return spec.map(([text, start]) => ({ text, tStartMs: start, tEndMs: start + 300 }));
}

test('no words make no lines', () => {
  assert.deepEqual(groupIntoLines([]), []);
});

test('words close together form one line', () => {
  const lines = groupIntoLines(speak(['we', 0], ['will', 400], ['ship', 800]));
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.text, 'we will ship');
});

test('a line starts at its first word', () => {
  const lines = groupIntoLines(speak(['we', 1200], ['will', 1600]));
  assert.equal(lines[0]!.startMs, 1200);
});

test('a pause starts a new line', () => {
  const lines = groupIntoLines(speak(['first', 0], ['part', 400], ['second', 5000]), {
    maxGapMs: 1000,
  });
  assert.deepEqual(lines.map((l) => l.text), ['first part', 'second']);
});

test('a short gap does not start a new line', () => {
  const lines = groupIntoLines(speak(['first', 0], ['second', 900]), { maxGapMs: 1000 });
  assert.equal(lines.length, 1);
});

test('a very long run is broken up so citations stay useful', () => {
  const words = Array.from({ length: 60 }, (_, i): [string, number] => [`w${i}`, i * 300]);
  const lines = groupIntoLines(speak(...words), { maxGapMs: 5000, maxWords: 20 });

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.ok(line.text.split(' ').length <= 20, `line had ${line.text.split(' ').length} words`);
  }
});

test('every word survives the grouping', () => {
  const words = speak(['a', 0], ['b', 400], ['c', 4000], ['d', 4400]);
  const joined = groupIntoLines(words, { maxGapMs: 1000 })
    .map((l) => l.text)
    .join(' ');
  assert.equal(joined, 'a b c d');
});

test('lines come back in order', () => {
  const lines = groupIntoLines(speak(['a', 0], ['b', 9000], ['c', 18_000]), { maxGapMs: 1000 });
  assert.deepEqual(lines.map((l) => l.startMs), [0, 9000, 18_000]);
});

// ---------- formatAsTranscript ----------

test('a transcript line carries its timestamp', () => {
  const text = formatAsTranscript(speak(['we', 62_000], ['will', 62_400]));
  assert.match(text, /^\[1:02\] we will$/m);
});

test('each line is on its own row', () => {
  const text = formatAsTranscript(speak(['first', 0], ['second', 9000]), { maxGapMs: 1000 });
  assert.deepEqual(text.trimEnd().split('\n'), ['[0:00] first', '[0:00:09] second'.replace('0:00:09', '0:09')]);
});

test('no speaker is invented when none is known', () => {
  // Audio alone cannot say who spoke, and a fake "Unknown:" label would end
  // up listed as an attendee.
  const text = formatAsTranscript(speak(['hello', 0]));
  assert.equal(/unknown|speaker/i.test(text), false);
});

test('an empty word list produces an empty transcript', () => {
  assert.equal(formatAsTranscript([]), '');
});
