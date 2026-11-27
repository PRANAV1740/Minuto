/**
 * The gates a draft set of minutes must pass before anyone sees it.
 *
 * Two separate checks, with deliberately different consequences
 * (docs/ACCURACY.md §5):
 *
 *   1. Citations — every decision and action item must point at real transcript
 *      segments. One that cites nothing, or cites a segment that does not
 *      exist, is a hallucination and is DROPPED.
 *
 *   2. Grounding — every name and number in a surviving item must appear in the
 *      segments it cites, in who was speaking there, or in the meeting's
 *      glossary. Anything else is FLAGGED, not dropped: the item is probably
 *      real and only its detail is suspect, so it is shown with a warning
 *      rather than silently deleted.
 *
 * Both checks are deterministic. They cost nothing per meeting and they catch
 * the failure that embarrasses you in front of a room: a date or figure that
 * nobody actually said.
 */

export type Segment = {
  seq: number;
  tStartMs: number;
  text: string;
  speakerName?: string;
};

export type DraftActionItem = {
  task: string;
  ownerName: string | null;
  dueDate: string | null;
  confidence: 'high' | 'medium' | 'low';
  sourceSeqs: number[];
};

export type DraftDecision = {
  decision: string;
  rationale: string | null;
  sourceSeqs: number[];
};

export type DraftMinutes = {
  title: string;
  summary: string;
  topics: { heading: string; points: string[] }[];
  decisions: DraftDecision[];
  actionItems: DraftActionItem[];
  openQuestions: string[];
  attendeesSpeaking: string[];
};

export type Dropped = {
  kind: 'decision' | 'actionItem';
  text: string;
  reason: string;
};

export type Flagged = {
  kind: 'decision' | 'actionItem';
  text: string;
  entity: string;
};

export type ValidationResult = {
  minutes: DraftMinutes;
  dropped: Dropped[];
  flagged: Flagged[];
};

const WORD_PATTERN = /[\p{L}][\p{L}\p{N}']*|[\p{N}][\p{L}\p{N}]*/gu;
const NUMBER_PATTERN = /\p{N}[\p{N},.]*\p{N}|\p{N}/gu;
const NAME_PATTERN = /^[\p{Lu}][\p{Ll}]+$/u;

function wordsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(WORD_PATTERN)) {
    out.add(match[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  }
  return out;
}

/** Numbers with thousands separators and trailing punctuation removed. */
function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    out.add(match[0].replace(/[,.]/gu, ''));
  }
  return out;
}

/**
 * Names and numbers worth checking. A capitalised first word is skipped,
 * because sentences start with a capital and "Ship" is not a person.
 */
function entitiesIn(text: string): string[] {
  const found: string[] = [];
  const tokens = [...text.matchAll(WORD_PATTERN)].map((m) => m[0]);

  tokens.forEach((token, index) => {
    if (index > 0 && NAME_PATTERN.test(token)) found.push(token);
  });
  for (const number of numbersIn(text)) found.push(number);

  return [...new Set(found)];
}

type Haystack = {
  words: Set<string>;
  numbers: Set<string>;
};

function haystackFor(
  seqs: readonly number[],
  bySeq: Map<number, Segment>,
  glossary: readonly string[],
): Haystack {
  const parts: string[] = [...glossary];
  for (const seq of seqs) {
    const segment = bySeq.get(seq);
    if (!segment) continue;
    parts.push(segment.text);
    if (segment.speakerName) parts.push(segment.speakerName);
  }
  const joined = parts.join(' ');
  return { words: wordsIn(joined), numbers: numbersIn(joined) };
}

function isGrounded(entity: string, haystack: Haystack): boolean {
  if (/^\p{N}/u.test(entity)) return haystack.numbers.has(entity);

  // A name may be several words ("Ravi M"), and the haystack holds individual
  // words, so every part has to be present. Checking the whole string against
  // a set of words would mean a full name could never be grounded.
  const parts = [...entity.matchAll(WORD_PATTERN)].map((m) =>
    m[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''),
  );
  if (parts.length === 0) return false;

  return parts.every((part) => haystack.words.has(part));
}

function citationProblem(seqs: readonly number[], bySeq: Map<number, Segment>): string | null {
  if (seqs.length === 0) return 'no citation';
  for (const seq of seqs) {
    if (!bySeq.has(seq)) return `cites unknown segment ${seq}`;
  }
  return null;
}

export function validateMinutes(
  draft: DraftMinutes,
  segments: readonly Segment[],
  options: { glossary?: readonly string[] } = {},
): ValidationResult {
  const glossary = options.glossary ?? [];
  const bySeq = new Map(segments.map((s) => [s.seq, s]));

  const dropped: Dropped[] = [];
  const flagged: Flagged[] = [];

  /**
   * `names` are whole values to check as-is (an owner is one name).
   * `prose` is free text to scan for entities, exactly like the item's own
   * text — passing a sentence as a name would flag the whole sentence.
   */
  function check(
    kind: 'decision' | 'actionItem',
    text: string,
    seqs: readonly number[],
    names: readonly (string | null)[],
    prose: readonly (string | null)[] = [],
  ): boolean {
    const problem = citationProblem(seqs, bySeq);
    if (problem) {
      dropped.push({ kind, text, reason: problem });
      return false;
    }

    const haystack = haystackFor(seqs, bySeq, glossary);
    const scanned = [text, ...prose.filter((p): p is string => Boolean(p))].join(' ');
    const candidates = new Set(entitiesIn(scanned));
    for (const value of names) {
      if (value) candidates.add(value);
    }

    for (const entity of candidates) {
      if (!isGrounded(entity, haystack)) {
        flagged.push({ kind, text, entity });
      }
    }
    return true;
  }

  const decisions = draft.decisions.filter((d) =>
    check('decision', d.decision, d.sourceSeqs, [], [d.rationale]),
  );

  const actionItems = draft.actionItems.filter((a) =>
    check('actionItem', a.task, a.sourceSeqs, [a.ownerName]),
  );

  return {
    minutes: { ...draft, decisions, actionItems },
    dropped,
    flagged,
  };
}
