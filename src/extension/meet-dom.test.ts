/**
 * These fixtures are APPROXIMATIONS of Google Meet's DOM, not captures of it.
 * Meet's real markup uses obfuscated class names that change, and captions
 * only exist inside a live call, so it could not be captured here.
 *
 * What they do test is the thing worth testing: that each reader works through
 * a list of candidate strategies, picks the most reliable one available, and
 * degrades predictably when a strategy stops matching. When the real markup
 * differs, `diagnose` says so and a strategy is added here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  findCaptionRoot,
  findRoster,
  parseCaptionEntry,
  readCaptions,
  findActiveSpeaker,
  findCaptionToggle,
  diagnose,
} from './meet-dom.ts';

const dom = (html: string): Document => new JSDOM(`<body>${html}</body>`).window.document;
const first = (doc: Document, selector: string): Element => {
  const element = doc.querySelector(selector);
  assert.ok(element, `fixture is missing ${selector}`);
  return element;
};

const ROSTER = ['Pranav K', 'Asha R'];

// ---------- findCaptionRoot ----------

test('a container labelled as captions is found', () => {
  const doc = dom('<div id="c" aria-label="Captions"></div>');
  const found = findCaptionRoot(doc);
  assert.equal(found?.element.id, 'c');
  assert.equal(found?.strategy, 'aria-label');
});

test('a label mentioning captions in any casing is found', () => {
  const doc = dom('<div id="c" aria-label="Turn off live captions"></div>');
  assert.equal(findCaptionRoot(doc)?.element.id, 'c');
});

test('a polite live region is used when no label matches', () => {
  const doc = dom('<div id="c" aria-live="polite"></div>');
  const found = findCaptionRoot(doc);
  assert.equal(found?.element.id, 'c');
  assert.equal(found?.strategy, 'aria-live');
});

test('a labelled container wins over a live region', () => {
  const doc = dom('<div id="live" aria-live="polite"></div><div id="labelled" aria-label="Captions"></div>');
  assert.equal(findCaptionRoot(doc)?.element.id, 'labelled');
});

test('no caption container is reported as missing', () => {
  assert.equal(findCaptionRoot(dom('<div></div>')), null);
});

// Measured in a real call: Meet carries a Material Design screen-reader
// announcer that is an empty aria-live region. Matching it looks like success
// and then reads nothing, which is worse than finding nothing at all.
test('the material design announcer is not mistaken for the caption area', () => {
  const doc = dom('<div id="a" aria-live="polite" aria-atomic="true" data-mdc-dom-announce="true"></div>');
  assert.equal(findCaptionRoot(doc), null);
});

test('a real live region is still found alongside the announcer', () => {
  const doc = dom(`
    <div id="announcer" aria-live="polite" data-mdc-dom-announce="true"></div>
    <div id="real" aria-live="polite"><div><div>Pranav K</div><div>hello there</div></div></div>`);
  assert.equal(findCaptionRoot(doc)?.element.id, 'real');
});

test('a live region with content is preferred over an empty one', () => {
  const doc = dom(`
    <div id="empty" aria-live="polite"></div>
    <div id="full" aria-live="polite"><div>something</div></div>`);
  assert.equal(findCaptionRoot(doc)?.element.id, 'full');
});

test('an empty live region is still better than nothing', () => {
  // Captions switched on but nobody talking yet: the container is there and
  // empty, and attaching to it is correct.
  const doc = dom('<div id="c" aria-live="polite"></div>');
  assert.equal(findCaptionRoot(doc)?.element.id, 'c');
});

// ---------- findRoster ----------

test('names are read from a participants list', () => {
  const doc = dom(`
    <div role="list" aria-label="Participants">
      <div role="listitem">Pranav K</div>
      <div role="listitem">Asha R</div>
    </div>`);
  const found = findRoster(doc);
  assert.deepEqual(found?.names, ROSTER);
  assert.equal(found?.strategy, 'participant-list');
});

test('names are read from participant tiles when there is no list', () => {
  const doc = dom(`
    <div data-participant-id="a" aria-label="Pranav K"></div>
    <div data-participant-id="b" aria-label="Asha R"></div>`);
  const found = findRoster(doc);
  assert.deepEqual(found?.names, ROSTER);
  assert.equal(found?.strategy, 'participant-id');
});

test('repeated names appear once', () => {
  const doc = dom(`
    <div data-participant-id="a" aria-label="Pranav K"></div>
    <div data-participant-id="a2" aria-label="Pranav K"></div>`);
  assert.deepEqual(findRoster(doc)?.names, ['Pranav K']);
});

test('blank names are ignored', () => {
  const doc = dom(`
    <div data-participant-id="a" aria-label="  "></div>
    <div data-participant-id="b" aria-label="Asha R"></div>`);
  assert.deepEqual(findRoster(doc)?.names, ['Asha R']);
});

test('no roster at all is reported as missing', () => {
  assert.equal(findRoster(dom('<div></div>')), null);
});

// ---------- parseCaptionEntry ----------

test('the roster tells the speaker apart from the caption', () => {
  const doc = dom('<div id="e"><div>Pranav K</div><div>so we will ship the demo</div></div>');
  assert.deepEqual(parseCaptionEntry(first(doc, '#e'), ROSTER), {
    speaker: 'Pranav K',
    text: 'so we will ship the demo',
  });
});

test('a name repeated in an avatar label is not mistaken for the caption', () => {
  const doc = dom(
    '<div id="e"><img alt="Pranav K"><span>Pranav K</span><span>so we will ship</span></div>',
  );
  assert.deepEqual(parseCaptionEntry(first(doc, '#e'), ROSTER), {
    speaker: 'Pranav K',
    text: 'so we will ship',
  });
});

test('a caption that merely starts with a name is not read as a speaker', () => {
  const doc = dom('<div id="e"><div>Asha R</div><div>Pranav will prepare the deck</div></div>');
  assert.deepEqual(parseCaptionEntry(first(doc, '#e'), ROSTER), {
    speaker: 'Asha R',
    text: 'Pranav will prepare the deck',
  });
});

test('without a roster the short leading element is taken as the speaker', () => {
  const doc = dom('<div id="e"><div>Ravi M</div><div>I will sort the budget out</div></div>');
  assert.deepEqual(parseCaptionEntry(first(doc, '#e'), []), {
    speaker: 'Ravi M',
    text: 'I will sort the budget out',
  });
});

test('surrounding whitespace is trimmed', () => {
  const doc = dom('<div id="e"><div>  Pranav K </div><div>  so we will ship  </div></div>');
  assert.deepEqual(parseCaptionEntry(first(doc, '#e'), ROSTER), {
    speaker: 'Pranav K',
    text: 'so we will ship',
  });
});

test('an entry with no caption text does not parse', () => {
  const doc = dom('<div id="e"><div>Pranav K</div></div>');
  assert.equal(parseCaptionEntry(first(doc, '#e'), ROSTER), null);
});

test('an empty entry does not parse', () => {
  const doc = dom('<div id="e"></div>');
  assert.equal(parseCaptionEntry(first(doc, '#e'), ROSTER), null);
});

// ---------- readCaptions ----------

test('every entry under the caption root is read', () => {
  const doc = dom(`
    <div aria-label="Captions">
      <div><div>Pranav K</div><div>so we will ship</div></div>
      <div><div>Asha R</div><div>I will book the venue</div></div>
    </div>`);
  assert.deepEqual(readCaptions(doc, ROSTER), [
    { speaker: 'Pranav K', text: 'so we will ship' },
    { speaker: 'Asha R', text: 'I will book the venue' },
  ]);
});

test('entries that do not parse are skipped rather than breaking the read', () => {
  const doc = dom(`
    <div aria-label="Captions">
      <div></div>
      <div><div>Asha R</div><div>I will book the venue</div></div>
    </div>`);
  assert.deepEqual(readCaptions(doc, ROSTER), [{ speaker: 'Asha R', text: 'I will book the venue' }]);
});

test('reading captions with no caption root yields nothing', () => {
  assert.deepEqual(readCaptions(dom('<div></div>'), ROSTER), []);
});

/**
 * Captured from a real Google Meet call on 27 Nov 2026, with captions on.
 * Structure is exactly as the diagnostic reported it; text is stand-in.
 *
 * The third child is Meet's own "Jump to most recent captions" control, whose
 * Material icon ligature is plain text inside the button — so a naive read
 * turns the button into a caption.
 */
