import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { decodeToPcm } from './decode.ts';
import { SAMPLE_RATE } from './windows.ts';

const run = promisify(execFile);
let dir = '';

/** Generates a real audio file with ffmpeg, which is what decoding must handle. */
async function tone(name: string, args: string[]): Promise<string> {
  const path = join(dir, name);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args, path]);
  return path;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'minuto-decode-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('a one-second clip decodes to exactly one second of samples', async () => {
  const path = await tone('mono.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']);
  const pcm = await decodeToPcm(path);
  assert.equal(pcm.length, SAMPLE_RATE);
});

test('decoded samples carry actual signal', async () => {
  const path = await tone('signal.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']);
  const pcm = await decodeToPcm(path);
  const peak = pcm.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  assert.ok(peak > 0.1, `expected audible signal, peak was ${peak}`);
});

test('samples stay within the normalised float range', async () => {
  const path = await tone('range.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']);
  const pcm = await decodeToPcm(path);
  const peak = pcm.reduce((max, v) => Math.max(max, Math.abs(v)), 0);
  assert.ok(peak <= 1.0001, `expected normalised samples, peak was ${peak}`);
});

test('a stereo source is downmixed to one channel', async () => {
  const path = await tone('stereo.wav', [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=880:duration=1',
    '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo[a]',
    '-map', '[a]',
  ]);
  const pcm = await decodeToPcm(path);
  assert.equal(pcm.length, SAMPLE_RATE);
});

test('a source at another sample rate is resampled', async () => {
  const path = await tone('low.wav', [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ar', '8000',
  ]);
  const pcm = await decodeToPcm(path);
  assert.equal(pcm.length, SAMPLE_RATE);
});

test('compressed audio decodes the same as uncompressed', async () => {
  const path = await tone('clip.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']);
  const pcm = await decodeToPcm(path);
  // Codec padding shifts the length slightly; a tenth of a second is plenty.
  assert.ok(Math.abs(pcm.length - SAMPLE_RATE) < SAMPLE_RATE / 10, `got ${pcm.length} samples`);
});

test('a missing file fails with the path in the message', async () => {
  await assert.rejects(decodeToPcm(join(dir, 'nope.wav')), /nope\.wav/);
});

test('a file that is not audio fails rather than returning silence', async () => {
  const path = join(dir, 'notes.txt');
  await writeFile(path, 'this is not audio');
  await assert.rejects(decodeToPcm(path), /decode/i);
});

test('a file with no audio track fails rather than returning nothing', async () => {
  const path = await tone('silent.mp4', ['-f', 'lavfi', '-i', 'testsrc=duration=1', '-an']);
  await assert.rejects(decodeToPcm(path), /no audio/i);
});

test('a missing ffmpeg is reported as a missing ffmpeg', async () => {
  const path = await tone('present.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1']);
  await assert.rejects(
    decodeToPcm(path, { ffmpegPath: join(dir, 'no-such-ffmpeg') }),
    /ffmpeg/i,
  );
});
