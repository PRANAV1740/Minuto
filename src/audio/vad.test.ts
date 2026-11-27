import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectSpeech, speechMsInRange } from './vad.ts';
import { SAMPLE_RATE } from './windows.ts';

/** A 220Hz tone, standing in for speech. */
function tone(seconds: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  }
  return out;
}

const silence = (seconds: number) => new Float32Array(Math.round(seconds * SAMPLE_RATE));

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test('pure silence contains no speech', () => {
  assert.deepEqual(detectSpeech(silence(3)), []);
});

test('empty audio contains no speech', () => {
  assert.deepEqual(detectSpeech(new Float32Array(0)), []);
});

test('a clip that is entirely speech yields one region', () => {
  const regions = detectSpeech(tone(2));
  assert.equal(regions.length, 1);
  assert.ok(regions[0]!.endMs - regions[0]!.startMs > 1800, `only ${regions[0]!.endMs - regions[0]!.startMs}ms found`);
});

test('a long silence splits speech into two regions', () => {
  const regions = detectSpeech(concat(tone(1), silence(2), tone(1)));
  assert.equal(regions.length, 2);
  assert.ok(regions[0]!.endMs < regions[1]!.startMs);
});

test('a short gap does not split a region', () => {
  const regions = detectSpeech(concat(tone(1), silence(0.2), tone(1)));
  assert.equal(regions.length, 1);
});

test('a blip too short to be speech is discarded', () => {
  const regions = detectSpeech(concat(silence(1), tone(0.08), silence(1)));
  assert.deepEqual(regions, []);
});

test('regions never start before the audio does', () => {
  const regions = detectSpeech(concat(tone(1), silence(2)));
  assert.ok(regions[0]!.startMs >= 0, `started at ${regions[0]!.startMs}`);
});

test('regions never run past the end of the audio', () => {
  const samples = concat(silence(2), tone(1));
  const durationMs = (samples.length / SAMPLE_RATE) * 1000;
  const regions = detectSpeech(samples);
  assert.ok(regions.at(-1)!.endMs <= durationMs, `ended at ${regions.at(-1)!.endMs} of ${durationMs}`);
});

test('regions come back in order and do not overlap', () => {
  const regions = detectSpeech(concat(tone(1), silence(1.5), tone(1), silence(1.5), tone(1)));
  assert.equal(regions.length, 3);
  for (let i = 1; i < regions.length; i++) {
    assert.ok(regions[i]!.startMs > regions[i - 1]!.endMs, `region ${i} overlaps its predecessor`);
  }
});

test('quiet speech is still found', () => {
  const regions = detectSpeech(concat(silence(1), tone(1, 0.02), silence(1)));
  assert.equal(regions.length, 1);
});

test('a longer minimum speech length discards a short region', () => {
  const audio = concat(silence(1), tone(0.4), silence(1));
  assert.equal(detectSpeech(audio).length, 1);
  assert.deepEqual(detectSpeech(audio, { minSpeechMs: 1000 }), []);
});

test('speechMsInRange reports no speech for a silent window', () => {
  const regions = [{ startMs: 0, endMs: 1000 }];
  assert.equal(speechMsInRange(regions, 2000, 5000), 0);
});

test('speechMsInRange measures the overlapping part only', () => {
  const regions = [{ startMs: 500, endMs: 1500 }];
  assert.equal(speechMsInRange(regions, 1000, 3000), 500);
});

test('speechMsInRange adds up several regions', () => {
  const regions = [
    { startMs: 0, endMs: 400 },
    { startMs: 600, endMs: 900 },
  ];
  assert.equal(speechMsInRange(regions, 0, 1000), 700);
});

test('speechMsInRange counts a region that spans the whole window', () => {
  const regions = [{ startMs: 0, endMs: 10_000 }];
  assert.equal(speechMsInRange(regions, 2000, 5000), 3000);
});
