import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  captionsAreOn,
  captionControlLabels,
  markCaptionRegion,
  setCaptionsHidden,
  CAPTION_MARK,
  HIDE_STYLE_ID,
  HIDE_CAPTIONS_CSS,
} from './captions-view.ts';

const dom = (html: string): Document =>
  new JSDOM(`<head></head><body>${html}</body>`).window.document;

// ---------- captionsAreOn ----------

test('a button offering to turn captions off means they are on', () => {
  assert.equal(captionsAreOn(dom('<button aria-label="Turn off captions"></button>')), true);
});

test('a button offering to turn captions on means they are off', () => {
  assert.equal(captionsAreOn(dom('<button aria-label="Turn on captions"></button>')), false);
});

test('the wording "live captions" is understood too', () => {
  assert.equal(captionsAreOn(dom('<button aria-label="Turn off live captions"></button>')), true);
  assert.equal(captionsAreOn(dom('<button aria-label="Turn on live captions"></button>')), false);
});

test('casing does not matter', () => {
  assert.equal(captionsAreOn(dom('<button aria-label="TURN OFF CAPTIONS"></button>')), true);
});

test('no captions button at all is unknown, not off', () => {
  // Before the call UI has rendered there is no button, and guessing "off"
  // would make the extension click something that is not there yet.
  assert.equal(captionsAreOn(dom('<div></div>')), null);
});

test('a captions button whose label says neither is unknown', () => {
  assert.equal(captionsAreOn(dom('<button aria-label="Captions settings"></button>')), null);
});

test('a pressed toggle means captions are on, whatever the label says', () => {
  // Measured in a real call: with the side panel open the Meet window is
  // narrow and the toolbar collapses, so the control that survives may be a
  // plain "Captions" button or a menu entry with no "turn on/off" wording.
  assert.equal(captionsAreOn(dom('<button aria-label="Captions" aria-pressed="true"></button>')), true);
  assert.equal(captionsAreOn(dom('<button aria-label="Captions" aria-pressed="false"></button>')), false);
});

test('a checked menu entry counts the same way', () => {
  assert.equal(
    captionsAreOn(dom('<div role="menuitemcheckbox" aria-label="Captions" aria-checked="true"></div>')),
    true,
  );
  assert.equal(
    captionsAreOn(dom('<div role="menuitemcheckbox" aria-label="Captions" aria-checked="false"></div>')),
    false,
  );
});

test('the explicit wording wins over a state attribute elsewhere', () => {
  const doc = dom(
    '<button aria-label="Captions settings" aria-pressed="true"></button>' +
      '<button aria-label="Turn on captions"></button>',
  );
  assert.equal(captionsAreOn(doc), false);
});

test('controls that only mention captions in passing are not toggles', () => {
  // A jump-to-latest button and a settings entry both carry "captions" and
  // neither says anything about whether captions are on.
  assert.equal(
    captionsAreOn(dom('<button aria-label="Jump to most recent captions" aria-pressed="true"></button>')),
    null,
  );
  assert.equal(
    captionsAreOn(dom('<button aria-label="Caption language settings" aria-pressed="true"></button>')),
    null,
  );
});

// ---------- captionControlLabels ----------

test('every caption-ish control is listed, for the diagnostic', () => {
  // When detection fails, the only useful question is what was actually on
  // the page. Guessing at Meet's wording twice in a row is how a whole call
  // gets wasted.
  const doc = dom(
    '<button aria-label="Turn on captions (c)"></button>' +
      '<button aria-label="Jump to most recent captions"></button>' +
      '<div role="button" aria-label="Chat with everyone"></div>' +
      '<div role="region" aria-label="Captions"></div>',
  );
  assert.deepEqual(captionControlLabels(doc), [
    'Turn on captions (c)',
    'Jump to most recent captions',
  ]);
});

test('the same label twice is listed once', () => {
  const doc = dom(
    '<button aria-label="Turn on captions"></button><button aria-label="Turn on captions"></button>',
  );
  assert.deepEqual(captionControlLabels(doc), ['Turn on captions']);
});

test('no caption controls at all is an empty list, not a failure', () => {
  assert.deepEqual(captionControlLabels(dom('<button aria-label="Chat"></button>')), []);
});

test('a keyboard hint in the label does not stop detection', () => {
  assert.equal(captionsAreOn(dom('<button aria-label="Turn on captions (c)"></button>')), false);
});

