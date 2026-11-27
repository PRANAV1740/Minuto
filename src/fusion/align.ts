/**
 * Puts the ASR clock and the caption clock on the same timeline.
 *
 * The two sources measure time differently. Caption timestamps come from when
 * the DOM mutated — wall clock, and late, because Meet only shows a line once
 * the recogniser has something to show. ASR timestamps are offsets into the
 * captured audio, which starts whenever capture started. The gap between them
 * is easily a second or two.
 *
 * Fusion still works without this, but every segment pays for it: a word that
 * should sit inside a caption instead sits just outside one, so attribution
 * falls from "a caption covers this word" (0.98) to "a caption is nearby"
 * (0.70). Measured on the end-to-end smoke run, every segment came back at
 * 0.60 for exactly this reason.
 *
 * The offset is found by search rather than arithmetic, because nothing in the
 * browser reports it: try a range of shifts, and keep the one where the most
 * ASR words land inside a caption that contains that same word. Text agreement
 * is the signal — the two sources are transcribing the same speech, so when
 * the clocks line up, the words line up.
 */

import type { Word } from '../asr/stitch.ts';
import type { CaptionLine } from './captions.ts';

export type AlignmentResult = {
  /** Add this to every ASR timestamp to reach caption time. */
  offsetMs: number;
  /** How many words agreed with a caption at the chosen offset. */
  matched: number;
  /** How many words were examined. */
  considered: number;
  /** Whether enough words agreed for the estimate to be worth applying. */
  confident: boolean;
};

export type AlignOptions = {
  /** Only the opening of the call is used; drift is assumed constant. */
  windowMs?: number;
  /** Largest shift worth considering in either direction. */
  maxOffsetMs?: number;
  coarseStepMs?: number;
  fineStepMs?: number;
  /** Agreeing words needed before the estimate is trusted. */
  minMatches?: number;
};

const DEFAULTS = {
  windowMs: 60_000,
  maxOffsetMs: 30_000,
  coarseStepMs: 250,
  fineStepMs: 50,
  minMatches: 4,
} as const;

const key = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const part of text.split(/\s+/u)) {
    const token = key(part);
    if (token !== '') out.add(token);
  }
  return out;
}

type Candidate = {
  tokens: Set<string>;
  startMs: number;
  endMs: number;
};

/** Words that land inside a caption containing that same word, at shift `d`. */
function agreement(words: readonly Word[], lines: readonly Candidate[], d: number): number {
  let matched = 0;

  for (const word of words) {
    const token = key(word.text);
    if (token === '') continue;

    const startMs = word.tStartMs + d;
    const endMs = word.tEndMs + d;

    for (const line of lines) {
      const overlaps = Math.min(endMs, line.endMs) - Math.max(startMs, line.startMs) > 0;
      if (overlaps && line.tokens.has(token)) {
        matched++;
        break;
      }
    }
  }

  return matched;
}

/**
 * Best shift in a range, as the centre of the winning plateau.
 *
 * Scores come in plateaus: any shift that puts the words inside the caption
 * scores the same. Taking the first or smallest of those biases the answer to
 * the plateau's edge, where half the words sit on a boundary. The centre is
 * the shift furthest from falling off either end.
 */
function bestInRange(
  words: readonly Word[],
  lines: readonly Candidate[],
  from: number,
  to: number,
  step: number,
): { offsetMs: number; matched: number } {
  let best = -1;
  const plateau: number[] = [];

  for (let d = from; d <= to; d += step) {
    const matched = agreement(words, lines, d);
    if (matched > best) {
      best = matched;
      plateau.length = 0;
      plateau.push(d);
    } else if (matched === best) {
      plateau.push(d);
    }
  }

  if (best <= 0) return { offsetMs: 0, matched: 0 };

  const centre = (plateau[0]! + plateau.at(-1)!) / 2;
  return { offsetMs: Math.round(centre / step) * step, matched: best };
}

export function estimateOffset(
  words: readonly Word[],
  captions: readonly CaptionLine[],
  options: AlignOptions = {},
): AlignmentResult {
  const windowMs = options.windowMs ?? DEFAULTS.windowMs;
  const maxOffsetMs = options.maxOffsetMs ?? DEFAULTS.maxOffsetMs;
  const coarseStepMs = options.coarseStepMs ?? DEFAULTS.coarseStepMs;
  const fineStepMs = options.fineStepMs ?? DEFAULTS.fineStepMs;
  const minMatches = options.minMatches ?? DEFAULTS.minMatches;

  // Drift is treated as a constant, so the opening of the call is enough to
  // measure it — and cheaper than scanning a 90-minute transcript.
  const opening = words.filter((word) => word.tStartMs <= windowMs);
  const lines: Candidate[] = captions
    .filter((line) => line.startMs <= windowMs)
    .map((line) => ({ tokens: tokenSet(line.text), startMs: line.startMs, endMs: line.endMs }));

  const considered = opening.length;
  if (considered === 0 || lines.length === 0) {
    return { offsetMs: 0, matched: 0, considered, confident: false };
  }

  const coarse = bestInRange(opening, lines, -maxOffsetMs, maxOffsetMs, coarseStepMs);
  if (coarse.matched === 0) {
    return { offsetMs: 0, matched: 0, considered, confident: false };
  }

  // Refine around the coarse answer, in case the true plateau is narrower than
  // one coarse step and the peak was stepped over.
  const fine = bestInRange(
    opening,
    lines,
    coarse.offsetMs - coarseStepMs,
    coarse.offsetMs + coarseStepMs,
    fineStepMs,
  );

  const winner = fine.matched >= coarse.matched ? fine : coarse;

  return {
    offsetMs: winner.offsetMs,
    matched: winner.matched,
    considered,
    confident: winner.matched >= minMatches,
  };
}

/**
 * Shifts ASR words onto caption time.
 *
 * Times are floored at zero: a negative timestamp is meaningless downstream and
 * would render as nonsense. A word pushed below zero loses a little precision,
 * which is preferable to a transcript that claims speech before the recording
 * began.
 */
export function applyOffset(words: readonly Word[], offsetMs: number): Word[] {
  return words.map((word) => ({
    text: word.text,
    tStartMs: Math.max(0, word.tStartMs + offsetMs),
    tEndMs: Math.max(0, word.tEndMs + offsetMs),
  }));
}
