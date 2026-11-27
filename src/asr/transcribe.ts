/**
 * Runs a speech recogniser across an audio buffer and returns one clean word
 * stream.
 *
 * The recogniser is injected. That keeps this orchestration — windowing,
 * turning window-relative timings into absolute ones, and removing the overlap
 * — testable without a model download, and it means swapping Whisper for
 * anything else later touches one adapter rather than this logic.
 *
 * Windows run one at a time on purpose. The browser runs this against a single
 * GPU, so there is nothing to gain from overlapping inference, and running in
 * order keeps progress reporting honest.
 */

import { sliceWindows, SAMPLE_RATE, type AudioWindow, type WindowOptions } from '../audio/windows.ts';
import { speechMsInRange, type SpeechRegion } from '../audio/vad.ts';
import { stitchWindows, type AsrWindow, type StitchOptions, type Word } from './stitch.ts';

/** A word as the model reports it: times relative to the window's own start. */
export type RecognisedWord = {
  text: string;
  tStartMs: number;
  tEndMs: number;
};

export type Recogniser = (window: AudioWindow) => Promise<RecognisedWord[]>;

export type Progress = {
  index: number;
  total: number;
  /** True when the window was passed over as silence. */
  skipped: boolean;
};

export type TranscribeOptions = WindowOptions & StitchOptions & {
  onProgress?: (progress: Progress) => void;
  /**
   * Detected speech. When given, windows without enough speech in them are
   * never shown to the model — which is how silence hallucinations are
   * prevented rather than filtered out afterwards. Omit to transcribe
   * everything.
   */
  speech?: readonly SpeechRegion[];
  /** How much speech a window needs before it is worth transcribing. */
  minSpeechMsPerWindow?: number;
};

export async function transcribePcm(
  samples: Float32Array,
  recognise: Recogniser,
  options: TranscribeOptions = {},
): Promise<Word[]> {
  const windows = sliceWindows(samples, options);
  const recognised: AsrWindow[] = [];

  const minSpeechMs = options.minSpeechMsPerWindow ?? 200;

  for (const window of windows) {
    if (options.speech) {
      const windowMs = Math.round((window.samples.length / SAMPLE_RATE) * 1000);
      const speechMs = speechMsInRange(options.speech, window.startMs, window.startMs + windowMs);

      if (speechMs < minSpeechMs) {
        recognised.push({ words: [] });
        options.onProgress?.({ index: window.index, total: windows.length, skipped: true });
        continue;
      }
    }

    let words: RecognisedWord[];
    try {
      words = await recognise(window);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`transcription failed on window ${window.index}: ${reason}`, { cause });
    }

    recognised.push({
      words: words.map((word) => ({
        text: word.text,
        tStartMs: window.startMs + word.tStartMs,
        tEndMs: window.startMs + word.tEndMs,
      })),
    });

    options.onProgress?.({ index: window.index, total: windows.length, skipped: false });
  }

  return stitchWindows(recognised, options);
}
