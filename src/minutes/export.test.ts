import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toPlainText, toHtml, escapeHtml } from './export.ts';
import type { DraftMinutes, Segment } from './validate.ts';

const segments: Segment[] = [
  { seq: 1, tStartMs: 62_000, text: 'So we will ship on Friday.', speakerName: 'Pranav K' },
  { seq: 2, tStartMs: 145_000, text: 'I will book the venue.', speakerName: 'Asha R' },
];

function minutes(over: Partial<DraftMinutes> = {}): DraftMinutes {
  return {
    title: 'Weekly sync',
    summary: 'The team agreed a ship date.',
    topics: [],
    decisions: [{ decision: 'Ship on Friday', rationale: null, sourceSeqs: [1] }],
    actionItems: [
      {
        task: 'Book the venue',
        ownerName: 'Asha R',
        dueDate: '2026-12-01',
        confidence: 'high',
        sourceSeqs: [2],
      },
    ],
    openQuestions: [],
    attendeesSpeaking: ['Pranav K', 'Asha R'],
    ...over,
  };
}

// ---------- escapeHtml ----------

test('angle brackets are escaped', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('ampersands are escaped first, not twice', () => {
  assert.equal(escapeHtml('Tom & Jerry <b>'), 'Tom &amp; Jerry &lt;b&gt;');
});

test('quotes are escaped so attributes cannot be broken out of', () => {
  assert.equal(escapeHtml(`"x" 'y'`), '&quot;x&quot; &#39;y&#39;');
});

test('ordinary text passes through unchanged', () => {
  assert.equal(escapeHtml('So we will ship on Friday.'), 'So we will ship on Friday.');
});

// ---------- toPlainText ----------

test('plain text opens with the title', () => {
  const text = toPlainText(minutes(), segments);
  assert.match(text, /^Weekly sync/);
});

test('plain text carries no markdown syntax', () => {
  const text = toPlainText(minutes(), segments);
  for (const token of ['#', '|', '**', '](']) {
    assert.equal(text.includes(token), false, `found markdown token "${token}"`);
  }
});

test('plain text lists the speakers', () => {
  assert.match(toPlainText(minutes(), segments), /Pranav K, Asha R/);
});

test('plain text includes the summary', () => {
  assert.match(toPlainText(minutes(), segments), /The team agreed a ship date\./);
});

test('plain text shows a decision with its timestamp', () => {
  assert.match(toPlainText(minutes(), segments), /Ship on Friday \[1:02\]/);
});

test('plain text shows an action with owner and due date', () => {
  const text = toPlainText(minutes(), segments);
  assert.match(text, /Book the venue/);
  assert.match(text, /Asha R/);
  assert.match(text, /2026-12-01/);
});

test('plain text marks an unassigned task as such', () => {
  const text = toPlainText(
    minutes({
      actionItems: [
        { task: 'Chase it', ownerName: null, dueDate: null, confidence: 'low', sourceSeqs: [1] },
      ],
    }),
    segments,
  );
  assert.match(text, /unassigned/i);
});

test('plain text leaves out sections with nothing in them', () => {
  const text = toPlainText(minutes({ decisions: [], actionItems: [] }), segments);
  assert.equal(/decisions/i.test(text), false);
  assert.equal(/action items/i.test(text), false);
});

test('plain text includes open questions when there are any', () => {
  const text = toPlainText(minutes({ openQuestions: ['Who presents?'] }), segments);
  assert.match(text, /Who presents\?/);
});

// ---------- toHtml ----------

test('html has the title as a heading', () => {
  assert.match(toHtml(minutes(), segments), /<h1[^>]*>Weekly sync<\/h1>/);
});

test('html puts action items in a table', () => {
  const html = toHtml(minutes(), segments);
  assert.match(html, /<table/);
  assert.match(html, /Book the venue/);
});

test('html escapes content from the transcript', () => {
  const html = toHtml(
    minutes({ decisions: [{ decision: '<script>alert(1)</script>', rationale: null, sourceSeqs: [1] }] }),
    segments,
  );
  assert.equal(html.includes('<script>'), false, 'script tag survived into the output');
  assert.match(html, /&lt;script&gt;/);
});

test('html escapes a title too', () => {
  const html = toHtml(minutes({ title: 'Q4 <b>plans</b>' }), segments);
  assert.equal(html.includes('<b>plans</b>'), false);
});

test('html escapes an owner name', () => {
  const html = toHtml(
    minutes({
      actionItems: [
        { task: 'x', ownerName: '<img src=x onerror=1>', dueDate: null, confidence: 'low', sourceSeqs: [1] },
      ],
    }),
    segments,
  );
  assert.equal(html.includes('<img'), false);
});

test('html shows timestamps for citations', () => {
  assert.match(toHtml(minutes(), segments), /1:02/);
});

test('html leaves out sections with nothing in them', () => {
  const html = toHtml(minutes({ decisions: [], actionItems: [] }), segments);
  assert.equal(/<h2[^>]*>Decisions/.test(html), false);
});

test('html is a fragment, not a whole document', () => {
  // It goes on the clipboard and into other documents, so a doctype and a
  // <body> would be wrong in both places.
  const html = toHtml(minutes(), segments);
  assert.equal(/<!doctype|<html|<body/i.test(html), false);
});

test('html uses inline styles so formatting survives a paste', () => {
  assert.match(toHtml(minutes(), segments), /style="/);
});

test('an empty set of minutes still renders a title and summary', () => {
  const bare = minutes({ decisions: [], actionItems: [], openQuestions: [], topics: [] });
  assert.match(toHtml(bare, segments), /Weekly sync/);
  assert.match(toPlainText(bare, segments), /Weekly sync/);
});
