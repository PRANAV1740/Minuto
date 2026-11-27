import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMinutes, formatTimestamp } from './render.ts';
import type { DraftMinutes, Segment } from './validate.ts';

const segments: Segment[] = [
  { seq: 1, tStartMs: 62_000, text: "So we'll ship the Geodesis demo by Friday.", speakerName: 'Pranav' },
  { seq: 2, tStartMs: 3_725_000, text: 'I will take the slide deck.', speakerName: 'Asha' },
];

function minutes(over: Partial<DraftMinutes> = {}): DraftMinutes {
  return {
    title: 'Geodesis weekly sync',
    summary: 'The team agreed to ship the demo on Friday.',
    topics: [],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    attendeesSpeaking: ['Pranav', 'Asha'],
    ...over,
  };
}

test('formatTimestamp renders minutes and seconds', () => {
  assert.equal(formatTimestamp(62_000), '1:02');
});

test('formatTimestamp renders hours past the hour mark', () => {
  assert.equal(formatTimestamp(3_725_000), '1:02:05');
});

test('formatTimestamp renders the start of a call as zero', () => {
  assert.equal(formatTimestamp(0), '0:00');
});

test('the title becomes the heading', () => {
  const md = renderMinutes(minutes(), segments);
  assert.match(md, /^# Geodesis weekly sync$/m);
});

test('the speakers are listed', () => {
  const md = renderMinutes(minutes(), segments);
  assert.match(md, /Pranav, Asha/);
});

test('the summary appears under its own heading', () => {
  const md = renderMinutes(minutes(), segments);
  assert.match(md, /## Summary\n\nThe team agreed to ship the demo on Friday\./);
});

test('action items render as a table with owner and due date', () => {
  const md = renderMinutes(
    minutes({
      actionItems: [
        { task: 'Ship the demo', ownerName: 'Pranav', dueDate: '2026-11-27', confidence: 'high', sourceSeqs: [1] },
      ],
    }),
    segments,
  );
  assert.match(md, /\| Ship the demo \| Pranav \| 2026-11-27 \|/);
});

test('an action item with no owner is shown as unassigned', () => {
  const md = renderMinutes(
    minutes({
      actionItems: [
        { task: 'Book the room', ownerName: null, dueDate: null, confidence: 'medium', sourceSeqs: [1] },
      ],
    }),
    segments,
  );
  assert.match(md, /\| Book the room \| _Unassigned_ \| — \|/);
});

test('a decision carries the timestamp it came from', () => {
  const md = renderMinutes(
    minutes({ decisions: [{ decision: 'Ship on Friday', rationale: null, sourceSeqs: [1] }] }),
    segments,
  );
  assert.match(md, /Ship on Friday.*\[1:02\]/);
});

test('a decision citing several moments lists each timestamp', () => {
  const md = renderMinutes(
    minutes({ decisions: [{ decision: 'Ship on Friday', rationale: null, sourceSeqs: [1, 2] }] }),
    segments,
  );
  assert.match(md, /\[1:02, 1:02:05\]/);
});

test('a rationale is included when present', () => {
  const md = renderMinutes(
    minutes({ decisions: [{ decision: 'Ship on Friday', rationale: 'The deck is ready', sourceSeqs: [1] }] }),
    segments,
  );
  assert.match(md, /The deck is ready/);
});

test('topics render as headings with their points', () => {
  const md = renderMinutes(
    minutes({ topics: [{ heading: 'Demo timeline', points: ['Friday agreed', 'Deck outstanding'] }] }),
    segments,
  );
  assert.match(md, /### Demo timeline/);
  assert.match(md, /- Friday agreed/);
});

test('open questions are listed', () => {
  const md = renderMinutes(minutes({ openQuestions: ['Who presents?'] }), segments);
  assert.match(md, /## Open questions/);
  assert.match(md, /- Who presents\?/);
});

test('empty sections are left out entirely', () => {
  const md = renderMinutes(minutes(), segments);
  assert.doesNotMatch(md, /## Decisions/);
  assert.doesNotMatch(md, /## Action items/);
  assert.doesNotMatch(md, /## Open questions/);
});

test('a flagged entity is marked on its item', () => {
  const md = renderMinutes(
    minutes({
      actionItems: [
        { task: 'Review with Ravi', ownerName: null, dueDate: null, confidence: 'low', sourceSeqs: [1] },
      ],
    }),
    segments,
    { flagged: [{ kind: 'actionItem', text: 'Review with Ravi', entity: 'Ravi' }] },
  );
  assert.match(md, /unverified: Ravi/);
});

test('an unknown citation renders without crashing', () => {
  const md = renderMinutes(
    minutes({ decisions: [{ decision: 'Ship on Friday', rationale: null, sourceSeqs: [404] }] }),
    segments,
  );
  assert.match(md, /Ship on Friday/);
});
