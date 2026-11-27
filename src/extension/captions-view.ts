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
 * Moves the caption region off screen while leaving it rendered.
 *
 * `:not(button)` and friends matter: four elements in a real call carry
 * "caption" in their label, and two of them are the CC toggle and a menu
 * entry. Hiding those would take away the user's own control over captions,
 * which is the opposite of helpful.
 */
export const HIDE_CAPTIONS_CSS = `
[aria-label*="aption"]:not(button):not(a):not([role="button"]):not([role="menuitem"]),
[aria-label*="ubtitle"]:not(button):not(a):not([role="button"]):not([role="menuitem"]) {
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
 * The CC toggle, identified by what it offers to do rather than by position.
 *
 * Measured in a real call: several controls carry "caption" in their label,
 * including a "Jump to most recent captions" button inside the transcript. The
 * toggle is the one that offers to turn captions on or off.
 */
export function findCaptionsToggle(doc: Document): Element | null {
  return (
    [...doc.querySelectorAll('button[aria-label], [role="button"][aria-label]')].find((element) => {
      const label = element.getAttribute('aria-label') ?? '';
      return /caption|subtitle/i.test(label) && /turn\s+(on|off)/i.test(label);
    }) ?? null
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

  const label = toggle.getAttribute('aria-label') ?? '';
  if (/turn\s+off/i.test(label)) return true;
  if (/turn\s+on/i.test(label)) return false;
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
