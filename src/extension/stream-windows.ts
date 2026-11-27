/**
 * Cuts a live audio stream into the overlapping windows Whisper is run on.
 *
 * The batch version (src/audio/windows.ts) has the whole recording in hand and
 * can slice it. During a call the audio arrives in small chunks from the
 * capture graph, so windows have to be assembled as they fill — while keeping
 * the overlap that `stitch.ts` needs to join them without losing words.
 *
 * It also has to not accumulate the meeting. A 90-minute call at 16 kHz is
 * about 350 MB of float samples; holding it all would be a leak in a tab the
 * user keeps open. Once a window is emitted, everything before the *next*
 * window's start is dropped, so what is retained stays under one window.
 */

export type StreamWindow = {
  index: number;
  startMs: number;
  samples: Float32Array;
};

export type StreamWindowOptions = {
  windowSec?: number;
  overlapSec?: number;
  sampleRate?: number;
};

export type StreamWindower = {
  /** Adds captured audio, returning any windows that just became complete. */
  push(chunk: Float32Array): StreamWindow[];
  /** Emits the trailing partial window at the end of a call. */
  flush(): StreamWindow[];
  totalMs(): number;
  /** Retained sample count, so the memory bound can be asserted. */
  bufferedSamples(): number;
};

const DEFAULTS = { windowSec: 30, overlapSec: 5, sampleRate: 16_000 } as const;

function concat(left: Float32Array, right: Float32Array): Float32Array {
  if (left.length === 0) return right.slice();
  if (right.length === 0) return left;

  const out = new Float32Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}

export function createStreamWindower(options: StreamWindowOptions = {}): StreamWindower {
  const windowSec = options.windowSec ?? DEFAULTS.windowSec;
  const overlapSec = options.overlapSec ?? DEFAULTS.overlapSec;
  const sampleRate = options.sampleRate ?? DEFAULTS.sampleRate;

  if (overlapSec >= windowSec) {
    throw new Error('createStreamWindower: overlap must be shorter than the window');
  }

  const windowSamples = Math.round(windowSec * sampleRate);
  const hopSamples = Math.round((windowSec - overlapSec) * sampleRate);

  let buffer = new Float32Array(0);
  /** Absolute stream index of buffer[0]. */
  let bufferStart = 0;
  let nextIndex = 0;
  let total = 0;

  const startMsOf = (index: number): number =>
    Math.round(((index * hopSamples) / sampleRate) * 1000);

  return {
    push(chunk) {
      buffer = concat(buffer, chunk);
      total += chunk.length;

      const emitted: StreamWindow[] = [];

      for (;;) {
        const localStart = nextIndex * hopSamples - bufferStart;
        if (localStart + windowSamples > buffer.length) break;

        emitted.push({
          index: nextIndex,
          startMs: startMsOf(nextIndex),
          samples: buffer.slice(localStart, localStart + windowSamples),
        });
        nextIndex++;
      }

      // Anything before the next window's start can never be needed again.
      const keepFrom = nextIndex * hopSamples - bufferStart;
      if (keepFrom > 0) {
        buffer = buffer.slice(keepFrom);
        bufferStart += keepFrom;
      }

      return emitted;
    },

    flush() {
      const localStart = nextIndex * hopSamples - bufferStart;
      if (localStart >= buffer.length) return [];

      const samples = buffer.slice(localStart);
      if (samples.length === 0) return [];

      const window = { index: nextIndex, startMs: startMsOf(nextIndex), samples };
      nextIndex++;

      // Consumed, so flushing twice cannot emit the tail twice.
      bufferStart = nextIndex * hopSamples;
      buffer = new Float32Array(0);

      return [window];
    },

    totalMs() {
      return Math.round((total / sampleRate) * 1000);
    },

    bufferedSamples() {
      return buffer.length;
    },
  };
}
