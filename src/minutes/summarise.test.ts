import { test } from 'node:test';
import assert from 'node:assert/strict';

import { summariseMinutes, mergeItems, buildMapPrompt, buildReducePrompt } from './summarise.ts';
import { extractCandidates } from './extract.ts';
import { chunkCandidates } from './chunk.ts';
import type { Completer } from './abstract.ts';
import type { DraftActionItem, DraftDecision, Segment } from './validate.ts';

function transcript(count: number): Segment[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    tStartMs: i * 5000,
    text: i % 2 === 0 ? `Discussion of topic number ${i}.` : `I will handle item ${i}.`,
    speakerName: i % 3 === 0 ? 'Pranav K' : 'Asha R',
  }));
}

const SHORT = transcript(6);
const LONG = transcript(120);

const mapReply = (seq: number) =>
  JSON.stringify({
    decisions: [{ decision: `Decided about ${seq}`, rationale: null, sourceSeqs: [seq] }],
    actionItems: [{ task: `Handle item ${seq}`, ownerName: 'Asha R', sourceSeqs: [seq] }],
    openQuestions: [`What about ${seq}?`],
  });

const REDUCE_REPLY = JSON.stringify({
  title: 'Long workshop',
  summary: 'A lot was discussed and several items were assigned.',
  topics: [{ heading: 'Topics', points: ['Many things'] }],
});

/** Replies to map calls with the first allowed seq, and to the reduce call. */
function scriptedModel(): { complete: Completer; calls: string[] } {
  const calls: string[] = [];

  const complete: Completer = async (prompt) => {
    const isReduce = /title/i.test(prompt.system) && !/sourceSeqs/i.test(prompt.system);
    calls.push(isReduce ? 'reduce' : 'map');

    if (isReduce) return REDUCE_REPLY;

    const seq = Number(/may cite: (\d+)/.exec(prompt.user)?.[1] ?? '1');
    return mapReply(seq);
  };

  return { complete, calls };
}

// ---------- mergeItems ----------

const decision = (text: string, seqs: number[]): DraftDecision => ({
  decision: text,
  rationale: null,
  sourceSeqs: seqs,
});

const action = (text: string, seqs: number[]): DraftActionItem => ({
  task: text,
  ownerName: null,
  dueDate: null,
  confidence: 'medium',
  sourceSeqs: seqs,
});

test('distinct items are all kept', () => {
  const merged = mergeItems({
    decisions: [decision('Ship on Friday', [1]), decision('Postpone the launch', [2])],
    actionItems: [],
    openQuestions: [],
  });
  assert.equal(merged.decisions.length, 2);
});

test('the same decision found twice is kept once', () => {
  const merged = mergeItems({
    decisions: [decision('Ship on Friday', [1]), decision('Ship on Friday', [5])],
    actionItems: [],
    openQuestions: [],
  });
  assert.equal(merged.decisions.length, 1);
});

test('merging a duplicate keeps both citations', () => {
  const merged = mergeItems({
    decisions: [decision('Ship on Friday', [1]), decision('Ship on Friday', [5])],
    actionItems: [],
    openQuestions: [],
  });
  assert.deepEqual(merged.decisions[0]!.sourceSeqs, [1, 5]);
});

test('wording differences in casing and punctuation count as duplicates', () => {
  const merged = mergeItems({
    decisions: [decision('Ship on Friday', [1]), decision('ship on friday.', [5])],
    actionItems: [],
    openQuestions: [],
  });
  assert.equal(merged.decisions.length, 1);
});

test('duplicate action items merge the same way', () => {
  const merged = mergeItems({
    decisions: [],
    actionItems: [action('Book the room', [1]), action('Book the room', [4])],
    openQuestions: [],
  });
  assert.equal(merged.actionItems.length, 1);
  assert.deepEqual(merged.actionItems[0]!.sourceSeqs, [1, 4]);
});

test('an owner found in one copy survives the merge', () => {
  const withOwner = { ...action('Book the room', [4]), ownerName: 'Ravi' };
  const merged = mergeItems({
    decisions: [],
    actionItems: [action('Book the room', [1]), withOwner],
    openQuestions: [],
  });
  assert.equal(merged.actionItems[0]!.ownerName, 'Ravi');
});

