/**
 * Scores one evaluation case: what the pipeline produced against what was
 * actually said.
 *
 * Four numbers, kept separate on purpose (docs/ACCURACY.md §1), because a
 * single aggregate hides the trade that matters. A transcript at 12% word
 * error rate with every name correct makes excellent minutes; one at 6% that
 * renders "Pranav" as "Pranoy" makes minutes nobody trusts. Generic ASR
 * benchmarks optimise the first number and ignore the second.
 *
 * Hallucinations get their own count rather than being folded into insertions,
 * because they are a different failure with a different cause: words invented
 * over silence, which is what the VAD guard exists to prevent. Insertions in
 * the middle of speech are mishearings; words in a silent gap are fabrication.
 */

import type { Word } from '../asr/stitch.ts';
import { wer, properNounRecall, speakerAccuracy } from './metrics.ts';

export type TruthSegment = {
  startMs: number;
  endMs: number;
  speaker: string;
  text: string;
};

export type Truth = {
  name: string;
  language?: string;
  glossary?: string[];
  segments: TruthSegment[];
};

export type ProducedSegment = {
  tStartMs: number;
  tEndMs: number;
  speaker: string | null;
  text: string;
};

export type Produced = {
  words: Word[];
  segments: ProducedSegment[];
};

export type CaseScore = {
  name: string;
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
  properNounRecall: number;
  missingTerms: string[];
  /** Null when nothing was attributed, so there is nothing to measure. */
  speakerAccuracy: number | null;
  hallucinated: number;
};

export type Thresholds = {
  maxWer?: number;
  minProperNounRecall?: number;
  minSpeakerAccuracy?: number;
  maxHallucinated?: number;
};

export type HallucinationOptions = {
  /** Slack either side of a reference segment, for timing imprecision. */
  toleranceMs?: number;
};

/**
 * Words that fall outside every stretch of real speech.
 *
 * This is the measurement that tells you whether silence handling works. An
 * untreated Whisper run over a quiet stretch produces confident phantoms —
 * "you", "Thank you for watching" — and those reach the summariser as if
 * somebody had said them.
 */
export function hallucinatedWords(
  words: readonly Word[],
  segments: readonly TruthSegment[],
  options: HallucinationOptions = {},
): Word[] {
  const toleranceMs = options.toleranceMs ?? 300;

  return words.filter((word) => {
    const real = segments.some((segment) => {
      const from = segment.startMs - toleranceMs;
      const to = segment.endMs + toleranceMs;
      return Math.min(word.tEndMs, to) - Math.max(word.tStartMs, from) > 0;
    });
    return !real;
  });
}

export function scoreCase(truth: Truth, produced: Produced): CaseScore {
  const reference = truth.segments.map((segment) => segment.text).join(' ');

  // Segments are the real output; the bare word stream is the fallback for a
  // run that did no fusion.
  const hypothesis =
    produced.segments.length > 0
      ? produced.segments.map((segment) => segment.text).join(' ')
      : produced.words.map((word) => word.text).join(' ');

  const words = wer(reference, hypothesis);
  const nouns = properNounRecall(reference, hypothesis, truth.glossary ?? []);

  const attributed = produced.segments.filter((segment) => segment.speaker !== null);
  const speakers =
    attributed.length === 0
      ? null
      : speakerAccuracy(
          truth.segments.map((segment) => ({
            tStartMs: segment.startMs,
            tEndMs: segment.endMs,
            speaker: segment.speaker,
          })),
          produced.segments.map((segment) => ({
            tStartMs: segment.tStartMs,
            tEndMs: segment.tEndMs,
            // An unattributed segment must count as wrong, not be excused.
            speaker: segment.speaker ?? '',
          })),
        ).accuracy;

  return {
    name: truth.name,
    wer: words.wer,
    substitutions: words.substitutions,
    deletions: words.deletions,
    insertions: words.insertions,
    referenceWords: words.referenceWords,
    properNounRecall: nouns.recall,
    missingTerms: nouns.missing,
    speakerAccuracy: speakers,
    hallucinated: hallucinatedWords(produced.words, truth.segments).length,
  };
}

/**
 * Which thresholds this score breaks. An empty list is a pass.
 *
 * Thresholds that were not set are not checked, and a metric that could not be
 * measured is skipped rather than failed — a case with no caption data should
 * not fail a speaker-accuracy gate it never had the inputs for.
 */
export function checkThresholds(score: CaseScore, thresholds: Thresholds): string[] {
  const breaches: string[] = [];
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

  if (thresholds.maxWer !== undefined && score.wer > thresholds.maxWer) {
    breaches.push(`word error rate ${pct(score.wer)} above limit ${pct(thresholds.maxWer)}`);
  }

  if (
    thresholds.minProperNounRecall !== undefined &&
    score.properNounRecall < thresholds.minProperNounRecall
  ) {
    breaches.push(
      `proper noun recall ${pct(score.properNounRecall)} below floor ${pct(thresholds.minProperNounRecall)}`,
    );
  }

  if (
    thresholds.minSpeakerAccuracy !== undefined &&
    score.speakerAccuracy !== null &&
    score.speakerAccuracy < thresholds.minSpeakerAccuracy
  ) {
    breaches.push(
      `speaker accuracy ${pct(score.speakerAccuracy)} below floor ${pct(thresholds.minSpeakerAccuracy)}`,
    );
  }

  if (thresholds.maxHallucinated !== undefined && score.hallucinated > thresholds.maxHallucinated) {
    breaches.push(
      `hallucinated words ${score.hallucinated} above limit ${thresholds.maxHallucinated}`,
    );
  }

  return breaches;
}
