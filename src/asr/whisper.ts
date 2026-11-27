/**
 * The real speech recogniser: Whisper through transformers.js.
 *
 * Deliberately the same library the extension will run in the browser, so the
 * accuracy measured in Phase 0 is the accuracy the product ships with. A
 * different implementation here (whisper.cpp, a hosted API) would measure
 * something we are not going to use.
 *
 * In Node this runs on CPU, which is slower than the WebGPU path but fine for
 * batch scoring. Only `chunksToWords` is unit tested — the pipeline itself
 * needs weights on disk, so it is exercised through the CLI against real
 * audio.
 */

import { SAMPLE_RATE } from '../audio/windows.ts';
import type { Recogniser, RecognisedWord } from './transcribe.ts';

/** One word as the Whisper pipeline reports it, in seconds. */
export type WhisperChunk = {
  text?: string;
  timestamp?: readonly [number | null, number | null];
};

const toMs = (seconds: number): number => Math.round(seconds * 1000);

/**
 * Converts pipeline output into window-relative words.
 *
 * Whisper's word timestamps are derived from cross-attention and come back
 * incomplete more often than the docs suggest — a trailing word with no end, a
 * continuation with no start. Every gap is filled from its neighbours rather
 * than dropped, because a word without a timestamp is still a word that was
 * said, and losing it would quietly raise the word error rate.
 */
export function chunksToWords(
  chunks: readonly WhisperChunk[],
  windowDurationMs: number,
): RecognisedWord[] {
  const words: RecognisedWord[] = [];
  let previousEndMs = 0;

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const text = (chunk.text ?? '').trim();
    if (text === '') continue;

    const startSec = chunk.timestamp?.[0] ?? null;
    const endSec = chunk.timestamp?.[1] ?? null;

    const tStartMs = startSec === null ? previousEndMs : toMs(startSec);

    let tEndMs: number;
    if (endSec !== null) {
      tEndMs = toMs(endSec);
    } else {
      // Borrow the next chunk that knows where it starts; otherwise this is
      // the tail of the window.
      const next = chunks.slice(i + 1).find((c) => (c.timestamp?.[0] ?? null) !== null);
      tEndMs = next ? toMs(next.timestamp![0]!) : windowDurationMs;
    }

    tEndMs = Math.max(tEndMs, tStartMs);

    // A chunk may be a single word (word-level timestamps) or a whole segment
    // (segment-level, which every model supports). Splitting a segment and
    // spreading its span across the words keeps the seam matching in
    // `stitch.ts` working on words either way. The times inside a segment are
    // approximate, which is fine: citations point at segment starts.
    const parts = text.split(/\s+/u).filter((part) => part !== '');
    const step = parts.length > 0 ? (tEndMs - tStartMs) / parts.length : 0;

    parts.forEach((part, index) => {
      words.push({
        text: part,
        tStartMs: Math.round(tStartMs + step * index),
        tEndMs: Math.round(tStartMs + step * (index + 1)),
      });
    });

    previousEndMs = tEndMs;
  }

  return words;
}

export type WhisperOptions = {
  /** Any ONNX Whisper repo. Default is small and fast for iteration. */
  model?: string;
  /** Quantisation. 'q8' is a good speed/accuracy trade on CPU. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /**
   * Language hint. Leave unset for auto-detect.
   *
   * For Hinglish there is no obviously right value: 'en' transliterates Hindi
   * roughly, 'hi' returns Devanagari, and auto-detect can flip mid-call. This
   * is the Phase 0 experiment to settle on real recordings
   * (docs/ACCURACY.md §3).
   */
  language?: string;
  onStatus?: (message: string) => void;
};

type PipelineResult = {
  text?: string;
  chunks?: WhisperChunk[];
};

/**
 * Loads the model once and returns a recogniser over single windows.
 *
 * Not yet wired: Whisper's `initial_prompt`, which is how the meeting's own
 * vocabulary biases recognition and is the biggest remaining win on
 * proper-noun accuracy. transformers.js support for it needs checking before
 * this claims to do it, so for now glossary snapping happens after the fact in
 * `glossary/correct.ts`.
 */
export async function createWhisperRecogniser(
  options: WhisperOptions = {},
): Promise<Recogniser> {
  const model = options.model ?? 'onnx-community/whisper-base';
  const dtype = options.dtype ?? 'q8';

  options.onStatus?.(`loading ${model} (${dtype})`);
  const { pipeline } = await import('@huggingface/transformers');
  const transcriber = await pipeline('automatic-speech-recognition', model, { dtype });
  options.onStatus?.('model ready');

  // Word-level timestamps need a model exported with cross-attentions — the
  // plain repos are not, and only say so when asked. Segment timestamps work
  // on every model, and `chunksToWords` splits a segment back into words, so
  // the first window decides the mode and the rest follow it.
  let granularity: 'word' | 'segment' = 'word';

  return async (window) => {
    const windowDurationMs = Math.round((window.samples.length / SAMPLE_RATE) * 1000);

    for (;;) {
      const generate: Record<string, unknown> = {
        return_timestamps: granularity === 'word' ? 'word' : true,
      };
      if (options.language) {
        generate['language'] = options.language;
        generate['task'] = 'transcribe';
      }

      try {
        const raw = (await transcriber(window.samples, generate)) as PipelineResult | PipelineResult[];
        const result = Array.isArray(raw) ? raw[0] : raw;
        return chunksToWords(result?.chunks ?? [], windowDurationMs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unsupported = /cross attentions|output_attentions/i.test(message);

        if (granularity === 'word' && unsupported) {
          granularity = 'segment';
          options.onStatus?.(
            'this model has no word timestamps — using segment timestamps ' +
            '(word-level needs a model exported with cross-attentions)',
          );
          continue;
        }
        throw error;
      }
    }
  };
}
