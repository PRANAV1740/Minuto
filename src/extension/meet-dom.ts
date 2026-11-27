/**
 * Every Google Meet DOM assumption in Minuto lives in this one file.
 *
 * Meet's markup uses obfuscated class names that change without notice, so
 * this will break. The point of concentrating it here is that a break is a
 * ten-minute fix in a known place rather than a debugging session, and that
 * `diagnose` can say exactly what stopped matching.
 *
 * Two rules keep it survivable:
 *
 *   1. **Read semantics, not styling.** ARIA labels, live regions, roles and
 *      `data-participant-id` describe what an element *is*, and Google changes
 *      them far less often than class names, because screen readers depend on
 *      them.
 *
 *   2. **Several strategies per reader, most reliable first.** When one stops
 *      matching the next takes over, and the diagnostic reports which one won
 *      — so a silent downgrade is visible instead of looking like bad audio.
 *
 * The roster does real work here: it is what tells a speaker's name apart from
 * the caption text inside a caption entry, with no reliance on which element
 * holds which. Captions are also why `readCaptions` never throws — a page that
 * reads nothing is reported as a problem, not an exception.
 *
 * NOT YET VERIFIED against a live call. Captions only exist inside a real
 * meeting, so the strategies below are reasoned from Meet's accessibility
 * structure rather than captured from it. Run the diagnostic in a real call;
 * whatever it reports is the truth, and this file is where it gets fixed.
 */

export type CaptionEntry = {
  speaker: string;
  text: string;
};

export type Found<T> = {
  value: T;
  strategy: string;
};

export type DomReport = {
  captionRootStrategy: string | null;
  rosterStrategy: string | null;
  rosterCount: number;
  captionsRead: number;
  activeSpeaker: string | null;
  problems: string[];
};

/** Longest a leading text piece can be and still plausibly be a name. */
const MAX_NAME_LENGTH = 40;

const norm = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ').trim();

// ---------------------------------------------------------------- caption root

export function findCaptionRoot(doc: Document): { element: Element; strategy: string } | null {
  // The captions button also carries "captions" in its label, so controls are
  // excluded — otherwise the toggle could be mistaken for the transcript.
  const labelled = [...doc.querySelectorAll('[aria-label]')].find((element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || element.getAttribute('role') === 'button') return false;
    return /caption|subtitle/i.test(element.getAttribute('aria-label') ?? '');
  });
  if (labelled) return { element: labelled, strategy: 'aria-label' };

  // Captions are announced to screen readers, so the transcript sits in a live
  // region even when the labelling changes.
  const live = doc.querySelector('[aria-live="polite"], [aria-live="assertive"]');
  if (live) return { element: live, strategy: 'aria-live' };

  return null;
}

export function findCaptionToggle(doc: Document): Element | null {
  return (
    [...doc.querySelectorAll('button[aria-label], [role="button"][aria-label]')].find((element) =>
      /caption|subtitle/i.test(element.getAttribute('aria-label') ?? ''),
    ) ?? null
  );
}

// -------------------------------------------------------------------- roster

function uniqueNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of names) {
    const name = raw.trim();
    if (name === '') continue;
    const key = norm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }

  return out;
}

export function findRoster(doc: Document): { names: string[]; strategy: string } | null {
  const list = [...doc.querySelectorAll('[role="list"][aria-label]')].find((element) =>
    /participant|people|attendee/i.test(element.getAttribute('aria-label') ?? ''),
  );

  if (list) {
    const names = uniqueNames(
      [...list.querySelectorAll('[role="listitem"]')].map((item) => item.textContent ?? ''),
    );
    if (names.length > 0) return { names, strategy: 'participant-list' };
  }

  // Participant tiles carry a stable-ish data attribute that many tools rely
  // on, and their label is the person's name.
  const tiles = [...doc.querySelectorAll('[data-participant-id]')];
  if (tiles.length > 0) {
    const names = uniqueNames(
      tiles.map((tile) => tile.getAttribute('aria-label') ?? tile.textContent ?? ''),
    );
    if (names.length > 0) return { names, strategy: 'participant-id' };
  }

  return null;
}

// ------------------------------------------------------------------ captions

