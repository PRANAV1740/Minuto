/**
 * Keeping Meet's captions on without having to look at them.
 *
 * Minuto needs captions switched on, because they are the speaker channel —
 * they know who is talking, which Whisper cannot (docs/ACCURACY.md §2). But
 * Meet's caption panel takes a wide band across the bottom of the call, and
 * nobody wants to sit through a meeting with that in the way.
 *
 * So: switch them on, then take them out of view. Meet keeps writing captions
 * into the DOM, the extension keeps reading them, and the screen stays clear.
 *
 * Two things make this safe to do:
 *
 *   1. **Captions in Meet are a local view setting.** Switching them on
 *      changes nothing for anyone else in the call — no banner, no indicator,
 *      nothing in their window.
 *
 *   2. **The region stays laid out.** It is moved off screen at full size
 *      rather than removed with `display: none`, because a browser can stop
 *      doing work on a subtree it is not painting, and the entire point is
 *      that Meet carries on filling it.
 */

/** The id of the stylesheet this module injects, so it can be taken back out. */
export const HIDE_STYLE_ID = 'minuto-hide-captions';

/**
 * The attribute the content script puts on the transcript, and the only thing
 * the stylesheet below touches.
 *
 * It used to match `[aria-label*="aption"]` with a pile of `:not()` clauses,
 * which is how Minuto came to hide Meet's own "Captions and translation"
 * dialog — a `div[role="dialog"]` whose label contains "aption", moved off
 * screen with `pointer-events: none`, so the user could neither see nor click
 * the switch that turns captions on. A rule written from a guess about what
 * matches will eventually match something else.
 *
 * Marking the element the reader actually chose means the thing that gets
 * hidden and the thing that gets read are the same element, by construction.
 */
export const CAPTION_MARK = 'data-minuto-captions';

/**
 * Moves the marked caption region off screen while leaving it rendered.
 *
 * At full size and `opacity: 0` rather than `display: none`, because a
 * browser can stop doing work on a subtree it is not painting and the entire
 * point is that Meet carries on filling it.
 */
export const HIDE_CAPTIONS_CSS = `
[${CAPTION_MARK}] {
  position: fixed !important;
  left: -20000px !important;
  top: 0px !important;
  width: 960px !important;
  height: 540px !important;
  max-width: 960px !important;
  max-height: 540px !important;
  margin: 0px !important;
  opacity: 0 !important;
  pointer-events: none !important;
  z-index: -1 !important;
}
`.trim();

/**
 * Points the stylesheet at one element, and only that one.
 *
 * Clearing the old mark matters: Meet rebuilds the caption container, and a
 * stale mark would leave an orphaned piece of the page parked off screen for
 * the rest of the call.
 */
export function markCaptionRegion(doc: Document, region: Element | null): void {
  for (const marked of doc.querySelectorAll(`[${CAPTION_MARK}]`)) {
    if (marked !== region) marked.removeAttribute(CAPTION_MARK);
  }

  region?.setAttribute(CAPTION_MARK, 'true');
}

/** Controls, as opposed to the transcript region: anything clickable. */
const CONTROL_SELECTOR =
  'button[aria-label], a[aria-label], [role="button"][aria-label], ' +
  '[role="menuitem"][aria-label], [role="menuitemcheckbox"][aria-label], ' +
  '[role="switch"][aria-label], [role="checkbox"][aria-label]';

const mentionsCaptions = (label: string): boolean => /caption|subtitle/i.test(label);

/**
 * Controls that mention captions but say nothing about whether they are on.
 *
 * Measured in a real call: a "Jump to most recent captions" button sits inside
 * the transcript, and there is a caption-language entry in the settings menu.
 * Treating either as the toggle would make the extension click the wrong thing
 * and then report that captions were on.
 */
const NOT_A_TOGGLE = /jump|most recent|settings|language|translate|position|size/i;

const labelOf = (element: Element): string => element.getAttribute('aria-label') ?? '';

/**
 * Every caption-ish control on the page, by label.
 *
 * This exists for the diagnostic rather than for the logic. When detection
 * fails the only useful question is what was actually on the page, and
 * guessing at Google's wording a second time is how a whole call gets wasted.
 * These are interface labels, never anything anyone said.
 */
export function captionControlLabels(doc: Document): string[] {
  const seen = new Set<string>();

  for (const element of doc.querySelectorAll(CONTROL_SELECTOR)) {
    const label = labelOf(element).trim();
    if (label !== '' && mentionsCaptions(label)) seen.add(label);
  }

  return [...seen];
}

/**
 * The captions toggle, identified by what it offers to do rather than by
 * position — or, when the wording gives nothing away, by the state it reports.
 *
 * Both halves are needed. In a wide window Meet renders a toolbar button
 * labelled "Turn on captions"; in a narrow one — which is what the side panel
 * makes — the toolbar collapses and captions move into a menu, where the entry
 * is labelled "Captions" and carries its state in `aria-checked` instead.
 */
export function findCaptionsToggle(doc: Document): Element | null {
  const controls = [...doc.querySelectorAll(CONTROL_SELECTOR)].filter((element) => {
    const label = labelOf(element);
    return mentionsCaptions(label) && !NOT_A_TOGGLE.test(label);
  });

  const worded = controls.find((element) => /turn\s+(on|off)/i.test(labelOf(element)));
  if (worded) return worded;

  return (
    controls.find(
      (element) =>
        element.hasAttribute('aria-pressed') || element.hasAttribute('aria-checked'),
    ) ?? null
  );
}

/**
 * Whether captions are currently on, or `null` when it cannot be told.
 *
 * `null` is not "off": before the call UI has rendered there is no toggle at
 * all, and treating that as off would make the extension click at nothing and
 * then believe it had switched captions on.
 */
export function captionsAreOn(doc: Document): boolean | null {
  const toggle = findCaptionsToggle(doc);
  if (!toggle) return null;

  const label = labelOf(toggle);
  if (/turn\s+off/i.test(label)) return true;
  if (/turn\s+on/i.test(label)) return false;

  const state = toggle.getAttribute('aria-pressed') ?? toggle.getAttribute('aria-checked');
  if (state === 'true') return true;
  if (state === 'false') return false;

  return null;
}

/** Adds or removes the off-screen rule. Safe to call repeatedly. */
export function setCaptionsHidden(doc: Document, hidden: boolean): void {
  const existing = doc.getElementById(HIDE_STYLE_ID);

  if (!hidden) {
    existing?.remove();
    return;
  }

  if (existing) return;

  const style = doc.createElement('style');
  style.id = HIDE_STYLE_ID;
  style.textContent = HIDE_CAPTIONS_CSS;
  (doc.head ?? doc.documentElement).append(style);
}
