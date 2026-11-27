import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractCandidates, splitSentences, findDueHint } from './extract.ts';
import type { Segment } from './validate.ts';

let nextSeq = 1;
const said = (speakerName: string, text: string): Segment => ({
  seq: nextSeq++,
  tStartMs: nextSeq * 1000,
  text,
  speakerName,
});

const kinds = (segments: Segment[]) => extractCandidates(segments).map((c) => [c.kind, c.text]);

// ---------- splitSentences ----------

test('a single sentence comes back whole', () => {
  assert.deepEqual(splitSentences('We will ship on Friday'), ['We will ship on Friday']);
});

test('sentences are split on terminators', () => {
  assert.deepEqual(splitSentences('We will ship. Asha will book it.'), [
    'We will ship.',
    'Asha will book it.',
  ]);
});

test('questions keep their mark', () => {
  assert.deepEqual(splitSentences('Who presents? I can.'), ['Who presents?', 'I can.']);
});

test('empty text yields no sentences', () => {
  assert.deepEqual(splitSentences('   '), []);
});

// ---------- findDueHint ----------

test('a weekday is picked up as a due hint', () => {
  assert.equal(findDueHint('we will ship it by Friday'), 'Friday');
});

test('tomorrow is a due hint', () => {
  assert.equal(findDueHint('I will send it tomorrow'), 'tomorrow');
});

test('next week is a due hint', () => {
  assert.equal(findDueHint('let us review next week'), 'next week');
});

test('an explicit date is a due hint', () => {
  assert.equal(findDueHint('due on 2026-12-01 at the latest'), '2026-12-01');
});

test('no time reference gives no hint', () => {
  assert.equal(findDueHint('we will ship the demo'), null);
});

// ---------- decisions ----------

test('a stated intention is a decision', () => {
  const found = extractCandidates([said('Pranav', "So we'll ship the Geodesis demo on Friday.")]);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.kind, 'decision');
});

test('an agreement is a decision', () => {
  assert.deepEqual(kinds([said('Asha', 'We agreed to postpone the launch.')]), [
    ['decision', 'We agreed to postpone the launch.'],
  ]);
});

test('a settled choice is a decision', () => {
  assert.equal(extractCandidates([said('Asha', "Let's go with the second option.")])[0]!.kind, 'decision');
});

// ---------- actions ----------

test('a first-person commitment is an action owned by the speaker', () => {
  const found = extractCandidates([said('Asha', 'I will prepare the slide deck.')]);
  assert.equal(found[0]!.kind, 'action');
  assert.equal(found[0]!.ownerName, 'Asha');
});

test('a named commitment is owned by that person', () => {
  const found = extractCandidates([said('Pranav', 'Asha will book the venue.')]);
  assert.equal(found[0]!.kind, 'action');
  assert.equal(found[0]!.ownerName, 'Asha');
});

test('a request is an action with no owner assumed', () => {
  const found = extractCandidates([said('Pranav', 'Can someone chase the invoice?')]);
  assert.equal(found[0]!.kind, 'action');
  assert.equal(found[0]!.ownerName, null);
});

test('an action item said outright is picked up', () => {
  const found = extractCandidates([said('Pranav', 'Action item: renew the domain.')]);
  assert.equal(found[0]!.kind, 'action');
});

test('an action carries its due hint', () => {
  const found = extractCandidates([said('Asha', 'I will send the deck by Thursday.')]);
  assert.equal(found[0]!.dueHint, 'Thursday');
});

test('a first-person commitment from an unnamed speaker has no owner', () => {
  const found = extractCandidates([{ seq: 1, tStartMs: 0, text: 'I will do it.' }]);
  assert.equal(found[0]!.ownerName, null);
});

// ---------- questions ----------

test('an unanswered question is picked up', () => {
  assert.deepEqual(kinds([said('Pranav', 'Who is presenting the demo?')]), [
    ['question', 'Who is presenting the demo?'],
  ]);
});

test('a rhetorical filler question is ignored', () => {
  assert.deepEqual(extractCandidates([said('Pranav', 'Right?')]), []);
});

// ---------- citations and noise ----------

test('every candidate cites the segment it came from', () => {
  const segments = [said('Pranav', "We'll ship on Friday."), said('Asha', 'I will book the room.')];
  const found = extractCandidates(segments);
  assert.deepEqual(
    found.map((c) => c.sourceSeqs),
    [[segments[0]!.seq], [segments[1]!.seq]],
  );
});

test('several commitments in one segment each become a candidate', () => {
  const found = extractCandidates([
    said('Asha', 'I will prepare the deck. Pranav will book the venue.'),
  ]);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((c) => c.ownerName), ['Asha', 'Pranav']);
});

test('small talk produces nothing', () => {
  assert.deepEqual(
    extractCandidates([
      said('Pranav', 'Morning everyone.'),
      said('Asha', 'The weather is terrible today.'),
    ]),
    [],
  );
});

test('an empty transcript produces nothing', () => {
  assert.deepEqual(extractCandidates([]), []);
});

test('candidates come back in transcript order', () => {
  const segments = [
    said('Pranav', 'I will start the build.'),
    said('Asha', "We'll review it on Monday."),
  ];
  assert.deepEqual(extractCandidates(segments).map((c) => c.kind), ['action', 'decision']);
});

test('a decision that is also a commitment is reported once', () => {
  const found = extractCandidates([said('Pranav', "We'll ship on Friday and I will tell the team.")]);
  // Two sentences' worth of meaning, but one sentence: it must not double up.
  assert.equal(found.length, 1);
});
