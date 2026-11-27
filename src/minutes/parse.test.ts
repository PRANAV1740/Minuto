import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTranscript } from './parse.ts';

test('a speaker line becomes a segment', () => {
  const segments = parseTranscript('Pranav: So we will ship on Friday.');
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.speakerName, 'Pranav');
  assert.equal(segments[0]!.text, 'So we will ship on Friday.');
});

test('segment numbers start at one and increase', () => {
  const segments = parseTranscript('A: one\nB: two\nA: three');
  assert.deepEqual(segments.map((s) => s.seq), [1, 2, 3]);
});

test('a two-word speaker name is kept whole', () => {
  const segments = parseTranscript('Pranav K: hello there');
  assert.equal(segments[0]!.speakerName, 'Pranav K');
});

test('a colon inside the text does not split again', () => {
  const segments = parseTranscript('Pranav: the plan is this: ship on Friday');
  assert.equal(segments[0]!.text, 'the plan is this: ship on Friday');
});

test('a timestamp is read into the segment time', () => {
  const segments = parseTranscript('[1:02] Pranav: we will ship');
  assert.equal(segments[0]!.tStartMs, 62_000);
});

test('an hour-long timestamp is read correctly', () => {
  const segments = parseTranscript('[1:02:05] Pranav: we will ship');
  assert.equal(segments[0]!.tStartMs, 3_725_000);
});

test('segments without timestamps are spaced out in order', () => {
  const segments = parseTranscript('A: one\nB: two');
  assert.ok(segments[1]!.tStartMs > segments[0]!.tStartMs);
});

test('a continuation line joins the segment above it', () => {
  const segments = parseTranscript('Pranav: we will ship\nand then tell the team');
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.text, 'we will ship and then tell the team');
});

test('blank lines are ignored', () => {
  const segments = parseTranscript('A: one\n\n\nB: two');
  assert.equal(segments.length, 2);
});

test('a line with no speaker and nothing above it stands alone', () => {
  const segments = parseTranscript('just some text');
  assert.equal(segments.length, 1);
  assert.equal(segments[0]!.speakerName, undefined);
  assert.equal(segments[0]!.text, 'just some text');
});

test('empty input yields no segments', () => {
  assert.deepEqual(parseTranscript('   \n  \n'), []);
});

test('windows line endings are handled', () => {
  assert.equal(parseTranscript('A: one\r\nB: two').length, 2);
});

test('a time-only prefix with no speaker still parses', () => {
  const segments = parseTranscript('[0:30] we will ship');
  assert.equal(segments[0]!.tStartMs, 30_000);
  assert.equal(segments[0]!.text, 'we will ship');
});

test('a long lowercase phrase before a colon is not mistaken for a name', () => {
  const segments = parseTranscript('the thing about this whole situation is: it is late');
  assert.equal(segments[0]!.speakerName, undefined);
  assert.match(segments[0]!.text, /the thing about/);
});
