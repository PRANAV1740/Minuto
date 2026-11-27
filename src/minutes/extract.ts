/**
 * Pulls candidate decisions, actions and open questions out of a transcript,
 * by rule, with citations.
 *
 * This is the "extract" of extract-then-abstract (docs/ACCURACY.md §5). The
 * model that writes the minutes never sees a blank page: it is handed real
 * sentences that were actually said, each already carrying the segment it came
 * from. That is what makes every claim in the finished minutes traceable, and
 * it is why a hallucinated action item has nowhere to enter from.
 *
 * It is also the **fallback when there is no model at all** — no API key, or a
 * free-tier quota spent. The output is blunter than a written summary but it is
 * honest and complete enough to circulate, which means Minuto never fully
 * stops working (docs/ARCHITECTURE.md §5).
 *
 * Rules, not a model, on purpose: cue phrases cannot invent content, and when
 * they misfire the mistake is inspectable rather than mysterious.
 */

import type { Segment } from './validate.ts';

export type CandidateKind = 'decision' | 'action' | 'question';

export type Candidate = {
  kind: CandidateKind;
  text: string;
  sourceSeqs: number[];
  ownerName: string | null;
  dueHint: string | null;
  confidence: 'high' | 'medium' | 'low';
};

/** A group settling on something. */
const DECISION_CUE =
  /\b(we'?ll|we will|we are going to|we're going to|let'?s go with|let us go with|decided|agreed|settled on|final decision|going with)\b/i;

/** Somebody taking something on. */
const FIRST_PERSON_CUE = /\bI(?:'ll| will| shall| can take| will take)\b/i;
const NAMED_CUE = /\b([A-Z][a-z]+)\s+(?:will|to)\b/;
const REQUEST_CUE = /\bcan (?:someone|somebody|you|we)\b|\bplease\b/i;
const EXPLICIT_ACTION_CUE = /\baction item\b|\btodo\b|\bto-do\b/i;

const STRONG_DECISION = /\b(decided|agreed|settled on|final decision)\b/i;

const WEEKDAY = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const RELATIVE_DAY = /\b(today|tonight|tomorrow)\b/i;
const RELATIVE_SPAN = /\bnext (week|month|sprint|quarter|monday|friday)\b/i;

/** Words that look like a name to NAMED_CUE but never own a task. */
const NOT_A_PERSON =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|the|this|that|there|they|we|it|he|she|i|and|but|so|then|next|also|please|action)$/i;

/** Shorter than this, a question is filler ("Right?", "Yeah?"). */
const MIN_QUESTION_WORDS = 3;

export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*/gu) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '');
}

/**
 * The first time reference in a sentence, as written. Resolving it to a real
 * date needs the meeting's own date, so that is left to the caller.
 */
export function findDueHint(text: string): string | null {
  for (const pattern of [ISO_DATE, WEEKDAY, RELATIVE_DAY, RELATIVE_SPAN]) {
    const match = pattern.exec(text);
    if (match) return match[0];
  }
  return null;
}

function namedOwner(sentence: string): string | null {
  const match = NAMED_CUE.exec(sentence);
  if (!match) return null;

  const name = match[1]!;
  return NOT_A_PERSON.test(name) ? null : name;
}

function classify(sentence: string): CandidateKind | null {
  // Decision first: a sentence can carry both ("We'll ship, and I will tell
  // the team"), and the group's decision is the headline. Checking in order
  // also guarantees one candidate per sentence rather than two.
  if (DECISION_CUE.test(sentence)) return 'decision';

  if (
    FIRST_PERSON_CUE.test(sentence) ||
    namedOwner(sentence) !== null ||
    REQUEST_CUE.test(sentence) ||
    EXPLICIT_ACTION_CUE.test(sentence)
  ) {
    return 'action';
  }

  if (sentence.trim().endsWith('?')) {
    const words = sentence.split(/\s+/u).filter((word) => word !== '').length;
    return words >= MIN_QUESTION_WORDS ? 'question' : null;
  }

  return null;
}

function actionConfidence(owner: string | null, due: string | null): Candidate['confidence'] {
  if (owner && due) return 'high';
  if (owner) return 'medium';
  return 'low';
}

export function extractCandidates(segments: readonly Segment[]): Candidate[] {
  const found: Candidate[] = [];

  for (const segment of segments) {
    for (const sentence of splitSentences(segment.text)) {
      const kind = classify(sentence);
      if (kind === null) continue;

      const dueHint = findDueHint(sentence);

      // A named person beats the speaker: "Asha will book it" said by Pranav
      // is Asha's task. Only a first-person commitment belongs to whoever
      // said it, and an unnamed speaker leaves it unassigned rather than
      // guessed (docs/ACCURACY.md §5).
      let ownerName: string | null = null;
      if (kind === 'action') {
        ownerName =
          namedOwner(sentence) ??
          (FIRST_PERSON_CUE.test(sentence) ? segment.speakerName ?? null : null);
      }

      found.push({
        kind,
        text: sentence,
        sourceSeqs: [segment.seq],
        ownerName,
        dueHint,
        confidence:
          kind === 'decision'
            ? STRONG_DECISION.test(sentence)
              ? 'high'
              : 'medium'
            : kind === 'action'
              ? actionConfidence(ownerName, dueHint)
              : 'medium',
      });
    }
  }

  return found;
}
