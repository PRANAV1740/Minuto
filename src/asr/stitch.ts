/**
 * Joins overlapping ASR windows into one word stream.
 *
 * Whisper is run on fixed windows with a few seconds of overlap, because a
 * clean cut mid-sentence costs words at the boundary. That overlap then has to
 * be removed again, and doing it on time alone duplicates or drops words
 * whenever the two windows disagree slightly about where a word sat. So the
 * seam is found by matching text: the longest run of words that ends the
 * accumulated stream and begins the next window. Time is only the fallback for
 * when the two windows share no text at all.
 *
 * See docs/ACCURACY.md §3 — on a 60-minute call this runs at ~120 seams, so a
 * boundary bug here is not a rounding error, it is a steady leak of words.
 */

export type Word = {
  text: string;
  tStartMs: number;
  tEndMs: number;
};

export type AsrWindow = {
  words: readonly Word[];
};

export type StitchOptions = {
  /** Longest seam to look for. Longer than any realistic overlap wastes work. */
  maxJoinWords?: number;
};

/** Word-level comparison key: casing and punctuation must not break a seam. */
function key(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function sameRun(left: readonly Word[], right: readonly Word[]): boolean {
  for (let i = 0; i < left.length; i++) {
    if (key(left[i]!.text) !== key(right[i]!.text)) return false;
  }
  return true;
}

export function stitchWindows(
  windows: readonly AsrWindow[],
  options: StitchOptions = {},
): Word[] {
  const maxJoinWords = options.maxJoinWords ?? 24;
  const out: Word[] = [];

  for (const window of windows) {
    const incoming = window.words;
    if (incoming.length === 0) continue;

    if (out.length === 0) {
      out.push(...incoming);
      continue;
    }

    // Longest seam first, so a short run that happens to match (a stray "the")
    // never wins over the real overlap.
    const maxK = Math.min(out.length, incoming.length, maxJoinWords);
    let seam = -1;
    for (let k = maxK; k >= 1; k--) {
      if (sameRun(out.slice(out.length - k), incoming.slice(0, k))) {
        seam = k;
        break;
      }
    }

    if (seam >= 0) {
      out.push(...incoming.slice(seam));
      continue;
    }

    // No shared text: keep only what starts after everything already emitted.
    const lastEndMs = out[out.length - 1]!.tEndMs;
    out.push(...incoming.filter((word) => word.tStartMs >= lastEndMs));
  }

  return out;
}