test('repeated questions are asked once', () => {
  const merged = mergeItems({
    decisions: [],
    actionItems: [],
    openQuestions: ['Who presents?', 'who presents?', 'What is the budget?'],
  });
  assert.deepEqual(merged.openQuestions, ['Who presents?', 'What is the budget?']);
});

// ---------- prompts ----------

test('a map prompt asks for items and names the citable segments', () => {
  const candidates = extractCandidates(SHORT);
  const chunk = chunkCandidates(candidates, SHORT, { maxTokens: 10_000 })[0]!;
  const prompt = buildMapPrompt(chunk, {});

  assert.match(prompt.system, /sourceSeqs/);
  assert.match(prompt.user, /may cite/i);
});

test('a map prompt includes the surrounding transcript', () => {
  const candidates = extractCandidates(SHORT);
  const chunk = chunkCandidates(candidates, SHORT, { maxTokens: 10_000, contextSegments: 1 })[0]!;
  const prompt = buildMapPrompt(chunk, {});

  assert.match(prompt.user, /Discussion of topic number 0/);
});

test('a reduce prompt asks only for prose, never for items', () => {
  const prompt = buildReducePrompt(
    { decisions: [decision('Ship on Friday', [1])], actionItems: [], openQuestions: [] },
    {},
  );
  assert.match(prompt.system, /title/i);
  assert.equal(/sourceSeqs/i.test(prompt.system), false);
});

test('a reduce prompt shows the items that were found', () => {
  const prompt = buildReducePrompt(
    { decisions: [decision('Ship on Friday', [1])], actionItems: [], openQuestions: [] },
    {},
  );
  assert.match(prompt.user, /Ship on Friday/);
});

// ---------- summariseMinutes ----------

test('a short meeting takes a single model call', async () => {
  const model = scriptedModel();
  await summariseMinutes(SHORT, model.complete, { maxTokens: 10_000 });
  assert.deepEqual(model.calls, ['map']);
});

test('a long meeting maps over chunks and then reduces', async () => {
  const model = scriptedModel();
  await summariseMinutes(LONG, model.complete, { maxTokens: 300 });

  assert.ok(model.calls.filter((c) => c === 'map').length > 1, 'expected several map calls');
  assert.equal(model.calls.at(-1), 'reduce', 'the last call should be the reduce');
});

test('items from every chunk reach the result', async () => {
  const model = scriptedModel();
  const result = await summariseMinutes(LONG, model.complete, { maxTokens: 300 });
  const maps = model.calls.filter((c) => c === 'map').length;

  assert.equal(result.minutes.decisions.length, maps, 'one decision per chunk was expected');
});

test('the reduce supplies the title and summary', async () => {
  const model = scriptedModel();
  const result = await summariseMinutes(LONG, model.complete, { maxTokens: 300 });

  assert.equal(result.minutes.title, 'Long workshop');
  assert.match(result.minutes.summary, /several items/);
});

test('speakers come from the transcript, not from any model call', async () => {
  const model = scriptedModel();
  const result = await summariseMinutes(LONG, model.complete, { maxTokens: 300 });
  assert.deepEqual(result.minutes.attendeesSpeaking, ['Pranav K', 'Asha R']);
});

test('a meeting with nothing in it still produces minutes', async () => {
  const quiet: Segment[] = [{ seq: 1, tStartMs: 0, text: 'Morning all.', speakerName: 'Pranav K' }];
  const complete: Completer = async () => JSON.stringify({ title: 'Quiet', summary: 'Nothing decided.' });

  const result = await summariseMinutes(quiet, complete, {});
  assert.equal(result.minutes.summary, 'Nothing decided.');
  assert.deepEqual(result.minutes.decisions, []);
});

test('a failing model call raises so the caller can fall back', async () => {
  const broken: Completer = async () => {
    throw new Error('quota exhausted');
  };
  await assert.rejects(summariseMinutes(LONG, broken, { maxTokens: 300 }), /quota exhausted/);
});

test('refusals from every chunk are collected', async () => {
  const inventing: Completer = async (prompt) =>
    /title/i.test(prompt.system) && !/sourceSeqs/i.test(prompt.system)
      ? REDUCE_REPLY
      : JSON.stringify({ decisions: [{ decision: 'Invented', sourceSeqs: [9999] }] });

  const result = await summariseMinutes(LONG, inventing, { maxTokens: 300 });
  assert.ok(result.rejected.length > 1, `expected several refusals, got ${result.rejected.length}`);
  assert.equal(result.minutes.decisions.length, 0);
});
