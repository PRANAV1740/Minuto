/**
 * The scorecard: runs the whole pipeline over every evaluation case and
 * reports the numbers that decide whether Minuto is any good.
 *
 *   npm run eval
 *   npm run eval -- --model onnx-community/whisper-large-v3-turbo
 *   npm run eval -- --case synthetic-gappy --no-vad
 *
 * Exits non-zero when a case breaches a threshold in eval/thresholds.json, so
 * this works as a regression gate rather than a thing you read and forget.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

import { decodeToPcm } from '../audio/decode.ts';
import { detectSpeech } from '../audio/vad.ts';
import { SAMPLE_RATE } from '../audio/windows.ts';
import { transcribePcm } from '../asr/transcribe.ts';
import { createWhisperRecogniser } from '../asr/whisper.ts';
import { correctWithGlossary } from '../glossary/correct.ts';
import { fuse, fuseAligned } from '../fusion/fuse.ts';
import { loadCases, type EvalCase } from '../eval/cases.ts';
import { scoreCase, checkThresholds, type CaseScore, type Thresholds } from '../eval/score.ts';

const CASES_DIR = 'eval/cases';
const THRESHOLDS_FILE = 'eval/thresholds.json';

const USAGE = `
Usage: npm run eval -- [options]

  --model <repo>       ONNX Whisper repo (default onnx-community/whisper-base)
  --dtype <q4|q8|fp32> quantisation (default q8)
  --language <code>    language hint; omit to auto-detect
  --case <name>        run one case instead of all
  --no-vad             skip voice detection (expect hallucinations)
  --json               emit the scores as JSON
`.trim();

const pct = (value: number | null) => (value === null ? '   —  ' : `${(value * 100).toFixed(1)}%`);

function scorecard(scores: readonly CaseScore[]): string {
  const name = Math.max(4, ...scores.map((s) => s.name.length));
  const header =
    `${'case'.padEnd(name)}  ${'WER'.padStart(7)}  ${'nouns'.padStart(7)}  ` +
    `${'speaker'.padStart(7)}  ${'halluc'.padStart(6)}  ${'words'.padStart(5)}`;

  const rows = scores.map(
    (s) =>
      `${s.name.padEnd(name)}  ${pct(s.wer).padStart(7)}  ${pct(s.properNounRecall).padStart(7)}  ` +
      `${pct(s.speakerAccuracy).padStart(7)}  ${String(s.hallucinated).padStart(6)}  ` +
      `${String(s.referenceWords).padStart(5)}`,
  );

  return [header, '-'.repeat(header.length), ...rows].join('\n');
}

async function readThresholds(): Promise<Thresholds> {
  try {
    return JSON.parse(await readFile(THRESHOLDS_FILE, 'utf8')) as Thresholds;
  } catch {
    return {};
  }
}

async function runCase(
  evalCase: EvalCase,
  recognise: Awaited<ReturnType<typeof createWhisperRecogniser>>,
  useVad: boolean,
): Promise<CaseScore> {
  const { truth } = evalCase;

  const pcm = await decodeToPcm(evalCase.audioPath);
  const speech = useVad ? detectSpeech(pcm) : undefined;
  const words = await transcribePcm(pcm, recognise, { speech });

  // With captions, fuse for speaker attribution; without, there is nothing to
  // attribute from and the score simply reports no speaker accuracy.
  const fused = truth.captions
    ? fuseAligned(words, truth.captions, truth.speakerSamples ?? []).segments
    : fuse(words, [], truth.speakerSamples ?? []);

  const segments = fused.map((segment) => ({
    tStartMs: segment.tStartMs,
    tEndMs: segment.tEndMs,
    speaker: segment.speaker,
    text: correctWithGlossary(segment.text, truth.glossary ?? []).text,
  }));

  console.error(
    `  ${(pcm.length / SAMPLE_RATE).toFixed(1)}s audio · ${words.length} words · ${segments.length} segments`,
  );

  return scoreCase(truth, { words, segments });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      model: { type: 'string' },
      dtype: { type: 'string' },
      language: { type: 'string' },
      case: { type: 'string' },
      'no-vad': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const all = await loadCases(CASES_DIR);
  const cases = values.case ? all.filter((c) => c.truth.name === values.case) : all;

  if (all.length === 0) {
    console.log(
      `No evaluation cases found in ${CASES_DIR}/.\n` +
      `Add one — a folder with audio.wav and truth.json. See eval/README.md.\n` +
      `Scores from your own recordings are the only ones that mean anything.`,
    );
    return;
  }

  if (cases.length === 0) {
    console.error(`No case named "${values.case}". Available: ${all.map((c) => c.truth.name).join(', ')}`);
    process.exit(1);
  }

  const recognise = await createWhisperRecogniser({
    model: values.model,
    dtype: values.dtype as 'q4' | 'q8' | 'fp32' | undefined,
    language: values.language,
    onStatus: (message) => console.error(message),
  });

  const scores: CaseScore[] = [];
  for (const evalCase of cases) {
    console.error(`\n${evalCase.truth.name}:`);
    scores.push(await runCase(evalCase, recognise, !values['no-vad']));
  }

  if (values.json) {
    console.log(JSON.stringify(scores, null, 2));
  } else {
    console.log(`\n${scorecard(scores)}`);
  }

  // ---- regression gate ----
  const thresholds = await readThresholds();
  const failures = scores.flatMap((score) =>
    checkThresholds(score, thresholds).map((breach) => `${score.name}: ${breach}`),
  );

  const missing = scores.flatMap((s) => s.missingTerms.map((term) => `${s.name}: lost "${term}"`));
  if (missing.length > 0) console.log(`\n${missing.join('\n')}`);

  if (failures.length > 0) {
    console.log(`\nFAILED\n${failures.join('\n')}`);
    process.exit(1);
  }

  console.log(Object.keys(thresholds).length === 0 ? '\nno thresholds set' : '\nall thresholds met');
}

await main();
