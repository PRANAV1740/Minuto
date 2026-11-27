/**
 * Turns repeated readings of the caption area into timestamped lines.
 *
 * A MutationObserver fires on every change to the caption region, and each
 * time we re-read *all* the entries currently on screen. So the same line is
 * seen over and over as it grows. This records a line only when its text has
 * actually changed, and keeps the moment the utterance *began* rather than the
 * moment of the latest edit — Meet shows a caption after the words were
 * spoken, so the first sighting is the better timestamp.
 *
 * Collapsing the growth sightings into one clean line is `normaliseCaptions`'
 * job (src/fusion/captions.ts), which is already tested for it. This stage
 * only has to avoid losing timing information on the way there.
 *
 * The clock is injected so the behaviour is testable without waiting.
 */

import type { CaptionLine } from '../fusion/captions.ts';

export type Observation = {
  speaker: string;
  text: string;
};

export type CaptionTracker = {
  observe(entries: readonly Observation[]): void;
  lines(): CaptionLine[];
  reset(): void;
};

/** Comparison form: an edit to casing or punctuation is not a new utterance. */
const norm = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

/** Whether one reading continues the other, in either direction. */
function continues(previous: string, next: string): boolean {
  if (previous === '' || next === '') return false;
  return next.startsWith(previous) || previous.startsWith(next);
}

export function createCaptionTracker(now: () => number): CaptionTracker {
  type Open = { startMs: number; lastText: string };

  let recorded: CaptionLine[] = [];
  let open = new Map<string, Open>();

  return {
    observe(entries) {
      for (const entry of entries) {
        const text = entry.text.trim();
        if (text === '') continue;

        const previous = open.get(entry.speaker);

        // Exact comparison: a changed rendering is worth recording, so the
        // final wording of a line is never lost.
        if (previous && previous.lastText === text) continue;

        const at = now();
        const startMs =
          previous && continues(norm(previous.lastText), norm(text)) ? previous.startMs : at;

        recorded.push({ speaker: entry.speaker, startMs, endMs: at, text });
        open.set(entry.speaker, { startMs, lastText: text });
      }
    },

    lines() {
      return [...recorded];
    },

    reset() {
      recorded = [];
      open = new Map();
    },
  };
}
