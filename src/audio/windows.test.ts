import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planWindows, sliceWindows, SAMPLE_RATE } from './windows.ts';

/** `seconds` of silence at the pipeline's sample rate. */
const pcm = (seconds: number) => new Float32Array(Math.round(seconds * SAMPLE_RATE));

test('a clip shorter than one window yields a single window', () => {
  const plan = planWindows(10, { windowSec: 30, overlapSec: 5 });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], { index: 0, startSec: 0, endSec: 10 });
});

test('an exactly-one-window clip yields a single window', () => {
  const plan = planWindows(30, { windowSec: 30, overlapSec: 5 });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], { index: 0, startSec: 0, endSec: 30 });
});

test('windows advance by window minus overlap', () => {
  const plan = planWindows(60, { windowSec: 30, overlapSec: 5 });
  assert.deepEqual(
    plan.map((w) => [w.startSec, w.endSec]),
    [
      [0, 30],
      [25, 55],
      [50, 60],
    ],
  );
});

test('consecutive windows really do overlap by the requested amount', () => {
  const plan = planWindows(120, { windowSec: 30, overlapSec: 5 });
  for (let i = 1; i < plan.length; i++) {
    const overlap = plan[i - 1]!.endSec - plan[i]!.startSec;
    assert.equal(overlap, 5, `window ${i} overlaps by ${overlap}s`);
  }
});

test('the last window ends exactly at the end of the audio', () => {
  const plan = planWindows(67, { windowSec: 30, overlapSec: 5 });
  assert.equal(plan.at(-1)!.endSec, 67);
});

test('no window is empty', () => {
  const plan = planWindows(50.0001, { windowSec: 30, overlapSec: 5 });
  for (const w of plan) {
    assert.ok(w.endSec > w.startSec, `window ${w.index} is empty`);
  }
});

test('windows are indexed in order from zero', () => {
  const plan = planWindows(90, { windowSec: 30, overlapSec: 5 });
  assert.deepEqual(plan.map((w) => w.index), [0, 1, 2, 3]);
});

test('zero-length audio yields no windows', () => {
  assert.deepEqual(planWindows(0, { windowSec: 30, overlapSec: 5 }), []);
});

test('an overlap at least as large as the window is rejected', () => {
  assert.throws(() => planWindows(60, { windowSec: 30, overlapSec: 30 }), /overlap/i);
});

test('sliceWindows cuts samples matching the plan', () => {
  const slices = sliceWindows(pcm(60), { windowSec: 30, overlapSec: 5 });
  assert.equal(slices.length, 3);
  assert.equal(slices[0]!.samples.length, 30 * SAMPLE_RATE);
  assert.equal(slices[1]!.samples.length, 30 * SAMPLE_RATE);
  assert.equal(slices[2]!.samples.length, 10 * SAMPLE_RATE);
});

test('sliceWindows keeps each window its own start offset in ms', () => {
  const slices = sliceWindows(pcm(60), { windowSec: 30, overlapSec: 5 });
  assert.deepEqual(slices.map((s) => s.startMs), [0, 25_000, 50_000]);
});

test('sliceWindows on a short clip returns the whole clip once', () => {
  const samples = pcm(4);
  const slices = sliceWindows(samples, { windowSec: 30, overlapSec: 5 });
  assert.equal(slices.length, 1);
  assert.equal(slices[0]!.samples.length, samples.length);
});
