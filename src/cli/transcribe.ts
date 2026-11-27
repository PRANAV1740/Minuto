/**
 * Phase 0 CLI: an audio file in, a transcript out.
 *
 *   npm run transcribe -- recording.m4a
 *   npm run transcribe -- call.webm --model onnx-community/whisper-large-v3-turbo
 *   npm run transcribe -- call.webm --language en --glossary "Geodesis,Pranav,VAYUN"
 *
 * Reports a realtime factor, which is the number that decides whether a model
 * tier is usable: below 1.0x the transcription takes longer than the meeting.
 */

import { parseArgs } from 'node:util';
import { basename } from 'node:path';

import { decodeToPcm } from '../audio/decode.ts';
import { detectSpeech, type SpeechRegion } from '../audio/vad.ts';
import { SAMPLE_RATE } from '../audio/windows.ts';
import { transcribePcm } from '../asr/transcribe.ts';
import { createWhisperRecogniser } from '../asr/whisper.ts';
import { correctWithGlossary } from '../glossary/correct.ts';
import { formatTimestamp } from '../minutes/render.ts';
import { groupIntoLines } from '../asr/lines.ts';

const USAGE = `
Usage: npm run transcribe -- <audio-file> [options]

  --model <repo>       ONNX Whisper repo (default onnx-community/whisper-base)
  --dtype <q4|q8|fp32> quantisation (default q8)
  --language <code>    language hint; omit to auto-detect
  --window <seconds>   window length (default 30)
  --overlap <seconds>  window overlap (default 5)
  --glossary <a,b,c>   names and terms to snap near-misses onto
  --no-vad             transcribe silence too (it will hallucinate)
  --lines              timestamped lines, ready to feed to: npm run minutes
  --json               print words with timings instead of prose
`.trim();

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      dtype: { type: 'string' },
      language: { type: 'string' },
      window: { type: 'string' },
      overlap: { type: 'string' },
      glossary: { type: 'string' },
      'no-vad': { type: 'boolean' },
      lines: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const file = positionals[0];
  if (!file) fail('No audio file given.');

  const number = (raw: string | undefined, name: string): number | undefined => {
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) fail(`--${name} must be a positive number`);
    return parsed;
  };

  const terms = (values.glossary ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');

  // ---- decode ----
  const decodeStart = Date.now();
  const pcm = await decodeToPcm(file);
  const audioSec = pcm.length / SAMPLE_RATE;
  console.error(
    `decoded ${basename(file)}: ${audioSec.toFixed(1)}s in ${((Date.now() - decodeStart) / 1000).toFixed(1)}s`,
  );

  // ---- find the speech ----
  let speech: SpeechRegion[] | undefined;
  if (!values['no-vad']) {
    speech = detectSpeech(pcm);
    const speechSec = speech.reduce((sum, r) => sum + (r.endMs - r.startMs), 0) / 1000;
    const share = audioSec === 0 ? 0 : (speechSec / audioSec) * 100;
    console.error(
      `speech: ${speechSec.toFixed(1)}s of ${audioSec.toFixed(1)}s (${share.toFixed(0)}%) in ${speech.length} region(s)`,
    );
  }

  // ---- recognise ----
  const recognise = await createWhisperRecogniser({
    model: values.model,
    dtype: values.dtype as 'q4' | 'q8' | 'fp32' | undefined,
    language: values.language,
    onStatus: (message) => console.error(message),
  });

  const asrStart = Date.now();
  let skipped = 0;
  const words = await transcribePcm(pcm, recognise, {
    windowSec: number(values.window, 'window'),
    overlapSec: number(values.overlap, 'overlap'),
    speech,
    onProgress: ({ index, total, skipped: wasSkipped }) => {
      if (wasSkipped) skipped++;
      console.error(`window ${index + 1}/${total}${wasSkipped ? ' (silent, skipped)' : ''}`);
    },
  });

  const asrSec = (Date.now() - asrStart) / 1000;
  const realtime = asrSec === 0 ? Infinity : audioSec / asrSec;
  console.error(
    `transcribed in ${asrSec.toFixed(1)}s — ${realtime.toFixed(2)}x realtime, ${words.length} words` +
    (skipped > 0 ? `, ${skipped} silent window(s) skipped` : ''),
  );

  // ---- correct ----
  const prose = words.map((w) => w.text).join(' ').replace(/\s+([,.!?])/g, '$1');
  const corrected = correctWithGlossary(prose, terms);
  for (const fix of corrected.corrections) {
    console.error(`glossary: "${fix.from}" -> "${fix.to}"`);
  }

  // ---- output ----
  if (values.json) {
    console.log(JSON.stringify(words, null, 2));
    return;
  }

  // Timestamped lines rather than one blob, so `npm run minutes` reads it
  // back as many segments and the citations point somewhere real.
  if (values.lines) {
    // Correct each line rather than the whole blob, so a multi-word glossary
    // term is still matched but the line boundaries survive.
    console.log(
      groupIntoLines(words)
        .map((line) => `[${formatTimestamp(line.startMs)}] ${correctWithGlossary(line.text, terms).text}`)
        .join('\n'),
    );
    return;
  }

  console.log(corrected.text);
  if (words.length > 0) {
    console.error(`\nfirst word at ${formatTimestamp(words[0]!.tStartMs)}, last at ${formatTimestamp(words.at(-1)!.tEndMs)}`);
  }
}

await main();
