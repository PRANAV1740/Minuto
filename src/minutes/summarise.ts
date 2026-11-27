/**
 * Summarises a meeting of any length, chunking when it has to.
 *
 * Short meeting — which, after rule-based extraction, is nearly all of them —
 * is one model call. A long workshop whose candidates and context exceed the
 * prompt budget is mapped chunk by chunk and then reduced.
 *
 * The reduce step is the design decision worth reading twice: **items are
 * merged deterministically, and the model is asked only for prose.** A second
 * model pass over the collected decisions would be a second opportunity to
 * invent one, so it never gets the chance — it writes the title, the summary
 * and the topic headings, while the decisions and tasks are exactly those the
 * map passes produced and the citation filter approved.
 *
 * Duplicates are expected rather than exceptional: the same decision often
 * surfaces in two chunks because it was restated. They merge by normalised
 * wording, keeping every citation and whichever copy knew the owner.
 */

import {
  buildAbstractPrompt,
  extractJson,
  isRecord,
  parseItems,
  parseTopics,
  text,
  type AbstractOptions,
  type AbstractResult,
  type Completer,
  type ItemSet,
  type Prompt,
} from './abstract.ts';
import { chunkCandidates, type Chunk, type ChunkOptions } from './chunk.ts';
import { extractCandidates } from './extract.ts';
import type { DraftActionItem, DraftDecision, Segment } from './validate.ts';

export type SummariseOptions = AbstractOptions & ChunkOptions;

const MAP_SYSTEM = `You are reading part of a meeting transcript.

Return only the decisions, tasks and open questions that are actually present
in the sentences given, each citing the segment numbers it came from in
sourceSeqs. Cite only numbers from the allowed list. Invent nothing: no task,
owner, number or date that is not there. Use null for an owner that is not
clearly stated.

Reply with JSON only:
{
  "decisions": [{ "decision": string, "rationale": string|null, "sourceSeqs": [number] }],
  "actionItems": [{ "task": string, "ownerName": string|null, "dueDate": string|null,
                    "confidence": "high"|"medium"|"low", "sourceSeqs": [number] }],
  "openQuestions": [string]
}`;

const REDUCE_SYSTEM = `You are finishing the minutes of a meeting.

The decisions, tasks and open questions have already been settled and are
given to you. Do not add to them, remove from them or restate them as new
items. Write only:

- a title for the meeting
- one short paragraph summarising it, no more than 120 words
- topic headings with a few points each, grouping what was discussed

Base all of it on the items given. Reply with JSON only:
{ "title": string, "summary": string, "topics": [{ "heading": string, "points": [string] }] }`;

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

const mergeSeqs = (left: readonly number[], right: readonly number[]): number[] =>
  [...new Set([...left, ...right])].sort((a, b) => a - b);

/** Collapses items that say the same thing, keeping every citation. */
export function mergeItems(items: ItemSet): ItemSet {
  const decisions = new Map<string, DraftDecision>();
  for (const decision of items.decisions) {
    const key = normalise(decision.decision);
    const existing = decisions.get(key);

    decisions.set(
      key,
      existing
        ? {
            ...existing,
            rationale: existing.rationale ?? decision.rationale,
            sourceSeqs: mergeSeqs(existing.sourceSeqs, decision.sourceSeqs),
          }
        : decision,
    );
  }

  const actionItems = new Map<string, DraftActionItem>();
  for (const item of items.actionItems) {
    const key = normalise(item.task);
    const existing = actionItems.get(key);

    actionItems.set(
      key,
      existing
        ? {
            ...existing,
            // Whichever copy knew the owner or the date wins; neither is
            // guessed, so a known value beats a null.
            ownerName: existing.ownerName ?? item.ownerName,
            dueDate: existing.dueDate ?? item.dueDate,
            sourceSeqs: mergeSeqs(existing.sourceSeqs, item.sourceSeqs),
          }
        : item,
    );
  }

  const questions = new Map<string, string>();
  for (const question of items.openQuestions) {
    const key = normalise(question);
    if (!questions.has(key)) questions.set(key, question);
  }

  return {
    decisions: [...decisions.values()],
    actionItems: [...actionItems.values()],
    openQuestions: [...questions.values()],
  };
}

