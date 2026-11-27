/**
 * The "abstract" half of extract-then-abstract: a model turns extracted
 * sentences into readable minutes (docs/ACCURACY.md §5).
 *
 * The model is handed **only the candidates**, never the transcript. That is
 * the central safeguard: it cannot summarise small talk into a decision,
 * because it never sees the small talk, and it cannot cite a segment it was
 * not given. Everything it returns is then filtered against the list of
 * segment numbers it was allowed to cite, and what survives still goes through
 * the citation and grounding gates in validate.ts.
 *
 * The model boundary is a function, so all of this is tested without a key and
 * swapping providers touches one adapter.
 *
 * Model output is parsed defensively rather than trusted. Models wrap JSON in
 * fences, add a cheerful sentence before it, write "Unassigned" where null was
 * asked for, and invent due dates like "sometime next week". Each of those is
 * normalised, and one malformed item is dropped on its own instead of losing
 * the whole summary.
 */

import { extractCandidates, type Candidate } from './extract.ts';
import type { DraftActionItem, DraftDecision, DraftMinutes, Segment } from './validate.ts';

export type Prompt = {
  system: string;
  user: string;
};

export type Completer = (prompt: Prompt) => Promise<string>;

export type AbstractOptions = {
  title?: string;
  meetingDate?: string;
};

export type AbstractResult = {
  minutes: DraftMinutes;
  /** What the model produced that was refused, and why. */
  rejected: string[];
};

const SYSTEM = `You write minutes of meetings.

You will be given sentences taken verbatim from a meeting transcript, each
tagged with the segment number it came from. Write the minutes using ONLY
those sentences as evidence.

Rules:
- Never invent a decision, task, name, number or date that is not in the
  sentences given. If something is unclear, leave it out.
- Every decision and action item must cite the segment numbers it came from,
  and only numbers from the allowed list.
- Rewrite the sentences into clear, plain minutes. Do not quote them verbatim
  and do not pad them.
- If an owner is not clearly stated, use null. Never guess who owns a task.
- Use null for a due date unless an actual date can be worked out. Format a
  date as YYYY-MM-DD.
- Reply with JSON only, no commentary.

JSON shape:
{
  "title": string,
  "summary": string,
  "topics": [{ "heading": string, "points": [string] }],
  "decisions": [{ "decision": string, "rationale": string|null, "sourceSeqs": [number] }],
  "actionItems": [{ "task": string, "ownerName": string|null, "dueDate": string|null,
                    "confidence": "high"|"medium"|"low", "sourceSeqs": [number] }],
  "openQuestions": [string]
}`;

const LABELS: Record<Candidate['kind'], string> = {
  decision: 'decision',
  action: 'action',
  question: 'question',
};

export function allowedSeqsFor(candidates: readonly Candidate[]): number[] {
  return [...new Set(candidates.flatMap((candidate) => candidate.sourceSeqs))].sort((a, b) => a - b);
}

