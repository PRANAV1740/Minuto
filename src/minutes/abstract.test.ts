import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildAbstractPrompt, parseModelMinutes, abstractMinutes, type Completer } from './abstract.ts';
import { extractCandidates } from './extract.ts';
import type { Segment } from './validate.ts';

const SEGMENTS: Segment[] = [
  { seq: 1, tStartMs: 0, text: 'Morning everyone.', speakerName: 'Pranav K' },
  { seq: 2, tStartMs: 11_000, text: "So we'll ship the Geodesis demo on Friday.", speakerName: 'Pranav K' },
  { seq: 3, tStartMs: 26_000, text: 'I will prepare the slide deck by Thursday.', speakerName: 'Asha R' },
  { seq: 4, tStartMs: 41_000, text: 'Who is presenting the demo?', speakerName: 'Pranav K' },
];

const CANDIDATES = extractCandidates(SEGMENTS);

/** A model that returns whatever it is told to. */
const canned = (reply: string): Completer => async () => reply;

const GOOD_REPLY = JSON.stringify({
  title: 'Geodesis weekly sync',
  summary: 'The team fixed the demo date and split the preparation.',
  topics: [{ heading: 'Demo timeline', points: ['Friday agreed', 'Deck outstanding'] }],
  decisions: [{ decision: 'Ship the Geodesis demo on Friday', rationale: 'The deck is nearly ready', sourceSeqs: [2] }],
  actionItems: [
    { task: 'Prepare the slide deck', ownerName: 'Asha R', dueDate: '2026-11-26', confidence: 'high', sourceSeqs: [3] },
  ],
  openQuestions: ['Who is presenting the demo?'],
});

// ---------- buildAbstractPrompt ----------

test('the prompt carries every candidate with its segment number', () => {
  const prompt = buildAbstractPrompt(CANDIDATES, {});
  for (const candidate of CANDIDATES) {
    assert.ok(prompt.user.includes(candidate.text), `missing: ${candidate.text}`);
    assert.ok(prompt.user.includes(`#${candidate.sourceSeqs[0]}`), 'missing a segment number');
  }
});

test('the prompt forbids inventing anything', () => {
  const prompt = buildAbstractPrompt(CANDIDATES, {});
  assert.match(prompt.system, /only|never invent|do not invent/i);
});

test('the prompt lists which segment numbers may be cited', () => {
  const prompt = buildAbstractPrompt(CANDIDATES, {});
  assert.match(prompt.user, /2, 3, 4|2,3,4/);
});

test('the prompt does not include the whole transcript', () => {
  const prompt = buildAbstractPrompt(CANDIDATES, {});
  // Small talk was never a candidate, so the model never sees it.
  assert.equal(prompt.user.includes('Morning everyone'), false);
});

test('a title and date are passed to the model when known', () => {
  const prompt = buildAbstractPrompt(CANDIDATES, { title: 'Weekly sync', meetingDate: '2026-11-25' });
  assert.match(prompt.user, /Weekly sync/);
  assert.match(prompt.user, /2026-11-25/);
});

test('an empty candidate list still produces a usable prompt', () => {
  const prompt = buildAbstractPrompt([], {});
  assert.ok(prompt.system.length > 0);
  assert.ok(prompt.user.length > 0);
});

// ---------- parseModelMinutes ----------

const ALLOWED = [2, 3, 4];

test('plain JSON parses', () => {
  const result = parseModelMinutes(GOOD_REPLY, ALLOWED);
  assert.equal(result.minutes.title, 'Geodesis weekly sync');
  assert.equal(result.minutes.decisions.length, 1);
  assert.deepEqual(result.rejected, []);
});

test('JSON inside a fenced block parses', () => {
  const result = parseModelMinutes(`\`\`\`json\n${GOOD_REPLY}\n\`\`\``, ALLOWED);
  assert.equal(result.minutes.decisions.length, 1);
});

test('JSON inside an unlabelled fence parses', () => {
  const result = parseModelMinutes(`\`\`\`\n${GOOD_REPLY}\n\`\`\``, ALLOWED);
  assert.equal(result.minutes.decisions.length, 1);
});

test('chatter around the JSON is tolerated', () => {
  const result = parseModelMinutes(`Sure! Here you go:\n${GOOD_REPLY}\nHope that helps.`, ALLOWED);
  assert.equal(result.minutes.decisions.length, 1);
});

test('output with no JSON at all is an error', () => {
  assert.throws(() => parseModelMinutes('I cannot help with that.', ALLOWED), /json/i);
});

test('malformed JSON is an error', () => {
  assert.throws(() => parseModelMinutes('{ "title": ', ALLOWED), /json/i);
});

test('a missing summary is an error', () => {
  assert.throws(() => parseModelMinutes(JSON.stringify({ title: 'x' }), ALLOWED), /summary/i);
});

