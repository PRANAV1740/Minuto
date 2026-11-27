/**
 * Assembles minutes from extracted sentences, with no language model involved.
 *
 * This is the floor Minuto never drops below: no API key, a spent free-tier
 * quota, or a provider outage still produces minutes someone can circulate
 * (docs/ARCHITECTURE.md §5). Blunter than written prose — every decision and
 * task is a verbatim sentence rather than a summary — but every line was
 * genuinely said, and every line cites where.
 *
 * It is also the input to the model when there is one. Because the output
 * passes the citation and grounding gates by construction, the gates become a
 * check on what a model *added* rather than on everything at once.
 *
 * Two things it refuses to do without a model: invent topic headings, and write
 * a narrative summary. Both would be fabrication dressed as structure, so the
 * summary states counts and says plainly how it was produced.
 */

import { extractCandidates } from './extract.ts';
import type { DraftActionItem, DraftDecision, DraftMinutes, Segment } from './validate.ts';

export type ExtractiveOptions = {
  title?: string;
  /** The meeting's date as YYYY-MM-DD, used to turn "by Friday" into a date. */
  meetingDate?: string;
};

const DAY_MS = 86_400_000;
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

function parseIsoDate(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;

  // UTC throughout: a local-time parse shifts the date either side of midnight
  // depending on where the user is, which is how due dates end up a day out.
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

const toIsoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Turns a spoken time reference into a real date, relative to the meeting.
 *
 * A named weekday resolves to its next occurrence, counting the meeting's own
 * day — "by Friday" said on a Friday means that day, not a week later.
 * Anything unrecognised resolves to nothing rather than to a guess; the phrase
 * itself stays visible in the task text either way.
 */
export function resolveDueDate(
  hint: string | null | undefined,
  meetingDate: string | undefined,
): string | null {
  if (!hint) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(hint)) return hint;
  if (!meetingDate) return null;

  const base = parseIsoDate(meetingDate);
  if (base === null) return null;

  const lower = hint.toLowerCase();

  const weekday = WEEKDAYS.indexOf(lower as (typeof WEEKDAYS)[number]);
  if (weekday >= 0) {
    const ahead = (weekday - new Date(base).getUTCDay() + 7) % 7;
    return toIsoDate(base + ahead * DAY_MS);
  }

  if (lower === 'today' || lower === 'tonight') return toIsoDate(base);
  if (lower === 'tomorrow') return toIsoDate(base + DAY_MS);
  if (/^next (week|monday|friday|sprint)$/.test(lower)) return toIsoDate(base + 7 * DAY_MS);
  if (lower === 'next month') return toIsoDate(base + 30 * DAY_MS);

  return null;
}

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;

function uniqueSpeakers(segments: readonly Segment[]): string[] {
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

export function buildExtractiveMinutes(
  segments: readonly Segment[],
  options: ExtractiveOptions = {},
): DraftMinutes {
  const candidates = extractCandidates(segments);

  const decisions: DraftDecision[] = candidates
    .filter((candidate) => candidate.kind === 'decision')
    .map((candidate) => ({
      decision: candidate.text,
      rationale: null,
      sourceSeqs: candidate.sourceSeqs,
    }));

  const actionItems: DraftActionItem[] = candidates
    .filter((candidate) => candidate.kind === 'action')
    .map((candidate) => ({
      task: candidate.text,
      ownerName: candidate.ownerName,
      dueDate: resolveDueDate(candidate.dueHint, options.meetingDate),
      confidence: candidate.confidence,
      sourceSeqs: candidate.sourceSeqs,
    }));

  const openQuestions = candidates
    .filter((candidate) => candidate.kind === 'question')
    .map((candidate) => candidate.text);

  return {
    title: options.title ?? 'Meeting minutes',
    summary:
      `${plural(decisions.length, 'decision')}, ${plural(actionItems.length, 'action item')} and ` +
      `${plural(openQuestions.length, 'open question')} extracted from ` +
      `${plural(segments.length, 'transcript segment')}, without a language model.`,
    // Not invented: grouping a transcript into topics is a judgement, and a
    // rule cannot make it honestly.
    topics: [],
    decisions,
    actionItems,
    openQuestions,
    attendeesSpeaking: uniqueSpeakers(segments),
  };
}
