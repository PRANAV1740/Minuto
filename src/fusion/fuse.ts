/**
 * Fuses the three things a Google Meet call gives you into one transcript that
 * is both accurately worded and correctly attributed.
 *
 *   captions      — speaker names exactly right, words lossy
 *   Whisper       — words right, no idea who is speaking
 *   active-speaker— who was talking, sampled a few times a second
 *
 * Neither of the first two is good enough alone. Fused, the result beats both,
 * and it needs no paid diarisation vendor — normally the most expensive line on
 * a transcription bill. This is the central idea of the product
 * (docs/ACCURACY.md §2).
 *
 * Attribution happens **per word**, not per segment as the design sketched. A
 * speaker change in the middle of a run of ASR words then needs no splitting
 * step: each word is attributed on its own and segments fall out of grouping
 * the results. Simpler, and it cannot mis-split.
 *
 * Not yet built: clock alignment. Caption timestamps come from when the DOM
 * mutated, ASR timestamps are offsets into the audio, and the two drift over a
 * long call. Everything here assumes a shared clock.
 */

import type { Word } from '../asr/stitch.ts';
import { applyOffset, estimateOffset, type AlignOptions, type AlignmentResult } from './align.ts';
import { normaliseCaptions, type CaptionLine } from './captions.ts';

export type SpeakerSample = {
  atMs: number;
  speaker: string;
};

export type FusedSegment = {
  seq: number;
  tStartMs: number;
  tEndMs: number;
  text: string;
  speaker: string | null;
  /** How much to trust the attribution, not the wording. */
  confidence: number;
  source: 'fused' | 'caption-only';
  /** The two sources disagree badly here; worth a human glance. */
  disputed: boolean;
};

export type FuseOptions = {
  /** Silence longer than this starts a new segment. */
  segmentGapMs?: number;
  /** Below this similarity with the captions, a segment is disputed. */
  disputeThreshold?: number;
  /** How far to look for evidence when nothing overlaps a word. */
  nearestToleranceMs?: number;
  /** Longest unattributed run still treated as a stray to absorb. */
  maxStrayWords?: number;
  reviseWindowMs?: number;
};

const DEFAULTS = {
  segmentGapMs: 1500,
  disputeThreshold: 0.35,
  nearestToleranceMs: 800,
  maxStrayWords: 2,
} as const;

/** Confidence by how the speaker was established. */
const CONFIDENCE = {
  onlyCaption: 0.98,
  dominantCaption: 0.9,
  speakerLog: 0.85,
  nearestCaption: 0.7,
  nearestSample: 0.65,
  adjacent: 0.6,
  unknown: 0.5,
  captionOnly: 0.55,
} as const;

function tokens(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned === '' ? [] : cleaned.split(' ');
}

/**
 * Overlap coefficient: shared tokens over the smaller vocabulary. Chosen over
 * Jaccard because captions are lossy and routinely shorter than the ASR, and
 * Jaccard would punish that length difference as if it were disagreement.
 */
export function tokenSimilarity(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared++;
  }

  return shared / Math.min(left.size, right.size);
}

const overlapMs = (
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

const distanceMs = (
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number },
): number => (overlapMs(a, b) > 0 ? 0 : Math.max(a.startMs - b.endMs, b.startMs - a.endMs));

type Attribution = {
  speaker: string | null;
  confidence: number;
  /** Which caption line supplied the answer, so it is not recovered again. */
  usedLine: number;
};

