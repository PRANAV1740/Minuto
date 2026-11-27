/**
 * Minutes in the formats people actually paste them into.
 *
 * Markdown (render.ts) is the canonical form, but it reads badly in the places
 * minutes usually end up. Two more renderings, both from the same structured
 * record so none of them can drift:
 *
 *   - **Plain text** for a chat message or a plain email, where Markdown's
 *     pipes and asterisks are noise rather than formatting.
 *
 *   - **HTML** for the clipboard. Pasting rich text into Gmail, Word or a
 *     Google Doc keeps the headings and the table — which is the Google Docs
 *     export, without needing the Docs API, an OAuth scope or a review.
 *
 * Everything here escapes its input. A transcript is whatever people said and
 * whatever the ASR heard; it is not trusted markup, and these strings are
 * pasted into other people's documents and mail clients.
 */

import type { DraftMinutes, Segment } from './validate.ts';
import { formatTimestamp } from './render.ts';

/** Escapes text for HTML. Ampersand first, or the others get double-escaped. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function citations(seqs: readonly number[], segments: readonly Segment[]): string {
  const bySeq = new Map(segments.map((segment) => [segment.seq, segment.tStartMs]));
  const stamps = seqs
    .map((seq) => bySeq.get(seq))
    .filter((ms): ms is number => ms !== undefined)
    .map(formatTimestamp);

  return stamps.length === 0 ? '' : ` [${stamps.join(', ')}]`;
}

// -------------------------------------------------------------- plain text

export function toPlainText(minutes: DraftMinutes, segments: readonly Segment[]): string {
  const blocks: string[] = [minutes.title, '='.repeat(minutes.title.length)];

  if (minutes.attendeesSpeaking.length > 0) {
    blocks.push(`Speakers: ${minutes.attendeesSpeaking.join(', ')}`);
  }

  blocks.push('', minutes.summary);

  if (minutes.topics.length > 0) {
    blocks.push('', 'TOPICS DISCUSSED');
    for (const topic of minutes.topics) {
      blocks.push(`  ${topic.heading}`);
      for (const point of topic.points) blocks.push(`    - ${point}`);
    }
  }

  if (minutes.decisions.length > 0) {
    blocks.push('', 'DECISIONS');
    for (const decision of minutes.decisions) {
      const because = decision.rationale === null ? '' : ` - ${decision.rationale}`;
      blocks.push(`  - ${decision.decision}${because}${citations(decision.sourceSeqs, segments)}`);
    }
  }

  if (minutes.actionItems.length > 0) {
    blocks.push('', 'ACTION ITEMS');
    for (const item of minutes.actionItems) {
      const owner = item.ownerName ?? 'unassigned';
      const due = item.dueDate === null ? '' : `, due ${item.dueDate}`;
      blocks.push(`  - ${item.task} (${owner}${due})${citations(item.sourceSeqs, segments)}`);
    }
  }

  if (minutes.openQuestions.length > 0) {
    blocks.push('', 'OPEN QUESTIONS');
    for (const question of minutes.openQuestions) blocks.push(`  - ${question}`);
  }

  return `${blocks.join('\n')}\n`;
}

// -------------------------------------------------------------------- html

/**
 * Inline styles rather than a stylesheet: a pasted fragment arrives in a mail
 * client or a word processor with no stylesheet to go with it, so anything
 * that is not inline is simply lost.
 */
const STYLE = {
  heading: 'font:600 20px/1.3 system-ui,sans-serif;margin:0 0 6px',
  section: 'font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#667;margin:20px 0 6px',
  body: 'font:14px/1.6 system-ui,sans-serif;margin:0 0 10px',
  meta: 'font:12px/1.5 system-ui,sans-serif;color:#667;margin:0 0 14px',
  list: 'font:14px/1.6 system-ui,sans-serif;margin:0 0 10px;padding-left:20px',
  table: 'border-collapse:collapse;width:100%;font:14px/1.5 system-ui,sans-serif',
  th: 'text-align:left;padding:6px 10px;border-bottom:2px solid #ccd;font-weight:600',
  td: 'text-align:left;padding:6px 10px;border-bottom:1px solid #e3e8ef;vertical-align:top',
  cite: 'color:#667;font-size:12px',
} as const;

export function toHtml(minutes: DraftMinutes, segments: readonly Segment[]): string {
  const parts: string[] = [
    `<h1 style="${STYLE.heading}">${escapeHtml(minutes.title)}</h1>`,
  ];

  if (minutes.attendeesSpeaking.length > 0) {
    parts.push(
      `<p style="${STYLE.meta}">Speakers: ${escapeHtml(minutes.attendeesSpeaking.join(', '))}</p>`,
    );
  }

  parts.push(`<p style="${STYLE.body}">${escapeHtml(minutes.summary)}</p>`);

  if (minutes.topics.length > 0) {
    parts.push(`<h2 style="${STYLE.section}">Topics discussed</h2>`);
    for (const topic of minutes.topics) {
      parts.push(`<p style="${STYLE.body}"><strong>${escapeHtml(topic.heading)}</strong></p>`);
      if (topic.points.length > 0) {
        const points = topic.points.map((point) => `<li>${escapeHtml(point)}</li>`).join('');
        parts.push(`<ul style="${STYLE.list}">${points}</ul>`);
      }
    }
  }

  if (minutes.decisions.length > 0) {
    parts.push(`<h2 style="${STYLE.section}">Decisions</h2>`);
    const items = minutes.decisions
      .map((decision) => {
        const because =
          decision.rationale === null ? '' : ` — ${escapeHtml(decision.rationale)}`;
        const cite = citations(decision.sourceSeqs, segments);
        return `<li>${escapeHtml(decision.decision)}${because}<span style="${STYLE.cite}">${escapeHtml(cite)}</span></li>`;
      })
      .join('');
    parts.push(`<ul style="${STYLE.list}">${items}</ul>`);
  }

  if (minutes.actionItems.length > 0) {
    parts.push(`<h2 style="${STYLE.section}">Action items</h2>`);

    const rows = minutes.actionItems
      .map((item) => {
        const owner = item.ownerName === null ? '<em>unassigned</em>' : escapeHtml(item.ownerName);
        const due = item.dueDate === null ? '—' : escapeHtml(item.dueDate);
        const cite = citations(item.sourceSeqs, segments).trim().replace(/^\[|\]$/g, '') || '—';

        return (
          `<tr><td style="${STYLE.td}">${escapeHtml(item.task)}</td>` +
          `<td style="${STYLE.td}">${owner}</td>` +
          `<td style="${STYLE.td}">${due}</td>` +
          `<td style="${STYLE.td}">${escapeHtml(cite)}</td></tr>`
        );
      })
      .join('');

    parts.push(
      `<table style="${STYLE.table}"><thead><tr>` +
        `<th style="${STYLE.th}">Task</th><th style="${STYLE.th}">Owner</th>` +
        `<th style="${STYLE.th}">Due</th><th style="${STYLE.th}">From</th>` +
        `</tr></thead><tbody>${rows}</tbody></table>`,
    );
  }

  if (minutes.openQuestions.length > 0) {
    parts.push(`<h2 style="${STYLE.section}">Open questions</h2>`);
    const items = minutes.openQuestions
      .map((question) => `<li>${escapeHtml(question)}</li>`)
      .join('');
    parts.push(`<ul style="${STYLE.list}">${items}</ul>`);
  }

  return parts.join('\n');
}
