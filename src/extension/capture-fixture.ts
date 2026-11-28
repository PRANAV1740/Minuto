/**
 * Captures the shape of Meet's DOM without capturing what anybody said.
 *
 * The strategies in meet-dom.ts are reasoned from Meet's accessibility
 * structure rather than measured, because captions only exist inside a real
 * call. This produces the measurement: run it in the console during a meeting
 * and it reports which selectors matched and how the caption area is actually
 * built.
 *
 * **It is designed to be safe to paste into a chat.** Meeting content is
 * personal — what colleagues said, and who they are — so nothing here records
 * text or names:
 *
 *   - text becomes a character count («text:24»), never the text
 *   - an aria-label is kept only when it describes the interface
 *     ("Captions", "is speaking"); anything else, which is where names live,
 *     becomes «redacted:N»
 *   - a data attribute keeps its name always and its value only when it is a
 *     short flag like `true`
 *   - the meeting code is left out of the URL
 *
 * A length and a tag name are enough to write a working strategy: a short
 * piece followed by a long piece is a speaker followed by a caption.
 */

import { diagnose, findCaptionRoot, type DomReport } from './meet-dom.ts';
import { captionControlLabels, captionsAreOn } from './captions-view.ts';

export type Outline = {
  tag: string;
  attrs: Record<string, string>;
  textLength?: number;
  children: Outline[];
  truncatedChildren?: number;
};

export type OutlineOptions = {
  maxDepth?: number;
  maxChildren?: number;
};

export type CaptureReport = {
  capturedAt: string;
  url: string;
  selectorCounts: Record<string, number>;
  diagnosis: DomReport;
  /**
   * Whether Meet's captions are on, and the labels of every control that
   * mentions captions.
   *
   * Interface wording, never anything anyone said — and the one thing a
   * capture could not previously answer. Two calls were spent guessing at
   * Google's phrasing for the CC button; this makes the next one a lookup.
   */
  captionsOn: boolean | null;
  captionControls: string[];
  captionOutline: Outline | null;
  tileOutline: Outline | null;
};

/** Attributes that describe what an element is. Class names are omitted. */
const KEPT_ATTRS = [
  'role',
  'aria-label',
  'aria-live',
  'aria-atomic',
  'aria-relevant',
  'aria-hidden',
  'jsname',
];

/**
 * Words that make a label a description of the UI rather than of a person.
 *
 * The settings vocabulary was added after a capture came back with the one
 * label that mattered reduced to «redacted:32» — the control that turns
 * captions on, inside Meet's own settings dialog. A capture that hides the
 * answer to the question it was taken to answer is worth little, and none of
 * these words appears in anybody's name.
 */
const STRUCTURAL =
  /caption|subtitle|participant|people|attendee|speaking|mute|present|chat|list|camera|microphone|transcript|translat|language|setting|option|tooltip|dialog|turn on|turn off|jump/i;

/** Values short and enumerated enough to carry meaning rather than identity. */
const FLAG_VALUE = /^(true|false|on|off|\d{1,4})$/i;

const redact = (value: string): string => `«redacted:${value.length}»`;

function attributesOf(element: Element): Record<string, string> {
  const attrs: Record<string, string> = {};

  for (const name of KEPT_ATTRS) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    attrs[name] = name === 'aria-label' && !STRUCTURAL.test(value) ? redact(value) : value;
  }

  // Every data-* attribute matters structurally, so the name is always kept.
  for (const attribute of element.attributes) {
    if (!attribute.name.startsWith('data-')) continue;
    attrs[attribute.name] = FLAG_VALUE.test(attribute.value)
      ? attribute.value
      : redact(attribute.value);
  }

  return attrs;
}

/** The element's own text, excluding its children's. */
function ownTextLength(element: Element): number | undefined {
  let text = '';
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue ?? '';
  }
  const trimmed = text.trim();
  return trimmed === '' ? undefined : trimmed.length;
}

export function outline(
  element: Element,
  options: OutlineOptions = {},
  depth = 0,
): Outline {
  const maxDepth = options.maxDepth ?? 4;
  const maxChildren = options.maxChildren ?? 12;

  const shape: Outline = {
    tag: element.tagName.toLowerCase(),
    attrs: attributesOf(element),
    children: [],
  };

  const textLength = ownTextLength(element);
  if (textLength !== undefined) shape.textLength = textLength;

  if (depth >= maxDepth) return shape;

  const children = [...element.children];
  shape.children = children
    .slice(0, maxChildren)
    .map((child) => outline(child, options, depth + 1));

  if (children.length > maxChildren) {
    shape.truncatedChildren = children.length - maxChildren;
  }

  return shape;
}

/** Candidate selectors, with how many elements each one matched. */
const CANDIDATES = [
  '[aria-label*="aption"]',
  '[aria-live]',
  '[aria-live="polite"]',
  '[aria-live="assertive"]',
  '[role="list"][aria-label]',
  '[role="listitem"]',
  '[data-participant-id]',
  '[data-is-speaking]',
  '[data-self-name]',
  '[data-sender-name]',
  'button[aria-label]',
  '[jsname]',
];

export function captureReport(doc: Document): CaptureReport {
  const selectorCounts: Record<string, number> = {};
  for (const selector of CANDIDATES) {
    try {
      selectorCounts[selector] = doc.querySelectorAll(selector).length;
    } catch {
      selectorCounts[selector] = -1;
    }
  }

  const report = diagnose(doc);
  const captionRoot = findCaptionRoot(doc);

  const tile =
    doc.querySelector('[data-participant-id][data-is-speaking]') ??
    doc.querySelector('[data-participant-id]');

  // The meeting code identifies a joinable call, so only its shape is kept.
  const path = doc.location?.pathname ?? '';
  const url = `${doc.location?.host ?? 'unknown'}${
    /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(path) ? '/«code»' : path
  }`;

  return {
    capturedAt: new Date().toISOString(),
    url,
    selectorCounts,
    diagnosis: {
      ...report,
      // The diagnosis names whoever is speaking; the name itself is not needed.
      activeSpeaker: report.activeSpeaker === null ? null : '«redacted»',
    },
    captionsOn: captionsAreOn(doc),
    captionControls: captionControlLabels(doc),
    captionOutline: captionRoot ? outline(captionRoot.element, { maxDepth: 5 }) : null,
    tileOutline: tile ? outline(tile, { maxDepth: 3 }) : null,
  };
}
