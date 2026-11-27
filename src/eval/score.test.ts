import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreCase,
  hallucinatedWords,
  checkThresholds,
  type Truth,
  type Produced,
} from './score.ts';

const truth: Truth = {
  name: 'sample',
  glossary: ['Geodesis', 'Asha'],
  segments: [
    { startMs: 2000, endMs: 5000, speaker: 'Pranav', text: 'we will ship the Geodesis demo' },
    { startMs: 11_000, endMs: 14_000, speaker: 'Asha', text: 'I will book the venue' },
  ],
};

/** A produced result that matches the truth exactly. */
function perfect(): Produced {
  return {
    words: [
      ...'we will ship the Geodesis demo'.split(' ').map((text, i) => ({
        text,
        tStartMs: 2000 + i * 400,
        tEndMs: 2000 + i * 400 + 400,
      })),
      ...'I will book the venue'.split(' ').map((text, i) => ({
        text,
        tStartMs: 11_000 + i * 400,
        tEndMs: 11_000 + i * 400 + 400,
      })),
    ],
    segments: [
      { tStartMs: 2000, tEndMs: 5000, speaker: 'Pranav', text: 'we will ship the Geodesis demo' },
      { tStartMs: 11_000, tEndMs: 14_000, speaker: 'Asha', text: 'I will book the venue' },
    ],
  };
}

// ---------- scoreCase ----------

test('a perfect result scores zero word errors', () => {
  const score = scoreCase(truth, perfect());
  assert.equal(score.wer, 0);
  assert.equal(score.referenceWords, 11);
});

test('a perfect result keeps every glossary term', () => {
  const score = scoreCase(truth, perfect());
  assert.equal(score.properNounRecall, 1);
  assert.deepEqual(score.missingTerms, []);
});

test('a perfect result attributes every speaker', () => {
  const score = scoreCase(truth, perfect());
  assert.equal(score.speakerAccuracy, 1);
});

test('a mangled proper noun lowers recall and is named', () => {
  const produced = perfect();
  produced.segments[0]!.text = 'we will ship the geodasist demo';
  const score = scoreCase(truth, produced);
  assert.ok(score.properNounRecall < 1);
  assert.deepEqual(score.missingTerms, ['Geodesis']);
});

test('a wrong word shows up as a word error', () => {
  const produced = perfect();
  produced.segments[1]!.text = 'I will book the room';
  const score = scoreCase(truth, produced);
  assert.equal(score.substitutions, 1);
  assert.ok(score.wer > 0);
});

test('the wrong speaker lowers speaker accuracy', () => {
  const produced = perfect();
  produced.segments[1]!.speaker = 'Pranav';
  const score = scoreCase(truth, produced);
  assert.ok(score.speakerAccuracy !== null && score.speakerAccuracy < 1);
});

test('an unattributed segment counts against speaker accuracy', () => {
  const produced = perfect();
  produced.segments[1]!.speaker = null;
  const score = scoreCase(truth, produced);
  assert.ok(score.speakerAccuracy !== null && score.speakerAccuracy < 1);
});

test('speaker accuracy is not reported when nothing was attributed', () => {
  const produced = perfect();
  for (const segment of produced.segments) segment.speaker = null;
  const score = scoreCase(truth, produced);
  assert.equal(score.speakerAccuracy, null);
});

test('the case name is carried through', () => {
  assert.equal(scoreCase(truth, perfect()).name, 'sample');
});

test('a result with no segments falls back to the word stream', () => {
  const produced = perfect();
  const score = scoreCase(truth, { words: produced.words, segments: [] });
  assert.equal(score.wer, 0);
  assert.equal(score.speakerAccuracy, null);
});

// ---------- hallucinatedWords ----------

test('a word inside a reference segment is not hallucinated', () => {
  const found = hallucinatedWords([{ text: 'ship', tStartMs: 3000, tEndMs: 3400 }], truth.segments);
  assert.deepEqual(found, []);
});

test('a word in a silent gap is hallucinated', () => {
  const found = hallucinatedWords([{ text: 'you', tStartMs: 8000, tEndMs: 8400 }], truth.segments);
  assert.deepEqual(found.map((w) => w.text), ['you']);
});

test('a word just outside a segment is allowed by the tolerance', () => {
  const found = hallucinatedWords(
    [{ text: 'demo', tStartMs: 5100, tEndMs: 5400 }],
    truth.segments,
    { toleranceMs: 500 },
  );
  assert.deepEqual(found, []);
});

test('a word well outside the tolerance is still hallucinated', () => {
  const found = hallucinatedWords(
    [{ text: 'you', tStartMs: 7000, tEndMs: 7400 }],
    truth.segments,
    { toleranceMs: 500 },
  );
  assert.equal(found.length, 1);
});

test('with no reference speech every word is hallucinated', () => {
  const found = hallucinatedWords([{ text: 'anything', tStartMs: 0, tEndMs: 400 }], []);
  assert.equal(found.length, 1);
});

test('no words means nothing hallucinated', () => {
  assert.deepEqual(hallucinatedWords([], truth.segments), []);
});

test('hallucinations are counted in the score', () => {
  const produced = perfect();
  produced.words.push({ text: 'you', tStartMs: 8000, tEndMs: 8400 });
  const score = scoreCase(truth, produced);
  assert.equal(score.hallucinated, 1);
});

// ---------- checkThresholds ----------

const clean = () => scoreCase(truth, perfect());

test('a clean score breaches nothing', () => {
  assert.deepEqual(checkThresholds(clean(), { maxWer: 0.2, minProperNounRecall: 0.9 }), []);
});

test('a word error rate above the limit is reported', () => {
  const score = { ...clean(), wer: 0.45 };
  const breaches = checkThresholds(score, { maxWer: 0.2 });
  assert.equal(breaches.length, 1);
  assert.match(breaches[0]!, /word error/i);
});

test('proper-noun recall below the floor is reported', () => {
  const score = { ...clean(), properNounRecall: 0.5 };
  const breaches = checkThresholds(score, { minProperNounRecall: 0.9 });
  assert.match(breaches[0]!, /proper noun/i);
});

test('speaker accuracy below the floor is reported', () => {
  const score = { ...clean(), speakerAccuracy: 0.4 };
  const breaches = checkThresholds(score, { minSpeakerAccuracy: 0.9 });
  assert.match(breaches[0]!, /speaker/i);
});

test('any hallucination is reported when none are allowed', () => {
  const score = { ...clean(), hallucinated: 2 };
  const breaches = checkThresholds(score, { maxHallucinated: 0 });
  assert.match(breaches[0]!, /hallucinat/i);
});

test('several breaches are all reported', () => {
  const score = { ...clean(), wer: 0.9, properNounRecall: 0.1 };
  const breaches = checkThresholds(score, { maxWer: 0.2, minProperNounRecall: 0.9 });
  assert.equal(breaches.length, 2);
});

test('thresholds that were not set are not checked', () => {
  const score = { ...clean(), wer: 0.9, hallucinated: 5 };
  assert.deepEqual(checkThresholds(score, {}), []);
});

test('an unmeasured speaker accuracy skips its threshold', () => {
  const score = { ...clean(), speakerAccuracy: null };
  assert.deepEqual(checkThresholds(score, { minSpeakerAccuracy: 0.9 }), []);
});