function describeChunk(chunk: Chunk, options: AbstractOptions): string {
  const allowed = [...new Set(chunk.candidates.flatMap((c) => c.sourceSeqs))].sort((a, b) => a - b);

  const context = chunk.context.map(
    (segment) => `#${segment.seq} ${segment.speakerName ?? 'Unknown'}: ${segment.text}`,
  );

  const flagged = chunk.candidates.map((candidate) => `- [${candidate.kind}] #${candidate.sourceSeqs.join(',#')}: ${candidate.text}`);

  return [
    options.title ? `Meeting title: ${options.title}` : null,
    options.meetingDate ? `Meeting date: ${options.meetingDate}` : null,
    '',
    `Segment numbers you may cite: ${allowed.length > 0 ? allowed.join(', ') : '(none)'}`,
    '',
    'Transcript of this part:',
    ...context,
    '',
    'Sentences that look like decisions, tasks or questions:',
    ...flagged,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function buildMapPrompt(chunk: Chunk, options: AbstractOptions): Prompt {
  return { system: MAP_SYSTEM, user: describeChunk(chunk, options) };
}

export function buildReducePrompt(items: ItemSet, options: AbstractOptions): Prompt {
  const lines = [
    ...items.decisions.map((decision) => `- decision: ${decision.decision}`),
    ...items.actionItems.map(
      (item) => `- task: ${item.task}${item.ownerName ? ` (${item.ownerName})` : ''}`,
    ),
    ...items.openQuestions.map((question) => `- question: ${question}`),
  ];

  return {
    system: REDUCE_SYSTEM,
    user: [
      options.title ? `Meeting title: ${options.title}` : null,
      options.meetingDate ? `Meeting date: ${options.meetingDate}` : null,
      '',
      lines.length > 0 ? 'What was settled:' : 'Nothing was decided or assigned in this meeting.',
      ...lines,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
  };
}

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

const countsLine = (items: ItemSet): string =>
  `${items.decisions.length} decisions, ${items.actionItems.length} action items and ` +
  `${items.openQuestions.length} open questions were recorded.`;

export async function summariseMinutes(
  segments: readonly Segment[],
  complete: Completer,
  options: SummariseOptions = {},
): Promise<AbstractResult> {
  const candidates = extractCandidates(segments);
  const chunks = chunkCandidates(candidates, segments, options);
  const speakers = speakersIn(segments);

  // One chunk is the common case: ask for the items and the prose together,
  // which is one round trip instead of two.
  if (chunks.length <= 1) {
    const prompt = buildAbstractPrompt(candidates, options);
    const raw = await complete(prompt);

    const parsed = extractJson(raw);
    if (!isRecord(parsed)) throw new Error('the model returned JSON that is not an object');

    const allowed = [...new Set(candidates.flatMap((c) => c.sourceSeqs))];
    const items = parseItems(parsed, allowed);

    return {
      minutes: {
        title: text(parsed.title) ?? 'Meeting minutes',
        // A single pass may omit the prose; the items are what matter, so a
        // factual stand-in beats failing the whole run.
        summary: text(parsed.summary) ?? countsLine(items),
        topics: parseTopics(parsed),
        decisions: items.decisions,
        actionItems: items.actionItems,
        openQuestions: items.openQuestions,
        attendeesSpeaking: speakers,
      },
      rejected: items.rejected,
    };
  }

  // ---- map ----
  const collected: ItemSet = { decisions: [], actionItems: [], openQuestions: [] };
  const rejected: string[] = [];

  for (const chunk of chunks) {
    const raw = await complete(buildMapPrompt(chunk, options));

    const parsed = extractJson(raw);
    if (!isRecord(parsed)) throw new Error(`chunk ${chunk.index} returned JSON that is not an object`);

    const allowed = [...new Set(chunk.candidates.flatMap((c) => c.sourceSeqs))];
    const items = parseItems(parsed, allowed);

    collected.decisions.push(...items.decisions);
    collected.actionItems.push(...items.actionItems);
    collected.openQuestions.push(...items.openQuestions);
    rejected.push(...items.rejected.map((note) => `chunk ${chunk.index}: ${note}`));
  }

  const merged = mergeItems(collected);

  // ---- reduce ----
  const raw = await complete(buildReducePrompt(merged, options));
  const parsed = extractJson(raw);
  if (!isRecord(parsed)) throw new Error('the summary pass returned JSON that is not an object');

  return {
    minutes: {
      title: text(parsed.title) ?? options.title ?? 'Meeting minutes',
      summary: text(parsed.summary) ?? countsLine(merged),
      topics: parseTopics(parsed),
      // From the map passes, not from the reduce: the model finishing the
      // minutes cannot add a decision nobody made.
      decisions: merged.decisions,
      actionItems: merged.actionItems,
      openQuestions: merged.openQuestions,
      attendeesSpeaking: speakers,
    },
    rejected,
  };
}
