import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transcribePcm, type Progress, type Recogniser, type RecognisedWord } from './transcribe.ts';
import { SAMPLE_RATE } from '../audio/windows.ts';

const pcm = (seconds: number) => new Float32Array(Math.round(seconds * SAMPLE_RATE));

/** Window-relative words, which is what a real recogniser returns. */
function word(text: string, fromMs: number, toMs: number): RecognisedWord {
  return { text, tStartMs: fromMs, tEndMs: toMs };
}

/** A recogniser that replays canned words per window index. */
function canned(byIndex: Record<number, RecognisedWord[]>): Recogniser {
  return async (window) => byIndex[window.index] ?? [];
}

const SMALL = { windowSec: 2, overlapSec: 0.5 };
const texts = (ws: { text: string }[]) => ws.map((w) => w.text);

test('empty audio produces no words', async () => {
  const out = await transcribePcm(pcm(0), canned({}), SMALL);
  assert.deepEqual(out, []);
});

test('a single window passes its words through', async () => {
  const out = await transcribePcm(
    pcm(1.5),
    canned({ 0: [word('hello', 0, 500), word('there', 500, 1000)] }),
    SMALL,
  );
  assert.deepEqual(texts(out), ['hello', 'there']);
});

test('window-relative timings become absolute', async () => {
  const out = await transcribePcm(
    pcm(3),
    canned({
      0: [word('first', 0, 500)],
      1: [word('second', 0, 500)],
    }),
    SMALL,
  );
  assert.deepEqual(
    out.map((w) => [w.text, w.tStartMs, w.tEndMs]),
    [
      ['first', 0, 500],
      ['second', 1500, 2000],
    ],
  );
});

test('words repeated across the overlap are emitted once', async () => {
  const out = await transcribePcm(
    pcm(3),
    canned({
      0: [word('we', 0, 500), word('will', 500, 1000), word('ship', 1500, 2000)],
      1: [word('ship', 0, 500), word('the', 500, 1000)],
    }),
    SMALL,
  );
  assert.deepEqual(texts(out), ['we', 'will', 'ship', 'the']);
});

test('a window the model found nothing in contributes nothing', async () => {
  const out = await transcribePcm(
    pcm(3),
    canned({ 0: [word('alone', 0, 500)], 1: [] }),
    SMALL,
  );
  assert.deepEqual(texts(out), ['alone']);
});

test('windows are recognised in order', async () => {
  const seen: number[] = [];
  const recognise: Recogniser = async (window) => {
    seen.push(window.index);
    return [];
  };
  await transcribePcm(pcm(6), recognise, SMALL);
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b));
  assert.ok(seen.length > 2, `expected several windows, got ${seen.length}`);
});

test('every window is handed the samples for its own slice', async () => {
  const lengths: number[] = [];
  const recognise: Recogniser = async (window) => {
    lengths.push(window.samples.length);
    return [];
  };
  await transcribePcm(pcm(3), recognise, SMALL);
  assert.deepEqual(lengths, [2 * SAMPLE_RATE, 1.5 * SAMPLE_RATE]);
});

test('progress is reported once per window', async () => {
  const seen: { index: number; total: number }[] = [];
  await transcribePcm(pcm(3), canned({}), {
    ...SMALL,
    onProgress: (p) => seen.push(p),
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.at(-1), { index: 1, total: 2, skipped: false });
});

test('a skipped window says so in its progress report', async () => {
  const seen: Progress[] = [];
  await transcribePcm(pcm(3), canned({}), {
    ...SMALL,
    speech: [],
    onProgress: (p) => seen.push(p),
  });
  assert.deepEqual(seen.map((p) => p.skipped), [true, true]);
});

test('a window with no detected speech is never handed to the model', async () => {
  const seen: number[] = [];
  const recognise: Recogniser = async (window) => {
    seen.push(window.index);
    return [word('something', 0, 500)];
  };
  const out = await transcribePcm(pcm(3), recognise, {
    ...SMALL,
    speech: [{ startMs: 0, endMs: 1000 }],
  });
  assert.deepEqual(seen, [0]);
  assert.deepEqual(texts(out), ['something']);
});

test('a window holding only a trace of speech is skipped', async () => {
  const seen: number[] = [];
  const recognise: Recogniser = async (window) => {
    seen.push(window.index);
    return [];
  };
  await transcribePcm(pcm(3), recognise, {
    ...SMALL,
    speech: [{ startMs: 1400, endMs: 1550 }],
  });
  assert.deepEqual(seen, []);
});

test('lowering the speech minimum lets a brief window through', async () => {
  const brief = [{ startMs: 1400, endMs: 1550 }];
  const run = async (minSpeechMsPerWindow?: number) => {
    const seen: number[] = [];
    await transcribePcm(
      pcm(3),
      async (window) => {
        seen.push(window.index);
        return [];
      },
      { ...SMALL, speech: brief, minSpeechMsPerWindow },
    );
    return seen;
  };

  // The first window holds 150ms of that speech, the second only 50ms.
  assert.deepEqual(await run(), [], 'default threshold should reject both');
  assert.deepEqual(await run(100), [0], 'a 100ms threshold should admit the first');
});

test('progress is still reported for windows that were skipped', async () => {
  const seen: { index: number; total: number }[] = [];
  await transcribePcm(pcm(3), canned({}), {
    ...SMALL,
    speech: [],
    onProgress: (p) => seen.push(p),
  });
  assert.equal(seen.length, 2);
});

test('with no speech regions given, every window is transcribed', async () => {
  const seen: number[] = [];
  const recognise: Recogniser = async (window) => {
    seen.push(window.index);
    return [];
  };
  await transcribePcm(pcm(3), recognise, SMALL);
  assert.deepEqual(seen, [0, 1]);
});

test('a failing window names itself in the error', async () => {
  const recognise: Recogniser = async (window) => {
    if (window.index === 1) throw new Error('model exploded');
    return [];
  };
  await assert.rejects(transcribePcm(pcm(3), recognise, SMALL), /window 1.*model exploded/s);
});