test('a decision citing a segment outside the candidates is rejected', () => {
  const reply = JSON.stringify({
    title: 'x',
    summary: 'y',
    decisions: [{ decision: 'Invented', sourceSeqs: [99] }],
  });
  const result = parseModelMinutes(reply, ALLOWED);
  assert.equal(result.minutes.decisions.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.match(result.rejected[0]!, /99/);
});

test('an action item citing nothing is rejected', () => {
  const reply = JSON.stringify({
    title: 'x',
    summary: 'y',
    actionItems: [{ task: 'Floating task', sourceSeqs: [] }],
  });
  const result = parseModelMinutes(reply, ALLOWED);
  assert.equal(result.minutes.actionItems.length, 0);
  assert.match(result.rejected[0]!, /no citation/i);
});

test('one bad item does not lose the good ones', () => {
  const reply = JSON.stringify({
    title: 'x',
    summary: 'y',
    actionItems: [
      { task: 'Real task', ownerName: 'Asha R', sourceSeqs: [3] },
      { task: 'Invented task', sourceSeqs: [99] },
    ],
  });
  const result = parseModelMinutes(reply, ALLOWED);
  assert.equal(result.minutes.actionItems.length, 1);
  assert.equal(result.minutes.actionItems[0]!.task, 'Real task');
});

test('a placeholder owner is read as unassigned', () => {
  for (const owner of ['null', 'Unassigned', 'N/A', 'TBD', 'none']) {
    const reply = JSON.stringify({
      title: 'x',
      summary: 'y',
      actionItems: [{ task: 't', ownerName: owner, sourceSeqs: [3] }],
    });
    const result = parseModelMinutes(reply, ALLOWED);
    assert.equal(result.minutes.actionItems[0]!.ownerName, null, `owner "${owner}"`);
  }
});

test('a due date that is not a real date is dropped', () => {
  const reply = JSON.stringify({
    title: 'x',
    summary: 'y',
    actionItems: [{ task: 't', dueDate: 'sometime next week', sourceSeqs: [3] }],
  });
  const result = parseModelMinutes(reply, ALLOWED);
  assert.equal(result.minutes.actionItems[0]!.dueDate, null);
});

test('an unknown confidence value falls back to medium', () => {
  const reply = JSON.stringify({
    title: 'x',
    summary: 'y',
    actionItems: [{ task: 't', confidence: 'very sure', sourceSeqs: [3] }],
  });
  assert.equal(parseModelMinutes(reply, ALLOWED).minutes.actionItems[0]!.confidence, 'medium');
});

test('missing arrays become empty rather than undefined', () => {
  const result = parseModelMinutes(JSON.stringify({ title: 'x', summary: 'y' }), ALLOWED);
  assert.deepEqual(result.minutes.decisions, []);
  assert.deepEqual(result.minutes.actionItems, []);
  assert.deepEqual(result.minutes.topics, []);
  assert.deepEqual(result.minutes.openQuestions, []);
});

test('the speakers come from the transcript, not the model', () => {
  const reply = JSON.stringify({
    title: 'x',
    summary: 'y',
    attendeesSpeaking: ['Someone Invented'],
  });
  const result = parseModelMinutes(reply, ALLOWED, ['Pranav K', 'Asha R']);
  assert.deepEqual(result.minutes.attendeesSpeaking, ['Pranav K', 'Asha R']);
});

// ---------- abstractMinutes ----------

test('a good model reply becomes minutes', async () => {
  const minutes = await abstractMinutes(SEGMENTS, canned(GOOD_REPLY), {});
  assert.equal(minutes.minutes.title, 'Geodesis weekly sync');
  assert.equal(minutes.minutes.actionItems.length, 1);
});

test('the model is given a prompt built from the candidates', async () => {
  let seen = '';
  const spy: Completer = async (prompt) => {
    seen = prompt.user;
    return GOOD_REPLY;
  };
  await abstractMinutes(SEGMENTS, spy, {});
  assert.ok(seen.includes('slide deck'), 'candidate text was not sent');
  assert.equal(seen.includes('Morning everyone'), false, 'small talk should not be sent');
});

test('speakers are filled in from the transcript', async () => {
  const minutes = await abstractMinutes(SEGMENTS, canned(GOOD_REPLY), {});
  assert.deepEqual(minutes.minutes.attendeesSpeaking, ['Pranav K', 'Asha R']);
});

test('a model that returns nonsense raises rather than inventing minutes', async () => {
  await assert.rejects(abstractMinutes(SEGMENTS, canned('no thanks'), {}), /json/i);
});

test('a model that fails raises', async () => {
  const broken: Completer = async () => {
    throw new Error('quota exhausted');
  };
  await assert.rejects(abstractMinutes(SEGMENTS, broken, {}), /quota exhausted/);
});

test('rejections from the model are reported alongside the minutes', async () => {
  const reply = JSON.stringify({
    title: 'x',
    summary: 'y',
    decisions: [{ decision: 'Invented', sourceSeqs: [99] }],
  });
  const result = await abstractMinutes(SEGMENTS, canned(reply), {});
  assert.equal(result.rejected.length, 1);
});

test('a transcript with no candidates still asks the model once', async () => {
  let calls = 0;
  const spy: Completer = async () => {
    calls++;
    return JSON.stringify({ title: 'Quiet meeting', summary: 'Nothing was decided.' });
  };
  const result = await abstractMinutes([SEGMENTS[0]!], spy, {});
  assert.equal(calls, 1);
  assert.equal(result.minutes.summary, 'Nothing was decided.');
});