/** Visible text pieces inside an entry, in document order. */
function textPieces(element: Element): string[] {
  const pieces: string[] = [];

  for (const node of element.querySelectorAll('*')) {
    const alt = node.getAttribute('alt');
    if (alt && alt.trim() !== '') pieces.push(alt.trim());

    // Leaves only: an ancestor's textContent would repeat its children.
    if (node.children.length === 0) {
      const text = node.textContent?.trim() ?? '';
      if (text !== '') pieces.push(text);
    }
  }

  if (pieces.length === 0) {
    const own = element.textContent?.trim() ?? '';
    if (own !== '') pieces.push(own);
  }

  return pieces;
}

/**
 * Splits one caption entry into speaker and text.
 *
 * The roster is the discriminator: a piece counts as the speaker only when it
 * matches a participant's name *exactly*. A caption beginning with someone's
 * name ("Pranav will prepare the deck") is therefore still caption text, which
 * a positional guess would get wrong.
 */
export function parseCaptionEntry(
  element: Element,
  roster: readonly string[],
): CaptionEntry | null {
  const pieces = textPieces(element);
  if (pieces.length === 0) return null;

  const rosterKeys = new Map(roster.map((name) => [norm(name), name]));
  const speakerPiece = pieces.find((piece) => rosterKeys.has(norm(piece)));

  let speaker: string;
  let rest: string[];

  if (speakerPiece !== undefined) {
    speaker = rosterKeys.get(norm(speakerPiece))!;
    // Drop every copy — the avatar's alt text repeats the name.
    rest = pieces.filter((piece) => norm(piece) !== norm(speakerPiece));
  } else {
    // No roster, or a name not in it. Fall back to position, which needs a
    // short leading piece and something after it.
    if (pieces.length < 2 || pieces[0]!.length > MAX_NAME_LENGTH) return null;
    speaker = pieces[0]!;
    rest = pieces.slice(1);
  }

  const text = rest.join(' ').trim();
  if (text === '') return null;

  return { speaker, text };
}

export function readCaptions(doc: Document, roster: readonly string[]): CaptionEntry[] {
  const root = findCaptionRoot(doc);
  if (!root) return [];

  return [...root.element.children]
    .map((child) => parseCaptionEntry(child, roster))
    .filter((entry): entry is CaptionEntry => entry !== null);
}

// ------------------------------------------------------------ active speaker

/**
 * Who Meet thinks is speaking right now.
 *
 * Sampled a few times a second, this is a better speaker-turn signal than
 * audio diarisation and costs nothing — Meet has already done the work
 * (docs/ACCURACY.md §6).
 */
export function findActiveSpeaker(doc: Document, roster: readonly string[]): string | null {
  const allowed = new Set(roster.map(norm));
  const accept = (name: string | null | undefined): string | null => {
    const value = name?.trim();
    if (!value) return null;
    if (allowed.size > 0 && !allowed.has(norm(value))) return null;
    return value;
  };

  const flagged = doc.querySelector('[data-participant-id][data-is-speaking="true"]');
  if (flagged) {
    const name = accept(flagged.getAttribute('aria-label'));
    if (name) return name;
  }

  for (const tile of doc.querySelectorAll('[data-participant-id]')) {
    const indicator = [...tile.querySelectorAll('[aria-label]')].some((element) =>
      /speaking/i.test(element.getAttribute('aria-label') ?? ''),
    );
    if (!indicator) continue;

    const name = accept(tile.getAttribute('aria-label'));
    if (name) return name;
  }

  return null;
}

// ----------------------------------------------------------------- diagnose

/**
 * The self-test. Run it in a real call: whatever it reports is the truth about
 * Meet's current markup, and the fix goes in this file.
 */
export function diagnose(doc: Document): DomReport {
  const captionRoot = findCaptionRoot(doc);
  const roster = findRoster(doc);
  const names = roster?.names ?? [];
  const captions = readCaptions(doc, names);

  const problems: string[] = [];
  if (!captionRoot) {
    problems.push('no caption container found — are captions switched on?');
  }
  if (!roster) {
    problems.push('no participant roster found — speaker names will be unavailable');
  }
  if (captionRoot && captions.length === 0) {
    problems.push('caption container found but no captions could be read from it');
  }

  return {
    captionRootStrategy: captionRoot?.strategy ?? null,
    rosterStrategy: roster?.strategy ?? null,
    rosterCount: names.length,
    captionsRead: captions.length,
    activeSpeaker: findActiveSpeaker(doc, names),
    problems,
  };
}
