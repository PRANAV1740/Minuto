import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import { outline, captureReport } from './capture-fixture.ts';

const dom = (html: string): Document => new JSDOM(`<body>${html}</body>`).window.document;
const el = (doc: Document, selector: string): Element => {
  const node = doc.querySelector(selector);
  assert.ok(node, `fixture is missing ${selector}`);
  return node;
};

// ---------- outline ----------

test('the tag name is recorded in lower case', () => {
  const doc = dom('<DIV id="x"></DIV>');
  assert.equal(outline(el(doc, '#x')).tag, 'div');
});

test('structural attributes are kept', () => {
  const doc = dom('<div id="x" role="listitem" aria-live="polite" jsname="abc"></div>');
  const shape = outline(el(doc, '#x'));
  assert.equal(shape.attrs.role, 'listitem');
  assert.equal(shape.attrs['aria-live'], 'polite');
  assert.equal(shape.attrs.jsname, 'abc');
});

test('class names are left out as noise', () => {
  const doc = dom('<div id="x" class="aBcD eFgH"></div>');
  assert.equal(outline(el(doc, '#x')).attrs.class, undefined);
});

test('a label describing the interface is kept verbatim', () => {
  const doc = dom('<div id="x" aria-label="Captions"></div>');
  assert.equal(outline(el(doc, '#x')).attrs['aria-label'], 'Captions');
});

test('a label that is somebody name is redacted to its length', () => {
  const doc = dom('<div id="x" aria-label="Pranav Kumar"></div>');
  assert.equal(outline(el(doc, '#x')).attrs['aria-label'], '«redacted:12»');
});

test('a label saying who is speaking keeps the structural word', () => {
  const doc = dom('<div id="x" aria-label="Asha R is speaking"></div>');
  assert.match(outline(el(doc, '#x')).attrs['aria-label']!, /speaking/);
});

test('a participant id value is redacted but its presence recorded', () => {
  const doc = dom('<div id="x" data-participant-id="spaces/abc/devices/xyz"></div>');
  const shape = outline(el(doc, '#x'));
  assert.equal(shape.attrs['data-participant-id'], '«redacted:22»');
});

test('a short flag value is kept because it carries meaning', () => {
  const doc = dom('<div id="x" data-is-speaking="true"></div>');
  assert.equal(outline(el(doc, '#x')).attrs['data-is-speaking'], 'true');
});

test('text is recorded only as a length, never as content', () => {
  const doc = dom('<div id="x">so we will ship the demo</div>');
  const shape = outline(el(doc, '#x'));
  assert.equal(shape.textLength, 24);
  assert.equal(JSON.stringify(shape).includes('ship'), false);
});

test('an element with no text of its own has no length', () => {
  const doc = dom('<div id="x"><span>hello</span></div>');
  assert.equal(outline(el(doc, '#x')).textLength, undefined);
});

test('children are included', () => {
  const doc = dom('<div id="x"><span></span><b></b></div>');
  assert.deepEqual(outline(el(doc, '#x')).children.map((c) => c.tag), ['span', 'b']);
});

test('recursion stops at the depth limit', () => {
  const doc = dom('<div id="x"><div><div><div></div></div></div></div>');
  const shape = outline(el(doc, '#x'), { maxDepth: 2 });
  assert.equal(shape.children[0]!.children.length, 1);
  assert.equal(shape.children[0]!.children[0]!.children.length, 0);
});

test('a long list of children is capped', () => {
  const doc = dom(`<div id="x">${'<span></span>'.repeat(20)}</div>`);
  const shape = outline(el(doc, '#x'), { maxChildren: 5 });
  assert.equal(shape.children.length, 5);
  assert.equal(shape.truncatedChildren, 15);
});

// ---------- captureReport ----------

const MEET_LIKE = `
  <div role="list" aria-label="Participants">
    <div role="listitem">Pranav K</div>
    <div role="listitem">Asha R</div>
  </div>
  <div aria-label="Captions">
    <div><div>Pranav K</div><div>so we will ship the demo</div></div>
  </div>
  <div data-participant-id="p1" aria-label="Pranav K" data-is-speaking="true"></div>
  <button aria-label="Turn off captions"></button>`;

test('the report counts what each candidate selector matched', () => {
  const report = captureReport(dom(MEET_LIKE));
  const live = report.selectorCounts['[data-participant-id]'];
  assert.equal(live, 1);
});

test('the report includes the reader diagnosis for comparison', () => {
  const report = captureReport(dom(MEET_LIKE));
  assert.equal(report.diagnosis.captionRootStrategy, 'aria-label');
  assert.equal(report.diagnosis.rosterCount, 2);
});

test('the report outlines the caption area when one is found', () => {
  const report = captureReport(dom(MEET_LIKE));
  assert.ok(report.captionOutline);
  assert.equal(report.captionOutline?.attrs['aria-label'], 'Captions');
});

test('the report outlines a participant tile when one is found', () => {
  const report = captureReport(dom(MEET_LIKE));
  assert.equal(report.tileOutline?.attrs['data-is-speaking'], 'true');
});

test('the report carries no meeting content', () => {
  const serialised = JSON.stringify(captureReport(dom(MEET_LIKE)));
  assert.equal(serialised.includes('ship the demo'), false);
  assert.equal(serialised.includes('Pranav K'), false);
});

test('a page with nothing to find still produces a report', () => {
  const report = captureReport(dom('<div></div>'));
  assert.equal(report.captionOutline, null);
  assert.equal(report.tileOutline, null);
  assert.ok(report.diagnosis.problems.length > 0);
});
