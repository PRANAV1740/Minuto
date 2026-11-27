import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalise, wer, properNounRecall, speakerAccuracy } from './metrics.ts';

test('normalise lowercases, strips punctuation and collapses whitespace', () => {
  assert.equal(normalise('So we\'ll  ship the Geodesis demo, by Friday!'), 'so well ship the geodesis demo by friday');
});

test('normalise keeps digits', () => {
  assert.equal(normalise('Ship 3 builds by Q4.'), 'ship 3 builds by q4');
});

test('wer is zero for an identical transcript', () => {
  const r = wer('we will ship the demo', 'we will ship the demo');
  assert.equal(r.wer, 0);
  assert.deepEqual({ s: r.substitutions, d: r.deletions, i: r.insertions }, { s: 0, d: 0, i: 0 });
});

test('wer counts a substitution', () => {
  const r = wer('we will ship the demo', 'we will ship a demo');
  assert.equal(r.substitutions, 1);
  assert.equal(r.referenceWords, 5);
  assert.equal(r.wer, 0.2);
});

test('wer counts a deletion', () => {
  const r = wer('we will ship the demo', 'we will ship demo');
  assert.equal(r.deletions, 1);
  assert.equal(r.wer, 0.2);
});

test('wer counts an insertion', () => {
  const r = wer('we will ship the demo', 'we will ship the big demo');
  assert.equal(r.insertions, 1);
  assert.equal(r.wer, 0.2);
});

test('wer ignores casing and punctuation differences', () => {
  assert.equal(wer('We will ship the demo.', 'we will ship the demo').wer, 0);
});

test('wer rejects an empty reference', () => {
  assert.throws(() => wer('', 'anything'), /reference/i);
});

test('properNounRecall is one when every occurrence survives', () => {
  const r = properNounRecall('Geodesis demo for the Geodesis team', 'Geodesis demo for the Geodesis team', ['Geodesis']);
  assert.equal(r.recall, 1);
  assert.equal(r.expected, 2);
  assert.equal(r.found, 2);
});

test('properNounRecall is occurrence-weighted when one mention is garbled', () => {
  const r = properNounRecall('Geodesis demo for the Geodesis team', 'Geodesis demo for the geodesic team', ['Geodesis']);
  assert.equal(r.expected, 2);
  assert.equal(r.found, 1);
  assert.equal(r.recall, 0.5);
});

test('properNounRecall matches terms case-insensitively', () => {
  const r = properNounRecall('the Geodesis demo', 'the geodesis demo', ['Geodesis']);
  assert.equal(r.recall, 1);
});

test('properNounRecall reports the terms that went missing', () => {
  const r = properNounRecall('Geodesis and Vayun', 'Geodesis and value', ['Geodesis', 'Vayun']);
  assert.deepEqual(r.missing, ['Vayun']);
});

test('properNounRecall ignores terms the reference never mentions', () => {
  const r = properNounRecall('just a demo', 'just a demo', ['Geodesis']);
  assert.equal(r.expected, 0);
  assert.equal(r.recall, 1);
  assert.deepEqual(r.missing, []);
});

test('speakerAccuracy is one when every frame matches', () => {
  const reference = [
    { tStartMs: 0, tEndMs: 1000, speaker: 'Pranav' },
    { tStartMs: 1000, tEndMs: 2000, speaker: 'Asha' },
  ];
  assert.equal(speakerAccuracy(reference, reference, { frameMs: 100 }).accuracy, 1);
});

test('speakerAccuracy penalises a late speaker boundary', () => {
  const reference = [
    { tStartMs: 0, tEndMs: 1000, speaker: 'Pranav' },
    { tStartMs: 1000, tEndMs: 2000, speaker: 'Asha' },
  ];
  const hypothesis = [
    { tStartMs: 0, tEndMs: 1500, speaker: 'Pranav' },
    { tStartMs: 1500, tEndMs: 2000, speaker: 'Asha' },
  ];
  const r = speakerAccuracy(reference, hypothesis, { frameMs: 100 });
  assert.equal(r.frames, 20);
  assert.equal(r.correct, 15);
  assert.equal(r.accuracy, 0.75);
});

test('speakerAccuracy counts an unattributed frame as wrong', () => {
  const reference = [{ tStartMs: 0, tEndMs: 1000, speaker: 'Pranav' }];
  const hypothesis = [{ tStartMs: 0, tEndMs: 500, speaker: 'Pranav' }];
  const r = speakerAccuracy(reference, hypothesis, { frameMs: 100 });
  assert.equal(r.correct, 5);
  assert.equal(r.accuracy, 0.5);
});