function majority(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

function attributeWord(
  word: Word,
  lines: readonly CaptionLine[],
  samples: readonly SpeakerSample[],
  toleranceMs: number,
): Attribution {
  const span = { startMs: word.tStartMs, endMs: word.tEndMs };

  // 1. Captions covering this word. Their speaker names are reliable.
  const covering = lines
    .map((line, index) => ({ index, line, ms: overlapMs(span, line) }))
    .filter((hit) => hit.ms > 0);

  if (covering.length > 0) {
    const bySpeaker = new Map<string, { ms: number; index: number }>();
    for (const hit of covering) {
      const current = bySpeaker.get(hit.line.speaker);
      bySpeaker.set(hit.line.speaker, {
        ms: (current?.ms ?? 0) + hit.ms,
        index: current?.index ?? hit.index,
      });
    }

    const ranked = [...bySpeaker].sort((a, b) => b[1].ms - a[1].ms);
    const top = ranked[0]!;

    if (ranked.length === 1) {
      return { speaker: top[0], confidence: CONFIDENCE.onlyCaption, usedLine: top[1].index };
    }

    const total = ranked.reduce((sum, [, value]) => sum + value.ms, 0);
    if (top[1].ms / total > 0.7) {
      return { speaker: top[0], confidence: CONFIDENCE.dominantCaption, usedLine: top[1].index };
    }
    // Genuinely ambiguous — the speaker log is a better witness than a
    // coin flip between two captions.
  }

  // 2. The active-speaker log during this word.
  const during = samples.filter((s) => s.atMs >= word.tStartMs && s.atMs <= word.tEndMs);
  if (during.length > 0) {
    return {
      speaker: majority(during.map((s) => s.speaker)),
      confidence: CONFIDENCE.speakerLog,
      usedLine: -1,
    };
  }

  // 3. The closest caption, if it is close enough to mean anything.
  const nearestLine = lines
    .map((line, index) => ({ index, line, gap: distanceMs(span, line) }))
    .sort((a, b) => a.gap - b.gap)[0];

  if (nearestLine && nearestLine.gap <= toleranceMs) {
    return {
      speaker: nearestLine.line.speaker,
      confidence: CONFIDENCE.nearestCaption,
      usedLine: nearestLine.index,
    };
  }

  // 4. The closest speaker sample.
  const nearestSample = samples
    .map((s) => ({ s, gap: Math.min(Math.abs(s.atMs - word.tStartMs), Math.abs(s.atMs - word.tEndMs)) }))
    .sort((a, b) => a.gap - b.gap)[0];

  if (nearestSample && nearestSample.gap <= toleranceMs) {
    return {
      speaker: nearestSample.s.speaker,
      confidence: CONFIDENCE.nearestSample,
      usedLine: -1,
    };
  }

  return { speaker: null, confidence: CONFIDENCE.unknown, usedLine: -1 };
}

export function fuse(
  words: readonly Word[],
  captions: readonly CaptionLine[],
  speakers: readonly SpeakerSample[],
  options: FuseOptions = {},
): FusedSegment[] {
  const segmentGapMs = options.segmentGapMs ?? DEFAULTS.segmentGapMs;
  const disputeThreshold = options.disputeThreshold ?? DEFAULTS.disputeThreshold;
  const toleranceMs = options.nearestToleranceMs ?? DEFAULTS.nearestToleranceMs;

  const lines = normaliseCaptions(captions, { reviseWindowMs: options.reviseWindowMs });
  const consumed = new Set<number>();

  // ---- attribute, then group ----
  type Group = {
    speaker: string | null;
    confidence: number;
    words: Word[];
  };

  const groups: Group[] = [];

  for (const word of words) {
    const { speaker, confidence, usedLine } = attributeWord(word, lines, speakers, toleranceMs);
    if (usedLine >= 0) consumed.add(usedLine);

    const open = groups.at(-1);
    const continues =
      open !== undefined &&
      open.speaker === speaker &&
      word.tStartMs - open.words.at(-1)!.tEndMs <= segmentGapMs;

    if (continues) {
      open.words.push(word);
      // The weakest evidence in a segment is what the segment is worth.
      open.confidence = Math.min(open.confidence, confidence);
    } else {
      groups.push({ speaker, confidence, words: [word] });
    }
  }

  // ---- absorb strays ----
  // ASR word timings do not line up perfectly with caption timings, so the
  // first word or two of an utterance can fall outside every caption and come
  // back unattributed. Leaving them produces one-word "Unknown" segments
  // sandwiched between real ones. A short unattributed run touching an
  // attributed neighbour belongs to that neighbour's utterance; the merged
  // segment's confidence drops to say the speaker was inferred from adjacency
  // rather than observed.
  const maxStrayWords = options.maxStrayWords ?? DEFAULTS.maxStrayWords;
  const settled: Group[] = [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i]!;
    const isStray = group.speaker === null && group.words.length <= maxStrayWords;

    if (!isStray) {
      settled.push(group);
      continue;
    }

    const before = settled.at(-1);
    const after = groups[i + 1];
    const gapBefore = before ? group.words[0]!.tStartMs - before.words.at(-1)!.tEndMs : Infinity;
    const gapAfter = after ? after.words[0]!.tStartMs - group.words.at(-1)!.tEndMs : Infinity;
    const canUseBefore = before?.speaker != null && gapBefore <= segmentGapMs;
    const canUseAfter = after?.speaker != null && gapAfter <= segmentGapMs;

    if (canUseAfter && (!canUseBefore || gapAfter <= gapBefore)) {
      after!.words.unshift(...group.words);
      after!.confidence = Math.min(after!.confidence, CONFIDENCE.adjacent);
      continue;
    }
    if (canUseBefore) {
      before!.words.push(...group.words);
      before!.confidence = Math.min(before!.confidence, CONFIDENCE.adjacent);
      continue;
    }

    settled.push(group);
  }

  const fused: Omit<FusedSegment, 'seq'>[] = settled.map((group) => {
    const tStartMs = group.words[0]!.tStartMs;
    const tEndMs = group.words.at(-1)!.tEndMs;
    const text = group.words.map((word) => word.text).join(' ');

    const against = lines
      .filter((line) => overlapMs({ startMs: tStartMs, endMs: tEndMs }, line) > 0)
      .map((line) => line.text)
      .join(' ');

    return {
      tStartMs,
      tEndMs,
      text,
      speaker: group.speaker,
      confidence: group.confidence,
      source: 'fused' as const,
      disputed: against !== '' && tokenSimilarity(text, against) < disputeThreshold,
    };
  });

  // ---- recover captions the ASR never covered ----
  // Usually VAD cut the audio, or the model dropped a quiet stretch. The
  // caption wording is poor, but a line nobody transcribed is worse.
  const recovered: Omit<FusedSegment, 'seq'>[] = lines
    .map((line, index) => ({ line, index }))
    .filter(({ index }) => !consumed.has(index))
    .map(({ line }) => ({
      tStartMs: line.startMs,
      tEndMs: line.endMs,
      text: line.text,
      speaker: line.speaker,
      confidence: CONFIDENCE.captionOnly,
      source: 'caption-only' as const,
      disputed: false,
    }));

  return [...fused, ...recovered]
    .sort((a, b) => a.tStartMs - b.tStartMs)
    .map((segment, index) => ({ ...segment, seq: index + 1 }));
}

export type AlignedFusion = {
  segments: FusedSegment[];
  alignment: AlignmentResult;
};

/**
 * Align the clocks, then fuse — the entry point callers should normally use.
 *
 * Fusion on unaligned input works but quietly costs confidence on every
 * segment, which is the kind of degradation nobody notices. Composing the two
 * steps means a caller cannot forget the first one.
 *
 * An estimate that too few words agreed on is reported but **not applied**: a
 * shift guessed from thin evidence would move good timings for no reason.
 */
export function fuseAligned(
  words: readonly Word[],
  captions: readonly CaptionLine[],
  speakers: readonly SpeakerSample[],
  options: FuseOptions & AlignOptions = {},
): AlignedFusion {
  const alignment = estimateOffset(words, captions, options);
  const onCaptionClock = alignment.confident ? applyOffset(words, alignment.offsetMs) : words;

  return {
    segments: fuse(onCaptionClock, captions, speakers, options),
    alignment,
  };
}
