import { test } from 'node:test';
import assert from 'node:assert/strict';

import { correctWithGlossary } from './correct.ts';

test('a one-letter miss on a known name is corrected', () => {
  const r = correctWithGlossary('we ship the geodesic demo', ['Geodesis']);
  assert.equal(r.text, 'we ship the Geodesis demo');
});

test('the correction is recorded for audit', () => {
  const r = correctWithGlossary('the geodesic demo', ['Geodesis']);
  assert.deepEqual(r.corrections, [{ from: 'geodesic', to: 'Geodesis' }]);
});

test('the glossary spelling and casing win', () => {
  const r = correctWithGlossary('ask pranoy about it', ['Pranav']);
  assert.equal(r.text, 'ask Pranav about it');
});

test('a term already spelled correctly is left alone', () => {
  const r = correctWithGlossary('the Geodesis demo', ['Geodesis']);
  assert.equal(r.text, 'the Geodesis demo');
  assert.deepEqual(r.corrections, []);
});

test('surrounding punctuation is preserved', () => {
  const r = correctWithGlossary('the geodesic, which ships', ['Geodesis']);
  assert.equal(r.text, 'the Geodesis, which ships');
});

test('a word two edits away must agree on its opening', () => {
  const r = correctWithGlossary('the value is high', ['Vayun']);
  assert.equal(r.text, 'the value is high');
  assert.deepEqual(r.corrections, []);
});

test('a distant word is never pulled onto a glossary term', () => {
  const r = correctWithGlossary('a generic demo', ['Geodesis']);
  assert.equal(r.text, 'a generic demo');
});

test('common function words are protected', () => {
  const r = correctWithGlossary('the team shipped', ['Thea']);
  assert.equal(r.text, 'the team shipped');
});

test('very short words are never corrected', () => {
  const r = correctWithGlossary('a demo for us', ['Asha']);
  assert.equal(r.text, 'a demo for us');
});

test('a multi-word term is corrected across both words', () => {
  const r = correctWithGlossary('we ship minute core today', ['Minuto Core']);
  assert.equal(r.text, 'we ship Minuto Core today');
});

test('the longest matching term wins', () => {
  const r = correctWithGlossary('minute core ships friday', ['Minuto', 'Minuto Core']);
  assert.equal(r.text, 'Minuto Core ships friday');
});

test('several different terms are corrected in one pass', () => {
  const r = correctWithGlossary('pranoy showed geodesic to asna', ['Pranav', 'Geodesis', 'Asha']);
  assert.equal(r.text, 'Pranav showed Geodesis to Asha');
  assert.equal(r.corrections.length, 3);
});

test('an empty glossary changes nothing', () => {
  const r = correctWithGlossary('the geodesic demo', []);
  assert.equal(r.text, 'the geodesic demo');
  assert.deepEqual(r.corrections, []);
});

test('digits and numbers are left untouched', () => {
  const r = correctWithGlossary('ship 3 builds by q4', ['Geodesis']);
  assert.equal(r.text, 'ship 3 builds by q4');
});

test('the same miss is corrected at every occurrence', () => {
  const r = correctWithGlossary('geodesic then geodesic again', ['Geodesis']);
  assert.equal(r.text, 'Geodesis then Geodesis again');
  assert.equal(r.corrections.length, 2);
});
