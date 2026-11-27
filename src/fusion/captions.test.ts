import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseCaptions, type CaptionLine } from './captions.ts';

function line(speaker: string, startMs: number, endMs: number, text: string): CaptionLine {
  return { speaker, startMs, endMs, text };
}

const shown = (lines: readonly CaptionLine[]) => lines.map((l) => [l.speaker, l.text]);

test('no captions yields nothing', () => {
  assert.deepEqual(normaliseCaptions([]), []);
});

test('a line that grows collapses to its final form', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 1400, 'so we'),
    line('Pranav', 1000, 2200, 'so we will ship'),
  ]);
  assert.deepEqual(shown(out), [['Pranav', 'so we will ship']]);
});

test('several growth steps still collapse to one line', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 1200, 'so'),
    line('Pranav', 1000, 1500, 'so we'),
    line('Pranav', 1000, 1900, 'so we will'),
    line('Pranav', 1000, 2400, 'so we will ship the demo'),
  ]);
  assert.deepEqual(shown(out), [['Pranav', 'so we will ship the demo']]);
});

test('a mid-line revision collapses rather than duplicating', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 2000, 'so we will ship the demo'),
    line('Pranav', 1000, 2300, 'so we will ship the Geodesis demo'),
  ]);
  assert.deepEqual(shown(out), [['Pranav', 'so we will ship the Geodesis demo']]);
});

test('an exact repeat is emitted once', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 2000, 'so we will ship'),
    line('Pranav', 1000, 2000, 'so we will ship'),
  ]);
  assert.equal(out.length, 1);
});

test('different speakers never collapse into each other', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 2000, 'so we will ship'),
    line('Asha', 1100, 2100, 'so we will ship'),
  ]);
  assert.deepEqual(shown(out), [
    ['Pranav', 'so we will ship'],
    ['Asha', 'so we will ship'],
  ]);
});

test('an unrelated sentence from the same speaker stays separate', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 2000, 'so we will ship the demo'),
    line('Pranav', 2100, 3000, 'and the deck is ready'),
  ]);
  assert.equal(out.length, 2);
});

test('the same speaker after a long pause starts a new line', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 2000, 'so we'),
    line('Pranav', 30_000, 31_000, 'so we will ship'),
  ]);
  assert.equal(out.length, 2);
});

test('a collapsed line spans the earliest start and the latest end', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 1400, 'so we'),
    line('Pranav', 1200, 2600, 'so we will ship'),
  ]);
  assert.deepEqual([out[0]!.startMs, out[0]!.endMs], [1000, 2600]);
});

test('blank lines are dropped', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 1100, '   '),
    line('Pranav', 1200, 2000, 'so we will ship'),
  ]);
  assert.deepEqual(shown(out), [['Pranav', 'so we will ship']]);
});

test('a shorter retraction keeps the longer text', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 2000, 'so we will ship the demo'),
    line('Pranav', 1000, 2000, 'so we will ship'),
  ]);
  assert.deepEqual(shown(out), [['Pranav', 'so we will ship the demo']]);
});

test('casing and punctuation differences do not defeat collapsing', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 1400, 'So we'),
    line('Pranav', 1000, 2200, 'So we will ship.'),
  ]);
  assert.deepEqual(shown(out), [['Pranav', 'So we will ship.']]);
});

test('interleaved speakers each collapse on their own', () => {
  const out = normaliseCaptions([
    line('Pranav', 1000, 1400, 'so we'),
    line('Asha', 1100, 1500, 'I think'),
    line('Pranav', 1000, 2200, 'so we will ship'),
    line('Asha', 1100, 2300, 'I think that works'),
  ]);
  assert.deepEqual(shown(out), [
    ['Pranav', 'so we will ship'],
    ['Asha', 'I think that works'],
  ]);
});

test('lines come back in start order', () => {
  const out = normaliseCaptions([
    line('Asha', 5000, 6000, 'second thing'),
    line('Pranav', 1000, 2000, 'first thing'),
  ]);
  assert.deepEqual(out.map((l) => l.startMs), [1000, 5000]);
});