const REAL_MEET_CAPTIONS = `
  <div role="region" aria-label="Captions">
    <div>
      <div>
        <img>
        <div><span>Pranav K</span></div>
      </div>
      <div>so we will ship the Geodesis demo on Friday</div>
    </div>
    <div><div></div></div>
    <div>
      <div data-is-touch-wrapper="true">
        <button aria-label="Jump to most recent captions" jsname="Xke7ne">
          <span></span><span></span><span jsname="m9ZlFb"></span><span></span>
          <span jsname="Xr1QTb"><i aria-hidden="true">arrow_downward</i></span>
          <span aria-hidden="true" jsname="V67aGc">arrow_downward</span>
          <span jsname="UkTUqb"></span>
        </button>
      </div>
    </div>
  </div>`;

test('the real Meet caption region is found by its label', () => {
  const found = findCaptionRoot(dom(REAL_MEET_CAPTIONS));
  assert.equal(found?.strategy, 'aria-label');
  assert.equal(found?.element.getAttribute('role'), 'region');
});

test('the real Meet markup yields exactly the one caption in it', () => {
  const entries = readCaptions(dom(REAL_MEET_CAPTIONS), ROSTER);
  assert.deepEqual(entries, [
    { speaker: 'Pranav K', text: 'so we will ship the Geodesis demo on Friday' },
  ]);
});

