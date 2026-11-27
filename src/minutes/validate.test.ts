import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateMinutes, type DraftMinutes, type Segment } from './validate.ts';

const segments: Segment[] = [
  { seq: 1, tStartMs: 0, text: "So we'll ship the Geodesis demo by Friday.", speakerName: 'Pranav' },
  { seq: 2, tStartMs: 5000, text: 'I will take the slide deck.', speakerName: 'Asha' },
];

function draft(over: Partial<DraftMinutes> = {}): DraftMinutes {
  return {
    title: 'Team sync',
    summary: 'The team agreed on the demo date.',
    topics: [{ heading: 'Demo', points: ['Timeline discussed'] }],
    decisions: [],
    actionItems: [],
    openQuestions: [],
    attendeesSpeaking: ['Pranav', 'Asha'],
    ...over,
  };
}

const action = (over: Record<string, unknown> = {}) => ({
  task: 'Ship the Geodesis demo by Friday',
  ownerName: 'Pranav',
  dueDate: null,
  confidence: 'high' as const,
  sourceSeqs: [1],
  ...over,
});

test('a well-cited action item survives untouched', () => {
  const r = validateMinutes(draft({ actionItems: [action()] }), segments);
  assert.equal(r.minutes.actionItems.length, 1);
  assert.deepEqual(r.dropped, []);
  assert.deepEqual(r.flagged, []);
});

test('an action item citing nothing is dropped', () => {
  const r = validateMinutes(draft({ actionItems: [action({ sourceSeqs: [] })] }), segments);
  assert.equal(r.minutes.actionItems.length, 0);
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0]!.reason, /citation/i);
});

test('an action item citing a segment that does not exist is dropped', () => {
  const r = validateMinutes(draft({ actionItems: [action({ sourceSeqs: [99] })] }), segments);
  assert.equal(r.minutes.actionItems.length, 0);
  assert.equal(r.dropped.length, 1);
  assert.match(r.dropped[0]!.reason, /unknown segment/i);
});

test('a decision citing nothing is dropped too', () => {
  const decisions = [{ decision: 'Ship on Friday', rationale: null, sourceSeqs: [] }];
  const r = validateMinutes(draft({ decisions }), segments);
  assert.equal(r.minutes.decisions.length, 0);
  assert.equal(r.dropped.length, 1);
});

test('a number absent from the cited segment is flagged, not dropped', () => {
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Allocate 5000 rupees' })] }),
    segments,
  );
  assert.equal(r.minutes.actionItems.length, 1);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0]!.entity, '5000');
});

test('a number present in the cited segment passes, ignoring thousands separators', () => {
  const cited: Segment[] = [{ seq: 1, tStartMs: 0, text: 'we allocate 5,000 rupees for it' }];
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Allocate 5000 rupees', ownerName: null })] }),
    cited,
  );
  assert.deepEqual(r.flagged, []);
});

test('a name absent from the cited segment is flagged', () => {
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Review with Ravi' })] }),
    segments,
  );
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0]!.entity, 'Ravi');
});

test('a glossary term counts as grounded even when the words differ', () => {
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Review with Ravi' })] }),
    segments,
    { glossary: ['Ravi'] },
  );
  assert.deepEqual(r.flagged, []);
});

test('the first word of a task is not treated as a name', () => {
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Ship the deck' })] }),
    segments,
  );
  assert.deepEqual(r.flagged, []);
});

test('an owner is grounded by who was speaking', () => {
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Take the slide deck', ownerName: 'Asha', sourceSeqs: [2] })] }),
    segments,
  );
  assert.deepEqual(r.flagged, []);
});

test('an owner nobody in the cited segment mentions is flagged', () => {
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Take the slide deck', ownerName: 'Ravi', sourceSeqs: [2] })] }),
    segments,
  );
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0]!.entity, 'Ravi');
});

test('a two-word owner is grounded by the speaker name', () => {
  const named: Segment[] = [
    { seq: 1, tStartMs: 0, text: 'I will sort the budget.', speakerName: 'Ravi M' },
  ];
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Sort the budget', ownerName: 'Ravi M', sourceSeqs: [1] })] }),
    named,
  );
  assert.deepEqual(r.flagged, []);
});

test('a two-word owner whose surname differs is still flagged', () => {
  const named: Segment[] = [
    { seq: 1, tStartMs: 0, text: 'I will sort the budget.', speakerName: 'Ravi M' },
  ];
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Sort the budget', ownerName: 'Ravi K', sourceSeqs: [1] })] }),
    named,
  );
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0]!.entity, 'Ravi K');
});

test('an unassigned owner is never flagged', () => {
  const r = validateMinutes(
    draft({ actionItems: [action({ task: 'Take the slide deck', ownerName: null, sourceSeqs: [2] })] }),
    segments,
  );
  assert.deepEqual(r.flagged, []);
});

test('the summary and topics need no citations', () => {
  const r = validateMinutes(draft(), segments);
  assert.equal(r.minutes.summary, 'The team agreed on the demo date.');
  assert.equal(r.minutes.topics.length, 1);
  assert.deepEqual(r.dropped, []);
});

test('a plain-prose rationale is not treated as one giant entity', () => {
  const decisions = [
    { decision: 'Ship on Friday', rationale: 'The deck is nearly ready', sourceSeqs: [1] },
  ];
  const r = validateMinutes(draft({ decisions }), segments);
  assert.deepEqual(r.flagged, []);
});

test('an ungrounded number inside a rationale is flagged', () => {
  const decisions = [
    { decision: 'Ship on Friday', rationale: 'The budget is 9999', sourceSeqs: [1] },
  ];
  const r = validateMinutes(draft({ decisions }), segments);
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0]!.entity, '9999');
});

test('counts are reported for a mixed draft', () => {
  const r = validateMinutes(
    draft({
      actionItems: [action(), action({ sourceSeqs: [] }), action({ task: 'Spend 999' })],
      decisions: [{ decision: 'Ship Friday', rationale: null, sourceSeqs: [1] }],
    }),
    segments,
  );
  assert.equal(r.minutes.actionItems.length, 2);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.flagged.length, 1);
});