export function buildAbstractPrompt(
  candidates: readonly Candidate[],
  options: AbstractOptions,
): Prompt {
  const allowed = allowedSeqsFor(candidates);

  const lines = candidates.map((candidate) => {
    const owner = candidate.ownerName ? ` (said to be ${candidate.ownerName}'s)` : '';
    const due = candidate.dueHint ? ` (mentions "${candidate.dueHint}")` : '';
    return `- [${LABELS[candidate.kind]}] #${candidate.sourceSeqs.join(',#')}${owner}${due}: ${candidate.text}`;
  });

  const context = [
    options.title ? `Meeting title: ${options.title}` : null,
    options.meetingDate ? `Meeting date: ${options.meetingDate}` : null,
  ].filter((line): line is string => line !== null);

  const user = [
    ...context,
    '',
    `Segment numbers you may cite: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
    '',
    lines.length > 0 ? 'Sentences from the meeting:' : 'No decisions or tasks were detected in this meeting.',
    ...lines,
  ].join('\n');

  return { system: SYSTEM, user };
}

// ------------------------------------------------------------------ parsing

const PLACEHOLDER_OWNER = /^(null|none|unassigned|unknown|n\/a|na|tbd|tba|-|—)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter((item): item is string => item !== null);
}

function seqList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
}

function owner(value: unknown): string | null {
  const name = text(value);
  if (name === null) return null;
  return PLACEHOLDER_OWNER.test(name) ? null : name;
}

function dueDate(value: unknown): string | null {
  const date = text(value);
  return date !== null && ISO_DATE.test(date) ? date : null;
}

function confidence(value: unknown): DraftActionItem['confidence'] {
  const level = text(value)?.toLowerCase();
  return level === 'high' || level === 'low' ? level : 'medium';
}

/** Pulls the JSON object out of whatever the model wrapped it in. */
export function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const body = fenced ? fenced[1]! : raw;

  const open = body.indexOf('{');
  const close = body.lastIndexOf('}');
  if (open === -1 || close <= open) {
    throw new Error('the model returned no JSON object');
  }

  try {
    return JSON.parse(body.slice(open, close + 1)) as unknown;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`the model returned invalid JSON: ${reason}`);
  }
}

/**
 * Checks an item's citations against the segments the model was allowed to
 * cite. An item citing nothing, or citing something it was never shown, is an
 * invention and is refused by name.
 */
function citationProblem(
  seqs: readonly number[],
  allowed: ReadonlySet<number>,
  label: string,
  what: string,
): string | null {
  if (seqs.length === 0) return `${label} has no citation: "${what}"`;

  const stray = seqs.find((seq) => !allowed.has(seq));
  if (stray !== undefined) {
    return `${label} cites segment ${stray}, which was not provided: "${what}"`;
  }

  return null;
}

export type ItemSet = {
  decisions: DraftDecision[];
  actionItems: DraftActionItem[];
  openQuestions: string[];
};

export type ParsedItems = ItemSet & { rejected: string[] };

/**
 * Reads the cited items out of a model reply and refuses any whose citations
 * were not in what it was shown. Shared by the single-pass path and the
 * per-chunk map passes.
 */
export function parseItems(
  parsed: Record<string, unknown>,
  allowedSeqs: readonly number[],
): ParsedItems {
  const allowed = new Set(allowedSeqs);
  const rejected: string[] = [];

  const decisions: DraftDecision[] = [];
  for (const item of Array.isArray(parsed.decisions) ? parsed.decisions : []) {
    if (!isRecord(item)) continue;
    const decision = text(item.decision);
    if (decision === null) continue;

    const sourceSeqs = seqList(item.sourceSeqs);
    const problem = citationProblem(sourceSeqs, allowed, 'decision', decision);
    if (problem) {
      rejected.push(problem);
      continue;
    }

    decisions.push({ decision, rationale: text(item.rationale), sourceSeqs });
  }

  const actionItems: DraftActionItem[] = [];
  for (const item of Array.isArray(parsed.actionItems) ? parsed.actionItems : []) {
    if (!isRecord(item)) continue;
    const task = text(item.task);
    if (task === null) continue;

    const sourceSeqs = seqList(item.sourceSeqs);
    const problem = citationProblem(sourceSeqs, allowed, 'action item', task);
    if (problem) {
      rejected.push(problem);
      continue;
    }

    actionItems.push({
      task,
      ownerName: owner(item.ownerName),
      dueDate: dueDate(item.dueDate),
      confidence: confidence(item.confidence),
      sourceSeqs,
    });
  }

  return { decisions, actionItems, openQuestions: stringList(parsed.openQuestions), rejected };
}

/** Topic headings, dropping any without a heading to put the points under. */
export function parseTopics(parsed: Record<string, unknown>): { heading: string; points: string[] }[] {
  return (Array.isArray(parsed.topics) ? parsed.topics : [])
    .filter(isRecord)
    .map((topic) => ({ heading: text(topic.heading), points: stringList(topic.points) }))
    .filter((topic): topic is { heading: string; points: string[] } => topic.heading !== null);
}

export function parseModelMinutes(
  raw: string,
  allowedSeqs: readonly number[],
  speakers: readonly string[] = [],
): AbstractResult {
  const parsed = extractJson(raw);
  if (!isRecord(parsed)) throw new Error('the model returned JSON that is not an object');

  const summary = text(parsed.summary);
  if (summary === null) throw new Error('the model output is missing a summary');

  const items = parseItems(parsed, allowedSeqs);

  return {
    minutes: {
      title: text(parsed.title) ?? 'Meeting minutes',
      summary,
      topics: parseTopics(parsed),
      decisions: items.decisions,
      actionItems: items.actionItems,
      openQuestions: items.openQuestions,
      // Never from the model: who spoke is a fact of the transcript.
      attendeesSpeaking: [...speakers],
    },
    rejected: items.rejected,
  };
}

export { isRecord, text, stringList };

// ------------------------------------------------------------ orchestration

function speakersIn(segments: readonly Segment[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const segment of segments) {
    const name = segment.speakerName?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }

  return out;
}

export async function abstractMinutes(
  segments: readonly Segment[],
  complete: Completer,
  options: AbstractOptions = {},
): Promise<AbstractResult> {
  const candidates = extractCandidates(segments);
  const prompt = buildAbstractPrompt(candidates, options);

  // A failing model propagates: the caller decides whether to fall back to
  // extractive minutes, because that is a product decision, not a parsing one.
  const raw = await complete(prompt);

  return parseModelMinutes(raw, allowedSeqsFor(candidates), speakersIn(segments));
}
