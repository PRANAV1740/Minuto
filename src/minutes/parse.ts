/**
 * Parses a pasted transcript into segments.
 *
 * This is the door into Minuto for anyone not running the extension: paste
 * what Meet, Otter, a colleague's notes or your own typing produced, and get
 * minutes. It is also how the pipeline was proved before any capture existed.
 *
 * Accepted shapes, mixed freely:
 *
 *   [1:02] Pranav K: so we will ship on Friday
 *   Asha R: I will prepare the deck
 *   and send it round afterwards        <- continues the line above
 *   just some text with no speaker
 *
 * The speaker test is deliberately strict — at most four words, starting with
 * a capital — because any sentence containing a colon would otherwise have its
 * first clause mistaken for a name, and a wrong speaker is worse than none.
 */

import type { Segment } from './validate.ts';

/** Spacing for segments with no timestamp of their own. */
const ASSUMED_GAP_MS = 5000;

const TIMESTAMP = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*/;
const SPEAKER = /^([^:]{1,40}):\s*/;

function looksLikeName(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed === '') return false;
  if (!/^\p{Lu}/u.test(trimmed)) return false;

  return trimmed.split(/\s+/u).length <= 4;
}

/** `[m:ss]` or `[h:mm:ss]` to milliseconds. */
function timestampToMs(match: RegExpExecArray): number {
  const parts = [match[1], match[2], match[3]].filter((part) => part !== undefined) as string[];

  return parts.length === 3
    ? (Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])) * 1000
    : (Number(parts[0]) * 60 + Number(parts[1])) * 1000;
}

export function parseTranscript(input: string): Segment[] {
  const segments: Segment[] = [];

  for (const raw of input.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === '') continue;

    const stamp = TIMESTAMP.exec(line);
    if (stamp) line = line.slice(stamp[0].length).trim();

    const speakerMatch = SPEAKER.exec(line);
    const speaker = speakerMatch && looksLikeName(speakerMatch[1]!) ? speakerMatch[1]!.trim() : null;
    if (speaker !== null) line = line.slice(speakerMatch![0].length).trim();

    if (line === '') continue;

    // A bare line continues the one above it — wrapped text should not become
    // its own utterance. A timestamp or a speaker always starts a new segment.
    const previous = segments.at(-1);
    if (speaker === null && stamp === null && previous !== undefined) {
      previous.text = `${previous.text} ${line}`;
      continue;
    }

    segments.push({
      seq: segments.length + 1,
      tStartMs: stamp ? timestampToMs(stamp) : segments.length * ASSUMED_GAP_MS,
      text: line,
      ...(speaker === null ? {} : { speakerName: speaker }),
    });
  }

  return segments;
}
