import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCaptionTracker } from './caption-tracker.ts';
import { normaliseCaptions } from '../fusion/captions.ts';

/** A clock the test drives by hand. */
function clock(startMs = 0) {
  let now = startMs;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

test('the first sighting of a line is recorded', () => {
  const time = clock();
  const tracker = createCaptionTracker(time.now);

  tracker.observe([{ speaker: 'Pranav', text: 'so we' }]);

  assert.deepEqual(tracker.lines(), [
    { speaker: 'Pranav', startMs: 0, endMs: 0, text: 'so we' },
  ]);
});

test('an unchanged line is not recorded twice', () => {
  const time = clock();
  const tracker = createCaptionTracker(time.now);

  tracker.observe([{ speaker: 'Pranav', text: 'so we' }]);
  time.advance(500);
  tracker.observe([{ speaker: 'Pranav', text: 'so we' }]);

  assert.equal(tracker.lines().length, 1);
});

test('a growing line keeps the start it first appeared at', () => {
  const time = clock();
  const tracker = createCaptionTracker(time.now);

  tracker.observe([{ speaker: 'Pranav', text: 'so we' }]);
  time.advance(800);
  tracker.observe([{ speaker: 'Pranav', text: 'so we will ship' }]);

  const lines = tracker.lines();
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => [l.startMs, l.endMs, l.text]), [
    [0, 0, 'so we'],
    [0, 800, 'so we will ship'],
  ]);
});

test('an unrelated sentence starts its own timing', () => {
  const time = clock();
  const tracker = createCaptionTracker(time.now);

  tracker.observe([{ speaker: 'Pranav', text: 'so we will ship' }]);
  time.advance(2000);
  tracker.observe([{ speaker: 'Pranav', text: 'and the deck is ready' }]);

  assert.deepEqual(tracker.lines().at(-1), {
    speaker: 'Pranav',
    startMs: 2000,
    endMs: 2000,
    text: 'and the deck is ready',
  });
});

test('speakers are tracked independently', () => {
  const time = clock();
  const tracker = createCaptionTracker(time.now);

  tracker.observe([{ speaker: 'Pranav', text: 'so we' }]);
  time.advance(400);
  tracker.observe([
    { speaker: 'Pranav', text: 'so we' },
    { speaker: 'Asha', text: 'I think' },
  ]);
  time.advance(400);
  tracker.observe([
    { speaker: 'Pranav', text: 'so we will ship' },
    { speaker: 'Asha', text: 'I think' },
  ]);

  const bySpeaker = tracker.lines().filter((l) => l.speaker === 'Asha');
  assert.equal(bySpeaker.length, 1);
  assert.equal(bySpeaker[0]!.startMs, 400);
});

test('casing and punctuation changes alone are treated as the same line', () => {
  const time = clock();
  const tracker = createCaptionTracker(time.now);

  tracker.observe([{ speaker: 'Pranav', text: 'so we will ship' }]);
  time.advance(300);
  tracker.observe([{ speaker: 'Pranav', text: 'So we will ship.' }]);

  assert.equal(tracker.lines().length, 2);
  assert.equal(tracker.lines().at(-1)!.startMs, 0, 'a reworded line keeps its start');
});

test('nothing observed records nothing', () => {
  const tracker = createCaptionTracker(clock().now);
  tracker.observe([]);
  assert.deepEqual(tracker.lines(), []);
});

test('blank text is ignored', () => {
  const tracker = createCaptionTracker(clock().now);
  tracker.observe([{ speaker: 'Pranav', text: '   ' }]);
  assert.deepEqual(tracker.lines(), []);
});

test('the tracked lines collapse to one utterance per speaker', () => {
  const time = clock();
  const tracker = createCaptionTracker(time.now);

  for (const text of ['so', 'so we', 'so we will', 'so we will ship the demo']) {
    tracker.observe([{ speaker: 'Pranav', text }]);
    time.advance(400);
  }

  // Four sightings in, one clean line out.
  const collapsed = normaliseCaptions(tracker.lines());
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0]!.text, 'so we will ship the demo');
});

test('a reset clears what was tracked', () => {
  const tracker = createCaptionTracker(clock().now);
  tracker.observe([{ speaker: 'Pranav', text: 'so we' }]);
  tracker.reset();
  assert.deepEqual(tracker.lines(), []);
});
