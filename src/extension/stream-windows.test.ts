import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createStreamWindower } from './stream-windows.ts';

const RATE = 16_000;

/** A ramp, so sample values identify their position in the stream. */
function ramp(count: number, from = 0): Float32Array {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = from + i;
  return out;
}

const SMALL = { windowSec: 2, overlapSec: 0.5, sampleRate: RATE };
const windowSamples = 2 * RATE;
const hopSamples = 1.5 * RATE;

test('a partial window emits nothing', () => {
  const windower = createStreamWindower(SMALL);
  assert.deepEqual(windower.push(ramp(RATE)), []);
});

test('a full window emits once', () => {
  const windower = createStreamWindower(SMALL);
  const emitted = windower.push(ramp(windowSamples));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]!.samples.length, windowSamples);
});

test('the first window starts at zero', () => {
  const windower = createStreamWindower(SMALL);
  assert.equal(windower.push(ramp(windowSamples))[0]!.startMs, 0);
});

test('window starts advance by the hop, not the window', () => {
  const windower = createStreamWindower(SMALL);
  // 6s of audio holds full 2s windows starting at 0, 1.5 and 3.0; one at 4.5
  // would need 6.5s.
  const emitted = windower.push(ramp(windowSamples * 3));
  assert.deepEqual(emitted.map((w) => w.startMs), [0, 1500, 3000]);
});

test('window indices count up from zero', () => {
  const windower = createStreamWindower(SMALL);
  assert.deepEqual(windower.push(ramp(windowSamples * 2)).map((w) => w.index), [0, 1]);
});

test('consecutive windows really share their overlap', () => {
  const windower = createStreamWindower(SMALL);
  const emitted = windower.push(ramp(windowSamples * 2));
  const overlapSamples = windowSamples - hopSamples;

  const tail = emitted[0]!.samples.slice(windowSamples - overlapSamples);
  const head = emitted[1]!.samples.slice(0, overlapSamples);
  assert.deepEqual([...tail], [...head]);
});

test('samples keep their stream position across windows', () => {
  const windower = createStreamWindower(SMALL);
  const emitted = windower.push(ramp(windowSamples * 2));
  // Window 1 starts one hop into the stream, so its first sample is hopSamples.
  assert.equal(emitted[1]!.samples[0], hopSamples);
});

test('audio arriving in small chunks produces the same windows as one push', () => {
  const chunked = createStreamWindower(SMALL);
  const whole = createStreamWindower(SMALL);

  const all = ramp(windowSamples * 2);
  const fromChunks = [];
  for (let at = 0; at < all.length; at += 1024) {
    fromChunks.push(...chunked.push(all.subarray(at, Math.min(at + 1024, all.length))));
  }
  const fromWhole = whole.push(all);

  assert.deepEqual(
    fromChunks.map((w) => [w.index, w.startMs, w.samples.length]),
    fromWhole.map((w) => [w.index, w.startMs, w.samples.length]),
  );
});

test('flush emits the trailing partial window', () => {
  const windower = createStreamWindower(SMALL);
  windower.push(ramp(windowSamples + 8000));
  const tail = windower.flush();
  assert.equal(tail.length, 1);
  assert.ok(tail[0]!.samples.length < windowSamples);
});

test('flush emits nothing when the stream ended on a boundary', () => {
  const windower = createStreamWindower(SMALL);
  windower.push(ramp(hopSamples));
  windower.push(ramp(hopSamples, hopSamples));
  windower.flush();
  assert.deepEqual(windower.flush(), []);
});

test('flush emits nothing for an empty stream', () => {
  assert.deepEqual(createStreamWindower(SMALL).flush(), []);
});

test('flush continues the window numbering', () => {
  const windower = createStreamWindower(SMALL);
  const emitted = windower.push(ramp(windowSamples + 8000));
  const tail = windower.flush();
  assert.equal(tail[0]!.index, emitted.at(-1)!.index + 1);
});

test('the total duration tracks everything pushed', () => {
  const windower = createStreamWindower(SMALL);
  windower.push(ramp(RATE));
  windower.push(ramp(RATE));
  assert.equal(windower.totalMs(), 2000);
});

test('an overlap as long as the window is rejected', () => {
  assert.throws(
    () => createStreamWindower({ windowSec: 2, overlapSec: 2, sampleRate: RATE }),
    /overlap/i,
  );
});

test('memory does not grow without bound as audio streams', () => {
  const windower = createStreamWindower(SMALL);
  for (let i = 0; i < 200; i++) windower.push(ramp(RATE, i * RATE));
  // Only the unfinished window needs retaining, not 200 seconds of audio.
  assert.ok(windower.bufferedSamples() <= windowSamples, `retained ${windower.bufferedSamples()}`);
});
