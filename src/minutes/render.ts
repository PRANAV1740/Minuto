/**
 * Renders validated minutes as Markdown.
 *
 * The structured record is the source of truth and this is one view of it, so
 * the shape of the output cannot drift the way a model writing prose would
 * (docs/ARCHITECTURE.md §5). PDF, email and Google Docs render from the same
 * record rather than from this string.
 *
 * Citations are rendered as timestamps, which is what makes a claim checkable
 * in a few seconds instead of a re-read.
 */

import type { DraftMinutes, Flagged, Segment } from './validate.ts';

export type RenderOptions = {
  flagged?: readonly Flagged[];
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** `m:ss` within the hour, `h:mm:ss` past it. */
export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** Pipes would split a Markdown table cell, so they are escaped. */
const cell = (text: string): string => text.replace(/\|/g, '\\|');

function citation(seqs: readonly number[], bySeq: Map<number, Segment>): string {
  const stamps = seqs
    .map((seq) => bySeq.get(seq))
    .filter((segment): segment is Segment => segment !== undefined)
    .map((segment) => formatTimestamp(segment.tStartMs));

  return stamps.length === 0 ? '' : ` [${stamps.join(', ')}]`;
}

export function renderMinutes(
  minutes: DraftMinutes,
  segments: readonly Segment[],
  options: RenderOptions = {},
): string {
  const bySeq = new Map(segments.map((s) => [s.seq, s]));
  const flagged = options.flagged ?? [];

  const warningFor = (kind: Flagged['kind'], text: string): string => {
    const hits = flagged.filter((f) => f.kind === kind && f.text === text);
    return hits.length === 0
      ? ''
      : ` **(unverified: ${hits.map((f) => f.entity).join(', ')})**`;
  };

  const blocks: string[] = [`# ${minutes.title}`];

  if (minutes.attendeesSpeaking.length > 0) {
    blocks.push(`**Speakers:** ${minutes.attendeesSpeaking.join(', ')}`);
  }

  blocks.push('## Summary', minutes.summary);

  if (minutes.topics.length > 0) {
    blocks.push('## Topics discussed');
    for (const topic of minutes.topics) {
      blocks.push(`### ${topic.heading}`);
      if (topic.points.length > 0) {
        blocks.push(topic.points.map((point) => `- ${point}`).join('\n'));
      }
    }
  }

  if (minutes.decisions.length > 0) {
    blocks.push('## Decisions');
    blocks.push(
      minutes.decisions
        .map((d) => {
          const because = d.rationale ? ` — ${d.rationale}` : '';
          return `- ${d.decision}${because}${citation(d.sourceSeqs, bySeq)}${warningFor('decision', d.decision)}`;
        })
        .join('\n'),
    );
  }

  if (minutes.actionItems.length > 0) {
    blocks.push('## Action items');
    const rows = minutes.actionItems.map((a) => {
      const task = `${cell(a.task)}${warningFor('actionItem', a.task)}`;
      const owner = a.ownerName ? cell(a.ownerName) : '_Unassigned_';
      const due = a.dueDate ?? '—';
      // Citations belong in a column of their own: text after a row's last
      // pipe is not part of the table.
      const from = citation(a.sourceSeqs, bySeq).trim().replace(/^\[|\]$/g, '') || '—';
      return `| ${task} | ${owner} | ${due} | ${from} |`;
    });
    blocks.push(['| Task | Owner | Due | From |', '| --- | --- | --- | --- |', ...rows].join('\n'));
  }

  if (minutes.openQuestions.length > 0) {
    blocks.push('## Open questions');
    blocks.push(minutes.openQuestions.map((q) => `- ${q}`).join('\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}
