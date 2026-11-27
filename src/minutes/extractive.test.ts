import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildExtractiveMinutes, resolveDueDate } from './extractive.ts';
import { validateMinutes, type Segment } from './validate.ts';

/** A Wednesday. */
const MEETING_DATE = '2026-11-25';

let nextSeq = 1;
const said = (speakerName: string, text: string): Segment => ({
  seq: nextSeq++,
  tStartMs: nextSeq * 1000,
  text,
  speakerName,
});

// ---------- resolveDueDate ----------

test('an explicit date passes through', () => {
  assert.equal(resolveDueDate('2026-12-01', MEETING_DATE), '2026-12-01');
});

test('a weekday resolves to its next occurrence', () => {
  // Wednesday the 25th -> Friday the 27th
  assert.equal(resolveDueDate('Friday', MEETING_DATE), '2026-11-27');
});

test('a weekday earlier in the week rolls into next week', () => {
  // Wednesday the 25th -> Monday the 30th
  assert.equal(resolveDueDate('Monday', MEETING_DATE), '2026-11-30');
});

test('the meeting own weekday resolves to the meeting day', () => {
  assert.equal(resolveDueDate('Wednesday', MEETING_DATE), MEETING_DATE);
});

test('tomorrow is the day after the meeting', () => {
  assert.equal(resolveDueDate('tomorrow', MEETING_DATE), '2026-11-26');
});

test('today is the meeting day', () => {
  assert.equal(resolveDueDate('today', MEETING_DATE), MEETING_DATE);
});

test('next week is a week after the meeting', () => {
  assert.equal(resolveDueDate('next week', MEETING_DATE), '2026-12-02');
});

test('a weekday crossing a month boundary resolves correctly', () => {
  // Monday the 30th of November -> Tuesday the 1st of December
  assert.equal(resolveDueDate('Tuesday', '2026-11-30'), '2026-12-01');
});

test('without a meeting date nothing can be resolved', () => {
  assert.equal(resolveDueDate('Friday', undefined), null);
});

test('an unrecognised hint resolves to nothing', () => {
  assert.equal(resolveDueDate('eventually', MEETING_DATE), null);
});

test('a null hint resolves to nothing', () => {
  assert.equal(resolveDueDate(null, MEETING_DATE), null);
});

// ---------- buildExtractiveMinutes ----------

function transcript(): Segment[] {
  nextSeq = 1;
  return [
    said('Pranav K', 'Morning everyone.'),
    said('Pranav K', "So we'll ship the Geodesis demo on Friday."),
    said('Asha R', 'I will prepare the slide deck by Thursday.'),
    said('Pranav K', 'Who is presenting the demo?'),
    said('Asha R', 'We agreed to postpone the launch.'),
  ];
}

test('decisions are collected with their citations', () => {
  const minutes = buildExtractiveMinutes(transcript(), { meetingDate: MEETING_DATE });
  assert.equal(minutes.decisions.length, 2);
  assert.deepEqual(minutes.decisions[0]!.sourceSeqs, [2]);
});

test('action items are collected with owner and resolved date', () => {
  const minutes = buildExtractiveMinutes(transcript(), { meetingDate: MEETING_DATE });
  assert.equal(minutes.actionItems.length, 1);
  assert.equal(minutes.actionItems[0]!.ownerName, 'Asha R');
  assert.equal(minutes.actionItems[0]!.dueDate, '2026-11-26');
});

test('questions become open questions', () => {
  const minutes = buildExtractiveMinutes(transcript(), { meetingDate: MEETING_DATE });
  assert.deepEqual(minutes.openQuestions, ['Who is presenting the demo?']);
});

test('the speakers are listed', () => {
  const minutes = buildExtractiveMinutes(transcript(), { meetingDate: MEETING_DATE });
  assert.deepEqual(minutes.attendeesSpeaking, ['Pranav K', 'Asha R']);
});

test('the title is used when given', () => {
  const minutes = buildExtractiveMinutes(transcript(), { title: 'Weekly sync' });
  assert.equal(minutes.title, 'Weekly sync');
});

test('no topics are invented without a model', () => {
  assert.deepEqual(buildExtractiveMinutes(transcript(), {}).topics, []);
});

test('the summary states counts and claims nothing more', () => {
  const minutes = buildExtractiveMinutes(transcript(), {});
  assert.match(minutes.summary, /2 decisions/);
  assert.match(minutes.summary, /1 action item/);
  assert.match(minutes.summary, /without a language model|extracted/i);
});

test('an empty transcript produces empty but valid minutes', () => {
  const minutes = buildExtractiveMinutes([], {});
  assert.deepEqual(minutes.decisions, []);
  assert.deepEqual(minutes.actionItems, []);
  assert.ok(minutes.summary.length > 0);
});

test('a due hint with no meeting date leaves the date unset', () => {
  const minutes = buildExtractiveMinutes(transcript(), {});
  assert.equal(minutes.actionItems[0]!.dueDate, null);
});

// ---------- the gates ----------

test('extractive minutes pass the citation and grounding gates untouched', () => {
  const segments = transcript();
  const minutes = buildExtractiveMinutes(segments, { meetingDate: MEETING_DATE });
  const checked = validateMinutes(minutes, segments, { glossary: ['Geodesis'] });

  assert.deepEqual(checked.dropped, [], 'nothing should be dropped');
  assert.deepEqual(checked.flagged, [], 'nothing should be flagged');
  assert.equal(checked.minutes.decisions.length, minutes.decisions.length);
  assert.equal(checked.minutes.actionItems.length, minutes.actionItems.length);
});
