/**
 * Snaps near-misses in a transcript onto the meeting's own vocabulary.
 *
 * This is the cheapest large win on proper-noun accuracy (docs/ACCURACY.md §4),
 * and it is deliberately rule-based rather than a model pass: it can only
 * replace a word with a term already on the glossary, so it cannot rewrite a
 * sentence or change what someone said. Every substitution is returned for
 * audit.
 *
 * Acceptance rules, tuned on the two cases that matter:
 *   - one edit away            -> accept  ("geodesic" -> "Geodesis")
 *   - two edits away           -> accept only if the first four characters
 *                                 already agree ("pranoy" -> "Pranav" yes,
 *                                 "value" -> "Vayun" no)
 *   - shorter than 3 chars     -> never
 *   - a common function word   -> never
 *
 * The prefix rule replaces the phonetic comparison the design sketched: a
 * consonant skeleton drops exactly the trailing sounds that distinguish
 * "pranoy" from "pranav", so it rejected the corrections worth making.
 */

export type Correction = {
  from: string;
  to: string;
};

export type CorrectionResult = {
  text: string;
  corrections: Correction[];
};

/**
 * Function words only. Content words are left to the distance rules, so this
 * list cannot quietly grow into a dictionary that blocks real corrections.
 */
const COMMON_WORDS = new Set([
  'the', 'and', 'but', 'for', 'nor', 'yet', 'this', 'that', 'these', 'those',
  'with', 'from', 'into', 'onto', 'upon', 'over', 'under', 'than', 'then',
  'they', 'them', 'their', 'there', 'here', 'what', 'when', 'where', 'which',
  'who', 'whom', 'whose', 'why', 'how', 'all', 'any', 'both', 'each', 'few',
  'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same', 'too',
  'very', 'can', 'will', 'just', 'should', 'would', 'could', 'have', 'has',
  'had', 'was', 'were', 'been', 'being', 'are', 'you', 'your', 'yours', 'our',
  'ours', 'his', 'her', 'hers', 'its', 'not', 'now', 'also', 'about', 'after',
  'before', 'because', 'while', 'between', 'through', 'during', 'again',
]);

const MIN_TOKEN_LENGTH = 3;
const PREFIX_AGREEMENT = 4;

function key(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let previous = Array.from({ length: cols }, (_, j) => j);

  for (let i = 1; i < rows; i++) {
    const current = new Array<number>(cols);
    current[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j - 1]! + cost,
        previous[j]! + 1,
        current[j - 1]! + 1,
      );
    }
    previous = current;
  }

  return previous[cols - 1]!;
}

function sharedPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

/** Whether `candidate` is a near-miss of `term` that is safe to replace. */
function isNearMiss(candidate: string, term: string): boolean {
  if (candidate.length < MIN_TOKEN_LENGTH) return false;
  if (COMMON_WORDS.has(candidate)) return false;

  const distance = editDistance(candidate, term);
  if (distance === 0) return false;

  const allowed = term.length <= 4 ? 1 : 2;
  if (distance > allowed) return false;
  if (distance === 1) return true;

  return sharedPrefix(candidate, term) >= PREFIX_AGREEMENT;
}

type Token = {
  text: string;
  start: number;
  end: number;
};

function tokenise(text: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /[\p{L}][\p{L}\p{N}']*|[\p{N}][\p{L}\p{N}]*/gu;
  for (const match of text.matchAll(pattern)) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return tokens;
}

export function correctWithGlossary(
  text: string,
  terms: readonly string[],
): CorrectionResult {
  if (terms.length === 0) return { text, corrections: [] };

  // Group terms by word count so an n-gram is only compared with terms of the
  // same length, and longer terms get the first chance at a match.
  const byWordCount = new Map<number, string[]>();
  for (const term of terms) {
    const count = tokenise(term).length;
    if (count === 0) continue;
    const bucket = byWordCount.get(count);
    if (bucket) bucket.push(term);
    else byWordCount.set(count, [term]);
  }

  const widest = Math.max(...byWordCount.keys());
  const tokens = tokenise(text);
  const corrections: Correction[] = [];

  let out = '';
  let cursor = 0;
  let i = 0;

  while (i < tokens.length) {
    let consumed = 0;

    for (let n = Math.min(widest, tokens.length - i); n >= 1 && consumed === 0; n--) {
      const candidates = byWordCount.get(n);
      if (!candidates) continue;

      const first = tokens[i]!;
      const last = tokens[i + n - 1]!;
      const phrase = text.slice(first.start, last.end);
      const candidateKey = tokens.slice(i, i + n).map((t) => key(t.text)).join('');

      // Already correct: consume it so no shorter match can disturb it.
      if (candidates.some((term) => key(term) === candidateKey)) {
        consumed = n;
        break;
      }

      const hit = candidates.find((term) => isNearMiss(candidateKey, key(term)));
      if (hit) {
        out += text.slice(cursor, first.start) + hit;
        cursor = last.end;
        corrections.push({ from: phrase, to: hit });
        consumed = n;
      }
    }

    i += consumed === 0 ? 1 : consumed;
  }

  out += text.slice(cursor);
  return { text: out, corrections };
}