// ---------- setCaptionsHidden ----------

test('hiding adds a stylesheet', () => {
  const doc = dom('');
  setCaptionsHidden(doc, true);
  assert.ok(doc.getElementById(HIDE_STYLE_ID));
});

test('showing again removes it', () => {
  const doc = dom('');
  setCaptionsHidden(doc, true);
  setCaptionsHidden(doc, false);
  assert.equal(doc.getElementById(HIDE_STYLE_ID), null);
});

test('hiding twice does not add two stylesheets', () => {
  const doc = dom('');
  setCaptionsHidden(doc, true);
  setCaptionsHidden(doc, true);
  assert.equal(doc.querySelectorAll(`#${HIDE_STYLE_ID}`).length, 1);
});

test('showing when nothing was hidden is harmless', () => {
  const doc = dom('');
  setCaptionsHidden(doc, false);
  assert.equal(doc.getElementById(HIDE_STYLE_ID), null);
});

test('the rule targets the marked element and nothing else', () => {
  assert.match(HIDE_CAPTIONS_CSS, new RegExp(`\\[${CAPTION_MARK}\\]`));
});

test('the rule never selects by label', () => {
  // It used to, and it matched Meet's own "Captions and translation" dialog:
  // a role="dialog" whose label contains "aption", parked off screen with
  // pointer-events: none, so the user could not reach the switch that turns
  // captions on. A selector written from a guess eventually matches
  // something else.
  assert.equal(/aria-label/i.test(HIDE_CAPTIONS_CSS), false);
});

test('marking an element is what makes it hidden', () => {
  const doc = dom('<div id="region" role="region" aria-label="Captions"></div>');
  const region = doc.getElementById('region')!;

  markCaptionRegion(doc, region);
  assert.equal(region.getAttribute(CAPTION_MARK), 'true');
});

test('a settings dialog is left alone', () => {
  const doc = dom(
    '<div id="dialog" role="dialog" aria-label="Captions and translation"></div>' +
      '<div id="region" role="region" aria-label="Captions"></div>',
  );

  markCaptionRegion(doc, doc.getElementById('region'));
  assert.equal(doc.getElementById('dialog')!.hasAttribute(CAPTION_MARK), false);
});

test('the mark moves rather than accumulating', () => {
  // Meet rebuilds the caption container, and a stale mark would leave an
  // orphaned piece of the page parked off screen for the rest of the call.
  const doc = dom('<div id="old"></div><div id="new"></div>');

  markCaptionRegion(doc, doc.getElementById('old'));
  markCaptionRegion(doc, doc.getElementById('new'));

  assert.equal(doc.getElementById('old')!.hasAttribute(CAPTION_MARK), false);
  assert.equal(doc.getElementById('new')!.getAttribute(CAPTION_MARK), 'true');
  assert.equal(doc.querySelectorAll(`[${CAPTION_MARK}]`).length, 1);
});

test('marking nothing unhides everything', () => {
  const doc = dom('<div id="old"></div>');
  markCaptionRegion(doc, doc.getElementById('old'));
  markCaptionRegion(doc, null);
  assert.equal(doc.querySelectorAll(`[${CAPTION_MARK}]`).length, 0);
});

test('the caption region is moved off screen, not removed from the layout', () => {
  // display:none or visibility:hidden can stop a browser updating a subtree,
  // and the whole point is that Meet keeps writing captions into it while the
  // user cannot see them.
  assert.equal(/display\s*:\s*none/i.test(HIDE_CAPTIONS_CSS), false);
  assert.equal(/visibility\s*:\s*hidden/i.test(HIDE_CAPTIONS_CSS), false);
  assert.match(HIDE_CAPTIONS_CSS, /position\s*:\s*fixed/i);
});

test('the rule keeps a real size so Meet keeps filling it', () => {
  assert.match(HIDE_CAPTIONS_CSS, /width\s*:\s*\d/);
  assert.match(HIDE_CAPTIONS_CSS, /height\s*:\s*\d/);
});

test('the hidden region cannot swallow clicks', () => {
  assert.match(HIDE_CAPTIONS_CSS, /pointer-events\s*:\s*none/i);
});

test('the rules are forced, since Meet styles the region itself', () => {
  assert.ok(HIDE_CAPTIONS_CSS.split('!important').length > 4, 'expected !important on each rule');
});
