/**
 * Groups extracted candidates into prompt-sized chunks, each carrying the
 * transcript around it.
 *
 * Two jobs, and the second is the one that improves accuracy:
 *
 * 1. **Context.** A candidate sentence can be meaningless alone. "We'll go
 *    with the second option" says nothing without the lines that listed the
 *    options, and a model asked to write minutes from the bare sentence will
 *    either omit it or guess. Each candidate therefore travels with a window
 *    of neighbouring segments.
 *
 * 2. **A token budget.** Context makes the prompt much larger, and a long
 *    workshop can exceed a free-tier context window. Chunks are filled to a
 *    budget and summarised separately, then reduced.
 *
 * Note on the design this replaces: docs/ACCURACY.md §5 sketched map-reduce
 * where the *model* extracted from each transcript chunk. Extraction is done
 * by rule instead (`extract.ts`), which compresses a 90-minute meeting to
 * well under a thousand tokens of candidates — so most meetings now need one
 * chunk, and chunking matters mainly because of the context above.
 *
 * Chunks deliberately do **not** overlap in candidates. Overlap was there to
 * stop a decision falling between two boundaries; the context window handles
 * that now, and a candidate appearing in two chunks would reduce into two
 * copies of the same decision.
 */

import type { Candidate } from './extract.ts';
import type { Segment } from './validate.ts';

export type Chunk = {
  index: number;
  candidates: Candidate[];
  /** The cited segments plus their surroundings, in transcript order. */
  context: Segment[];
  approxTokens: number;
};

export type ChunkOptions = {
  /** Prompt budget for one chunk, counting candidates and their context. */
  maxTokens?: number;
  /** Segments of transcript to keep either side of a cited one. */
  contextSegments?: number;
};

const DEFAULTS = { maxTokens: 3000, contextSegments: 2 } as const;

/**
 * A rough token count, biased high.
 *
 * Deliberately pessimistic: under-counting means a prompt silently overflows
 * and a provider truncates it, which looks like a model that forgot half the
 * meeting.
 */
export function estimateTokens(text: string): number {
  const words = text.trim().split(/\s+/u).filter((word) => word !== '');
  return words.length === 0 ? 0 : Math.ceil(words.length * 1.35);
}

/**
 * The segments a set of citations needs to make sense: the cited ones plus
 * `window` either side, merged, in transcript order.
 */
export function contextFor(
  seqs: readonly number[],
  segments: readonly Segment[],
  window: number,
): Segment[] {
  const indexBySeq = new Map(segments.map((segment, index) => [segment.seq, index]));
  const keep = new Set<number>();

  for (const seq of seqs) {
    const at = indexBySeq.get(seq);
    if (at === undefined) continue;

    const from = Math.max(0, at - window);
    const to = Math.min(segments.length - 1, at + window);
    for (let i = from; i <= to; i++) keep.add(i);
  }

  return [...keep].sort((a, b) => a - b).map((index) => segments[index]!);
}

export function chunkCandidates(
  candidates: readonly Candidate[],
  segments: readonly Segment[],
  options: ChunkOptions = {},
): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULTS.maxTokens;
  const contextSegments = options.contextSegments ?? DEFAULTS.contextSegments;

  const indexBySeq = new Map(segments.map((segment, index) => [segment.seq, index]));
  const chunks: Chunk[] = [];

  let current: Candidate[] = [];
  let currentContext = new Set<number>();
  let currentTokens = 0;

  const close = (): void => {
    if (current.length === 0) return;

    chunks.push({
      index: chunks.length,
      candidates: current,
      context: [...currentContext].sort((a, b) => a - b).map((index) => segments[index]!),
      approxTokens: currentTokens,
    });

    current = [];
    currentContext = new Set();
    currentTokens = 0;
  };

  for (const candidate of candidates) {
    // Only context not already in this chunk costs anything — neighbouring
    // candidates share most of their surroundings.
    const wanted = new Set<number>();
    for (const seq of candidate.sourceSeqs) {
      const at = indexBySeq.get(seq);
      if (at === undefined) continue;

      const from = Math.max(0, at - contextSegments);
      const to = Math.min(segments.length - 1, at + contextSegments);
      for (let i = from; i <= to; i++) {
        if (!currentContext.has(i)) wanted.add(i);
      }
    }

    let cost = estimateTokens(candidate.text);
    for (const index of wanted) cost += estimateTokens(segments[index]!.text);

    // A candidate larger than the whole budget still has to go somewhere, so
    // it gets a chunk of its own rather than being dropped.
    if (current.length > 0 && currentTokens + cost > maxTokens) close();

    current.push(candidate);
    for (const index of wanted) currentContext.add(index);
    currentTokens += cost;
  }

  close();
  return chunks;
}