test('the jump-to-latest control is not read as a caption', () => {
  const entries = readCaptions(dom(REAL_MEET_CAPTIONS), ROSTER);
  assert.equal(
    entries.some((entry) => /arrow_downward|jump/i.test(entry.speaker + entry.text)),
    false,
    'a Meet control leaked into the captions',
  );
});

test('an icon ligature hidden from screen readers is not read as text', () => {
  const doc = dom(`
    <div id="e">
      <div>Pranav K</div>
      <span aria-hidden="true">arrow_downward</span>
      <div>the actual caption</div>
    </div>`);
  assert.equal(parseCaptionEntry(first(doc, '#e'), ROSTER)?.text, 'the actual caption');
});

test('an entry that is only a control does not parse', () => {
  const doc = dom('<div id="e"><button aria-label="Mute">mic_off</button></div>');
  assert.equal(parseCaptionEntry(first(doc, '#e'), ROSTER), null);
});

test('the caption region wins over the captions button sharing its label', () => {
  // Measured: four elements match [aria-label*="aption"] in a live call.
  const doc = dom(`
    <button aria-label="Turn off captions"></button>
    <div id="region" role="region" aria-label="Captions"></div>
    <div aria-label="Caption settings"></div>`);
  assert.equal(findCaptionRoot(doc)?.element.id, 'region');
});

// ---------- findActiveSpeaker ----------

test('a tile marked as speaking gives the active speaker', () => {
  const doc = dom(`
    <div data-participant-id="a" aria-label="Pranav K"><div aria-label="Pranav K is speaking"></div></div>
    <div data-participant-id="b" aria-label="Asha R"></div>`);
  assert.equal(findActiveSpeaker(doc, ROSTER), 'Pranav K');
});

test('a speaking flag on the tile itself is honoured', () => {
  const doc = dom('<div data-participant-id="a" aria-label="Asha R" data-is-speaking="true"></div>');
  assert.equal(findActiveSpeaker(doc, ROSTER), 'Asha R');
});

test('nobody speaking gives no active speaker', () => {
  const doc = dom('<div data-participant-id="a" aria-label="Pranav K"></div>');
  assert.equal(findActiveSpeaker(doc, ROSTER), null);
});

test('a speaking tile naming someone off the roster is ignored', () => {
  const doc = dom('<div data-participant-id="z" aria-label="Someone Else" data-is-speaking="true"></div>');
  assert.equal(findActiveSpeaker(doc, ROSTER), null);
});

// ---------- findCaptionToggle ----------

