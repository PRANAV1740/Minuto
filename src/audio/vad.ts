/**
 * Finds the parts of a recording that contain speech.
 *
 * This is not an optimisation. Whisper hallucinates confidently on silence —
 * it emits plausible sentences like "Thank you for watching" over a quiet
 * stretch, and those phantoms then feed the summariser and end up in minutes
 * nobody said. Keeping silence away from the model is the single highest-value
 * accuracy guard in the pipeline (docs/ACCURACY.md §3).
 *
 * Detection is energy-based: frame the signal, measure each frame's RMS, and
 * take the loud parts. The design sketched Silero VAD, and Silero remains the
 * upgrade — it distinguishes speech from non-speech *noise*, which energy
 * cannot. But the failure being guarded against here is silence, which is
 * exactly what energy measures, and this version needs no model download and
 * is fully testable. `detectSpeech` is the seam Silero drops into later.
 *
 * The threshold is adaptive rather than fixed, because recording levels vary
 * enormously between a laptop mic and a tab capture, and any absolute value
 * would be wrong for one of them.
 */

import { SAMPLE_RATE } from './windows.ts';

export type SpeechRegion = {
  startMs: number;
  endMs: number;
};

export type VadOptions = {
  /** Analysis frame length. Shorter is more precise and more jittery. */
  frameMs?: number;
  /** Where the threshold sits between the noise floor and the loud part. */
  sensitivity?: number;
  /** Regions shorter than this are noise, not speech. */
  minSpeechMs?: number;
  /** Gaps shorter than this are breaths, not pauses, so they do not split. */
  minSilenceMs?: number;
  /** Kept either side of a region, so onsets are not clipped. */
  padMs?: number;
};

const DEFAULTS = {
  frameMs: 30,
  sensitivity: 0.3,
  minSpeechMs: 250,
  minSilenceMs: 500,
  padMs: 200,
} as const;

/** Below this RMS even the loudest frame is silence, not quiet speech. */
const ABSOLUTE_FLOOR = 1e-4;

function rmsPerFrame(samples: Float32Array, frameLength: number): number[] {
  const frames: number[] = [];

  for (let start = 0; start + frameLength <= samples.length; start += frameLength) {
    let sum = 0;
    for (let i = start; i < start + frameLength; i++) {
      const value = samples[i]!;
      sum += value * value;
    }
    frames.push(Math.sqrt(sum / frameLength));
  }

  return frames;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index]!;
}

export function detectSpeech(
  samples: Float32Array,
  options: VadOptions = {},
): SpeechRegion[] {
  const frameMs = options.frameMs ?? DEFAULTS.frameMs;
  const sensitivity = options.sensitivity ?? DEFAULTS.sensitivity;
  const minSpeechMs = options.minSpeechMs ?? DEFAULTS.minSpeechMs;
  const minSilenceMs = options.minSilenceMs ?? DEFAULTS.minSilenceMs;
  const padMs = options.padMs ?? DEFAULTS.padMs;

  const frameLength = Math.max(1, Math.round((frameMs / 1000) * SAMPLE_RATE));
  const energies = rmsPerFrame(samples, frameLength);
  if (energies.length === 0) return [];

  const sorted = [...energies].sort((a, b) => a - b);
  const floor = percentile(sorted, 0.1);
  const peak = percentile(sorted, 0.9);

  // Nothing in the clip is loud enough to be speech at all.
  if (peak < ABSOLUTE_FLOOR) return [];

  // Sits a fraction of the way up the clip's own dynamic range. For a clip
  // that is uniformly loud, floor and peak coincide and the comparison below
  // is inclusive, so the whole clip counts as speech.
  const threshold = Math.max(floor + (peak - floor) * sensitivity, ABSOLUTE_FLOOR);

  // ---- loud frames into raw regions ----
  const raw: SpeechRegion[] = [];
  let openedAt: number | null = null;

  energies.forEach((energy, index) => {
    const loud = energy >= threshold;
    if (loud && openedAt === null) {
      openedAt = index;
    } else if (!loud && openedAt !== null) {
      raw.push({ startMs: openedAt * frameMs, endMs: index * frameMs });
      openedAt = null;
    }
  });
  if (openedAt !== null) {
    raw.push({ startMs: openedAt * frameMs, endMs: energies.length * frameMs });
  }

  // ---- close short gaps ----
  const merged: SpeechRegion[] = [];
  for (const region of raw) {
    const previous = merged.at(-1);
    if (previous && region.startMs - previous.endMs < minSilenceMs) {
      previous.endMs = region.endMs;
    } else {
      merged.push({ ...region });
    }
  }

  // ---- drop blips, then pad ----
  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);

  return merged
    .filter((region) => region.endMs - region.startMs >= minSpeechMs)
    .map((region) => ({
      startMs: Math.max(0, region.startMs - padMs),
      endMs: Math.min(durationMs, region.endMs + padMs),
    }));
}

/**
 * How many milliseconds of detected speech fall inside a time range. Used to
 * decide whether a window is worth handing to the model at all.
 */
export function speechMsInRange(
  regions: readonly SpeechRegion[],
  startMs: number,
  endMs: number,
): number {
  let total = 0;

  for (const region of regions) {
    const from = Math.max(region.startMs, startMs);
    const to = Math.min(region.endMs, endMs);
    if (to > from) total += to - from;
  }

  return total;
}
