/**
 * Groups a word stream back into transcript lines.
 *
 * `transcribePcm` returns a flat list of timed words, which is right for
 * fusion but wrong for a human or for `parseTranscript`: fed in as one blob it
 * becomes a single segment, so every citation in the resulting minutes points
 * at 0:00 and nothing is traceable.
 *
 * Lines break where the speaker paused, which is the only structure audio
 * alone offers. A very long unbroken run is split anyway, because a citation
 * that points at a two-minute block is barely a citation.
 *
 * No speaker is invented. Who spoke comes from captions or the active-speaker
 * log (src/fusion), and a placeholder like "Unknown:" would be parsed back as
 * a real attendee.
 */

import { formatTimestamp } from '../minutes/render.ts';
import type { Word } from './stitch.ts';

export type TranscriptLine = {
  startMs: number;
  endMs: number;
  text: string;
};

export type GroupOptions = {
  /** Silence longer than this starts a new line. */
  maxGapMs?: number;
  /** Hard cap, so one long monologue is still citable in pieces. */
  maxWords?: number;
};

const DEFAULTS = { maxGapMs: 1200, maxWords: 30 } as const;

export function groupIntoLines(
  words: readonly Word[],
  options: GroupOptions = {},
): TranscriptLine[] {
  const maxGapMs = options.maxGapMs ?? DEFAULTS.maxGapMs;
  const maxWords = options.maxWords ?? DEFAULTS.maxWords;

  const lines: TranscriptLine[] = [];
  let current: Word[] = [];

  const close = (): void => {
    if (current.length === 0) return;

    lines.push({
      startMs: current[0]!.tStartMs,
      endMs: current.at(-1)!.tEndMs,
      text: current.map((word) => word.text).join(' '),
    });
    current = [];
  };

  for (const word of words) {
    const previous = current.at(-1);
    const paused = previous !== undefined && word.tStartMs - previous.tEndMs > maxGapMs;

    if (paused || current.length >= maxWords) close();
    current.push(word);
  }

  close();
  return lines;
}

/**
 * The word stream as a transcript `parseTranscript` can read back, so
 * `transcribe` and `minutes` chain without losing the timings.
 */
export function formatAsTranscript(words: readonly Word[], options: GroupOptions = {}): string {
  const lines = groupIntoLines(words, options);
  if (lines.length === 0) return '';

  return `${lines.map((line) => `[${formatTimestamp(line.startMs)}] ${line.text}`).join('\n')}\n`;
}
