/**
 * Accuracy metrics for Minuto.
 *
 * Three numbers are tracked separately on purpose (see docs/ACCURACY.md §1):
 * word error rate, proper-noun recall, and speaker attribution accuracy.
 * Proper-noun recall matters most for minutes — a transcript that gets every
 * name right reads as correct even at a higher word error rate.
 */

export type Timed = {
  tStartMs: number;
  tEndMs: number;
  speaker: string;
};

export type WerResult = {
  wer: number;
  substitutions: number;
  deletions: number;
  insertions: number;
  referenceWords: number;
};

export type ProperNounResult = {
  recall: number;
  expected: number;
  found: number;
  missing: string[];
};

export type SpeakerResult = {
  accuracy: number;
  frames: number;
  correct: number;
};

/**
 * Strips everything that should not count as a word difference: casing,
 * punctuation and repeated whitespace. Letters and digits of any script are
 * kept, so Devanagari that slips through the ASR is still compared rather
 * than silently discarded.
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function tokens(text: string): string[] {
  const n = normalise(text);
  return n === '' ? [] : n.split(' ');
}

/**
 * Word error rate by Levenshtein distance over word sequences, with the edit
 * types broken out. Reporting substitutions, deletions and insertions
 * separately is what tells a mishearing apart from a dropped span.
 */
export function wer(reference: string, hypothesis: string): WerResult {
  const ref = tokens(reference);
  const hyp = tokens(hypothesis);

  if (ref.length === 0) {
    throw new Error('wer: reference must contain at least one word');
  }

  const n = ref.length;
  const m = hyp.length;

  // cost[i][j] = edit distance between ref[0..i) and hyp[0..j)
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) cost[i]![0] = i;
  for (let j = 0; j <= m; j++) cost[0]![j] = j;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = ref[i - 1] === hyp[j - 1];
      cost[i]![j] = Math.min(
        cost[i - 1]![j - 1]! + (same ? 0 : 1),
        cost[i - 1]![j]! + 1,
        cost[i]![j - 1]! + 1,
      );
    }
  }

  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = ref[i - 1] === hyp[j - 1];
      if (cost[i]![j] === cost[i - 1]![j - 1]! + (same ? 0 : 1)) {
        if (!same) substitutions++;
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && cost[i]![j] === cost[i - 1]![j]! + 1) {
      deletions++;
      i--;
      continue;
    }
    insertions++;
    j--;
  }

  return {
    wer: (substitutions + deletions + insertions) / n,
    substitutions,
    deletions,
    insertions,
    referenceWords: n,
  };
}

/** Counts non-overlapping occurrences of a token sequence inside another. */
function countSequence(haystack: string[], needle: string[]): number {
  if (needle.length === 0) return 0;
  let count = 0;
  for (let i = 0; i + needle.length <= haystack.length; ) {
    let hit = true;
    for (let k = 0; k < needle.length; k++) {
      if (haystack[i + k] !== needle[k]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      count++;
      i += needle.length;
    } else {
      i++;
    }
  }
  return count;
}

/**
 * How many mentions of the meeting's own vocabulary survived transcription,
 * weighted by occurrence. Terms the reference never mentions are ignored, so
 * padding the glossary cannot inflate the score.
 */
export function properNounRecall(
  reference: string,
  hypothesis: string,
  terms: readonly string[],
): ProperNounResult {
  const ref = tokens(reference);
  const hyp = tokens(hypothesis);

  let expected = 0;
  let found = 0;
  const missing: string[] = [];

  for (const term of terms) {
    const needle = tokens(term);
    const inRef = countSequence(ref, needle);
    if (inRef === 0) continue;

    const inHyp = countSequence(hyp, needle);
    expected += inRef;
    found += Math.min(inRef, inHyp);
    if (inHyp < inRef) missing.push(term);
  }

  return {
    recall: expected === 0 ? 1 : found / expected,
    expected,
    found,
    missing,
  };
}

/**
 * Frame-level speaker attribution accuracy. Walks the reference timeline in
 * fixed frames and asks who the hypothesis thinks was talking. A frame the
 * hypothesis leaves unattributed counts as wrong, not as excused.
 */
export function speakerAccuracy(
  reference: readonly Timed[],
  hypothesis: readonly Timed[],
  options: { frameMs?: number } = {},
): SpeakerResult {
  const frameMs = options.frameMs ?? 100;
  if (frameMs <= 0) throw new Error('speakerAccuracy: frameMs must be positive');

  let frames = 0;
  let correct = 0;

  for (const segment of reference) {
    for (let t = segment.tStartMs; t + frameMs <= segment.tEndMs; t += frameMs) {
      const centre = t + frameMs / 2;
      const guess = hypothesis.find((h) => centre >= h.tStartMs && centre < h.tEndMs);
      frames++;
      if (guess?.speaker === segment.speaker) correct++;
    }
  }

  return {
    accuracy: frames === 0 ? 1 : correct / frames,
    frames,
    correct,
  };
}