test('the captions button is found by its label', () => {
  const doc = dom('<button id="t" aria-label="Turn on captions"></button>');
  assert.equal(findCaptionToggle(doc)?.id, 't');
});

test('no captions button is reported as missing', () => {
  assert.equal(findCaptionToggle(dom('<button aria-label="Mute"></button>')), null);
});

// ---------- diagnose ----------

test('a healthy page reports every reader working', () => {
  const doc = dom(`
    <div role="list" aria-label="Participants">
      <div role="listitem">Pranav K</div>
      <div role="listitem">Asha R</div>
    </div>
    <div aria-label="Captions">
      <div><div>Pranav K</div><div>so we will ship</div></div>
    </div>
    <button aria-label="Turn off captions"></button>`);

  const report = diagnose(doc);
  assert.equal(report.captionRootStrategy, 'aria-label');
  assert.equal(report.rosterStrategy, 'participant-list');
  assert.equal(report.rosterCount, 2);
  assert.equal(report.captionsRead, 1);
  assert.deepEqual(report.problems, []);
});

test('a missing caption container is called out as a problem', () => {
  const doc = dom('<div data-participant-id="a" aria-label="Pranav K"></div>');
  const report = diagnose(doc);
  assert.equal(report.captionRootStrategy, null);
  assert.ok(report.problems.some((p) => /caption/i.test(p)));
});

test('a missing roster is called out as a problem', () => {
  const doc = dom('<div aria-label="Captions"></div>');
  assert.ok(diagnose(doc).problems.some((p) => /roster|participant/i.test(p)));
});

test('a caption container holding text we cannot read is a problem', () => {
  const doc = dom(`
    <div data-participant-id="a" aria-label="Pranav K"></div>
    <div aria-label="Captions"><div>unparseable</div></div>`);
  const report = diagnose(doc);
  assert.ok(report.problems.some((p) => /could not be read/i.test(p)));
  assert.equal(report.waitingForSpeech, false);
});

test('an empty caption container is waiting, not broken', () => {
  // Measured in a real call: captions on, nobody speaking, and the region
  // holding only its placeholder and the jump-to-latest button. Calling that
  // a problem cost a whole meeting spent looking for a parsing fault.
  const doc = dom(`
    <div data-participant-id="a" aria-label="Pranav K"></div>
    <div role="region" aria-label="Captions">
      <div><div></div></div>
      <div><div data-is-touch-wrapper="true">
        <button aria-label="Jump to most recent captions">
          <span aria-hidden="true">arrow_downward</span>
        </button>
      </div></div>
    </div>`);

  const report = diagnose(doc);
  assert.equal(report.captionRootStrategy, 'aria-label');
  assert.equal(report.captionsRead, 0);
  assert.equal(report.waitingForSpeech, true);
  assert.deepEqual(report.problems, []);
});

test('captions nested below the region are still read', () => {
  // readCaptions used to take the region's direct children as the entries.
  // That held in one capture and is not a promise Google has made.
  const doc = dom(`
    <div data-participant-id="a" aria-label="Pranav K"></div>
    <div role="region" aria-label="Captions">
      <div><div>
        <div><div><span>Pranav K</span></div><div>we ship on Friday</div></div>
      </div></div>
    </div>`);

  assert.deepEqual(readCaptions(doc, ['Pranav K']), [
    { speaker: 'Pranav K', text: 'we ship on Friday' },
  ]);
});

test('a wrapper holding several entries does not collapse into one', () => {
  // The failure this guards against reads like bad fusion — one speaker
  // credited with everyone's words — rather than like bad DOM reading.
  const doc = dom(`
    <div role="region" aria-label="Captions">
      <div>
        <div><div><span>Pranav K</span></div><div>we ship on Friday</div></div>
        <div><div><span>Asha R</span></div><div>I will do the deck</div></div>
      </div>
    </div>`);

  assert.deepEqual(readCaptions(doc, ['Pranav K', 'Asha R']), [
    { speaker: 'Pranav K', text: 'we ship on Friday' },
    { speaker: 'Asha R', text: 'I will do the deck' },
  ]);
});
