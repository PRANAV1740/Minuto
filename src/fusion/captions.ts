/**
 * Turns the raw stream of Google Meet caption mutations into clean lines.
 *
 * Meet does not append captions, it **rewrites them in place**: a line appears
 * as "so", becomes "so we", then "so we will ship the demo", each as a
 * mutation of the same node. A MutationObserver that appends every version
 * produces a transcript with each sentence repeated three or four times in
 * growing fragments — the single most damaging bug in reading captions, and
 * the reason this has a module and a test suite of its own
 * (docs/ACCURACY.md §2, step 1).
 *
 * Revisions are matched per speaker, not globally, because two people talking
 * in turn interleave their updates.
 */

export type CaptionLine = {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
};

export type NormaliseOptions = {
  /** How long a line stays open to revision. */
  reviseWindowMs?: number;
  /** Share of the shorter line's words that must agree to count as a revision. */
  agreement?: number;
};

const DEFAULTS = { reviseWindowMs: 4000, agreement: 0.6 } as const;

function words(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return cleaned === '' ? [] : cleaned.split(' ');
}

/**
 * Whether `next` is a rewrite of `previous` rather than something new.
 *
 * A pure extension is the common case. The rest covers the recogniser changing
 * its mind mid-line ("the demo" becoming "the Geodesis demo"), which is not a
 * prefix match but is obviously the same line.
 */
function isRevision(previous: string, next: string, agreement: number): boolean {
  const a = words(previous);
  const b = words(next);
  if (a.length === 0 || b.length === 0) return false;

  const [longer, shorter] = b.length >= a.length ? [b, a] : [a, b];

  let common = 0;
  while (common < shorter.length && shorter[common] === longer[common]) common++;

  if (common === shorter.length) return true;
  return common >= Math.max(1, Math.floor(shorter.length * agreement));
}

export function normaliseCaptions(
  lines: readonly CaptionLine[],
  options: NormaliseOptions = {},
): CaptionLine[] {
  const reviseWindowMs = options.reviseWindowMs ?? DEFAULTS.reviseWindowMs;
  const agreement = options.agreement ?? DEFAULTS.agreement;

  const kept: CaptionLine[] = [];
  const openBySpeaker = new Map<string, number>();

  for (const raw of lines) {
    const text = raw.text.trim();
    if (text === '') continue;

    const at = openBySpeaker.get(raw.speaker);
    const open = at === undefined ? undefined : kept[at];

    if (
      open !== undefined &&
      at !== undefined &&
      raw.startMs - open.startMs <= reviseWindowMs &&
      isRevision(open.text, text, agreement)
    ) {
      // Keep the fuller wording: the recogniser sometimes retracts before it
      // settles, and dropping words it already heard would cost accuracy.
      const fuller = words(text).length >= words(open.text).length ? text : open.text;

      kept[at] = {
        speaker: raw.speaker,
        startMs: Math.min(open.startMs, raw.startMs),
        endMs: Math.max(open.endMs, raw.endMs),
        text: fuller,
      };
      continue;
    }

    kept.push({ ...raw, text });
    openBySpeaker.set(raw.speaker, kept.length - 1);
  }

  return kept.sort((a, b) => a.startMs - b.startMs);
}
