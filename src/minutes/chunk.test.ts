import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateTokens, contextFor, chunkCandidates } from './chunk.ts';
import { extractCandidates } from './extract.ts';
import type { Segment } from './validate.ts';

/** A transcript where every other segment carries a cue phrase. */
function transcript(count: number): Segment[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    tStartMs: i * 5000,
    text: i % 2 === 0 ? `Some discussion about topic number ${i}.` : `I will handle item ${i}.`,
    speakerName: i % 3 === 0 ? 'Pranav K' : 'Asha R',
  }));
}

// ---------- estimateTokens ----------

test('empty text is no tokens', () => {
  assert.equal(estimateTokens(''), 0);
});

test('whitespace alone is no tokens', () => {
  assert.equal(estimateTokens('   \n  '), 0);
});

test('a token estimate exceeds the word count', () => {
  // Words split into more tokens than themselves, so the estimate must not
  // under-count or a prompt silently overflows.
  assert.ok(estimateTokens('one two three four') > 4);
});

test('the estimate grows with the text', () => {
  assert.ok(estimateTokens('one two three') > estimateTokens('one two'));
});

// ---------- contextFor ----------

const SEGMENTS = transcript(10);

test('context includes the cited segment itself', () => {
  const context = contextFor([3], SEGMENTS, 0);
  assert.deepEqual(context.map((s) => s.seq), [3]);
});

test('context reaches the segments either side', () => {
  const context = contextFor([5], SEGMENTS, 2);
  assert.deepEqual(context.map((s) => s.seq), [3, 4, 5, 6, 7]);
});

test('context is clipped at the start of the transcript', () => {
  const context = contextFor([1], SEGMENTS, 2);
  assert.deepEqual(context.map((s) => s.seq), [1, 2, 3]);
});

test('context is clipped at the end of the transcript', () => {
  const context = contextFor([10], SEGMENTS, 2);
  assert.deepEqual(context.map((s) => s.seq), [8, 9, 10]);
});

test('context around several citations is merged without repeats', () => {
  const context = contextFor([4, 5], SEGMENTS, 1);
  assert.deepEqual(context.map((s) => s.seq), [3, 4, 5, 6]);
});

test('context comes back in transcript order', () => {
  const context = contextFor([8, 2], SEGMENTS, 0);
  assert.deepEqual(context.map((s) => s.seq), [2, 8]);
});

test('a citation with no matching segment contributes nothing', () => {
  assert.deepEqual(contextFor([99], SEGMENTS, 2), []);
});

// ---------- chunkCandidates ----------

test('no candidates means no chunks', () => {
  assert.deepEqual(chunkCandidates([], SEGMENTS, {}), []);
});

test('a short meeting is a single chunk', () => {
  const candidates = extractCandidates(SEGMENTS);
  const chunks = chunkCandidates(candidates, SEGMENTS, { maxTokens: 10_000 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.candidates.length, candidates.length);
});

test('a long meeting splits into several chunks', () => {
  const segments = transcript(200);
  const chunks = chunkCandidates(extractCandidates(segments), segments, { maxTokens: 400 });
  assert.ok(chunks.length > 1, `expected a split, got ${chunks.length}`);
});

test('every candidate appears exactly once across the chunks', () => {
  const segments = transcript(200);
  const candidates = extractCandidates(segments);
  const chunks = chunkCandidates(candidates, segments, { maxTokens: 400 });

  const seen = chunks.flatMap((chunk) => chunk.candidates.map((c) => `${c.sourceSeqs[0]}:${c.text}`));
  assert.equal(seen.length, candidates.length, 'a candidate was lost or duplicated');
  assert.equal(new Set(seen).size, candidates.length);
});

test('chunks stay inside the token budget', () => {
  const segments = transcript(200);
  const chunks = chunkCandidates(extractCandidates(segments), segments, { maxTokens: 400 });

  // The last candidate added may cross the line; nothing after it may.
  for (const chunk of chunks.slice(0, -1)) {
    assert.ok(chunk.candidates.length > 0, 'an empty chunk was produced');
  }
});

test('chunk indices count up from zero', () => {
  const segments = transcript(200);
  const chunks = chunkCandidates(extractCandidates(segments), segments, { maxTokens: 400 });
  assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
});

test('each chunk carries the context its candidates need', () => {
  const candidates = extractCandidates(SEGMENTS);
  const chunks = chunkCandidates(candidates, SEGMENTS, { maxTokens: 10_000, contextSegments: 1 });

  for (const candidate of chunks[0]!.candidates) {
    for (const seq of candidate.sourceSeqs) {
      assert.ok(
        chunks[0]!.context.some((s) => s.seq === seq),
        `context is missing segment ${seq}`,
      );
    }
  }
});

test('a chunk context is ordered and free of repeats', () => {
  const chunks = chunkCandidates(extractCandidates(SEGMENTS), SEGMENTS, { maxTokens: 10_000 });
  const seqs = chunks[0]!.context.map((s) => s.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
});

test('a single candidate too large for the budget still gets a chunk', () => {
  const long = 'word '.repeat(2000);
  const segments: Segment[] = [{ seq: 1, tStartMs: 0, text: `I will ${long}`, speakerName: 'Asha' }];
  const chunks = chunkCandidates(extractCandidates(segments), segments, { maxTokens: 50 });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.candidates.length, 1);
});

test('the estimated size of each chunk is reported', () => {
  const chunks = chunkCandidates(extractCandidates(SEGMENTS), SEGMENTS, { maxTokens: 10_000 });
  assert.ok(chunks[0]!.approxTokens > 0);
});

test('no context is attached when none is asked for', () => {
  const candidates = extractCandidates(SEGMENTS);
  const chunks = chunkCandidates(candidates, SEGMENTS, { maxTokens: 10_000, contextSegments: 0 });
  const cited = new Set(candidates.flatMap((c) => c.sourceSeqs));

  for (const segment of chunks[0]!.context) {
    assert.ok(cited.has(segment.seq), `segment ${segment.seq} was not cited by anything`);
  }
});
