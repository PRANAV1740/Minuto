import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  captionsAreOn,
  setCaptionsHidden,
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

test('the rule targets the caption region', () => {
  assert.match(HIDE_CAPTIONS_CSS, /\[aria-label\*=.?aption/i);
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
