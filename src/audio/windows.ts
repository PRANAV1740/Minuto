/**
 * Cuts decoded audio into the overlapping windows Whisper is run on.
 *
 * The overlap exists because a clean cut mid-word costs that word; `stitch.ts`
 * then removes the duplication by matching text. The invariant that matters
 * here is that consecutive windows really do overlap by the requested amount —
 * if a window ever advances by a full window length, the seam has no shared
 * text to match on and the stitcher falls back to a time cut, which is exactly
 * where words go missing.
 */

/** Whisper's native input rate. Decoding resamples to this. */
export const SAMPLE_RATE = 16_000;

export type WindowOptions = {
  windowSec?: number;
  overlapSec?: number;
};

export type PlannedWindow = {
  index: number;
  startSec: number;
  endSec: number;
};

export type AudioWindow = {
  index: number;
  startMs: number;
  samples: Float32Array;
};

const DEFAULTS = { windowSec: 30, overlapSec: 5 } as const;

/** Rounds to millisecond precision so repeated arithmetic cannot drift. */
const toMs = (seconds: number): number => Math.round(seconds * 1000) / 1000;

export function planWindows(
  durationSec: number,
  options: WindowOptions = {},
): PlannedWindow[] {
  const windowSec = options.windowSec ?? DEFAULTS.windowSec;
  const overlapSec = options.overlapSec ?? DEFAULTS.overlapSec;

  if (overlapSec >= windowSec) {
    throw new Error('planWindows: overlap must be shorter than the window');
  }
  if (windowSec <= 0) {
    throw new Error('planWindows: window must be positive');
  }
  if (durationSec <= 0) return [];

  // Rounded UP to the millisecond: rounding down would put the final window's
  // end just short of the duration, and the loop would then add an empty
  // window past it. Slicing clamps, so the extra fraction costs nothing.
  const total = Math.ceil(durationSec * 1000) / 1000;
  const hop = windowSec - overlapSec;
  const windows: PlannedWindow[] = [];

  for (let index = 0; ; index++) {
    // Derived from the index rather than accumulated, so the last window of a
    // long call starts where arithmetic says it should.
    const startSec = toMs(index * hop);
    if (startSec >= total) break;

    const endSec = toMs(Math.min(startSec + windowSec, total));
    windows.push({ index, startSec, endSec });

    // Once a window reaches the end of the audio, another would only repeat
    // material already covered.
    if (endSec >= total) break;
  }

  return windows;
}

export function sliceWindows(
  samples: Float32Array,
  options: WindowOptions = {},
): AudioWindow[] {
  const durationSec = samples.length / SAMPLE_RATE;

  return planWindows(durationSec, options).map((window) => ({
    index: window.index,
    startMs: Math.round(window.startSec * 1000),
    samples: samples.subarray(
      Math.round(window.startSec * SAMPLE_RATE),
      Math.round(window.endSec * SAMPLE_RATE),
    ),
  }));
}
