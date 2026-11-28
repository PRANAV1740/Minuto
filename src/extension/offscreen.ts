/**
 * The offscreen document: where audio and the model live.
 *
 * A service worker has no DOM, and tab capture, an AudioContext and WebGPU all
 * need one, so this hidden page does the heavy work. Everything here runs on
 * the user's machine and nothing leaves it — that is the whole cost argument
 * (docs/ARCHITECTURE.md §1) and the privacy claim at the same time.
 *
 * Two deliberate separations:
 *
 *   1. **Capture works whether or not the model loads.** Audio is windowed and
 *      reported regardless, so "can we capture?" and "can we transcribe?" fail
 *      independently instead of looking like one problem.
 *
 *   2. **Playback is separate from analysis.** Tab capture takes the tab's
 *      audio away from the speakers, so the stream is also piped to an <audio>
 *      element — otherwise the user's meeting goes silent, which would be a
 *      spectacular way to fail. Playback stays at full quality while analysis
 *      runs in a 16 kHz context, which is what Whisper wants.
 *
 * NOT YET VERIFIED in Chrome. Running transformers.js inside an MV3 offscreen
 * document has known friction (WASM paths, the extension CSP, model fetching),
 * and none of it can be checked without loading the extension. Capture and ASR
 * report their status separately so a real run says which half is at fault.
 */

import { detectSpeech } from '../audio/vad.ts';
import { chunksToWords } from '../asr/whisper.ts';
import { createStreamWindower, type StreamWindow } from './stream-windows.ts';
import { chooseTier, type AdapterInfo, type TierChoice } from './tier.ts';
import type { Word } from '../asr/stitch.ts';

const SAMPLE_RATE = 16_000;
const WINDOW_SEC = 30;
const OVERLAP_SEC = 5;
/** A window needs this much speech in it to be worth transcribing. */
const MIN_SPEECH_MS = 200;

type Status = {
  capturing: boolean;
  tier: TierChoice | null;
  adapter: AdapterInfo | null;
  modelReady: boolean;
  captureError: string | null;
  modelError: string | null;
  micEnabled: boolean;
  audioMs: number;
  windowsSeen: number;
  windowsSkipped: number;
  words: number;
};

const status: Status = {
  capturing: false,
  tier: null,
  adapter: null,
  modelReady: false,
  captureError: null,
  modelError: null,
  micEnabled: false,
  audioMs: 0,
  windowsSeen: 0,
  windowsSkipped: 0,
  words: 0,
};

const words: Word[] = [];
let context: AudioContext | null = null;
let playback: HTMLAudioElement | null = null;
let streams: MediaStream[] = [];
let windower = createStreamWindower({ windowSec: WINDOW_SEC, overlapSec: OVERLAP_SEC, sampleRate: SAMPLE_RATE });
let recognise: ((window: StreamWindow) => Promise<Word[]>) | null = null;
let pending: Promise<void> = Promise.resolve();

// ------------------------------------------------------------------ the model

// WebGPU is not in TypeScript's DOM library yet, and only two shapes are
// needed here — cheaper than a dependency for the whole API surface.
type GpuAdapterLike = { info?: AdapterInfo };
type GpuLike = {
  requestAdapter(options?: { powerPreference?: 'low-power' | 'high-performance' }): Promise<GpuAdapterLike | null>;
};

/**
 * The GPU's real name, from WebGL rather than WebGPU.
 *
 * `GPUAdapter.info` is masked for privacy — on Chrome a correctly configured
 * RTX laptop reports no more than "nvidia" and "ampere", and a misconfigured
 * one reports "intel" and "gen-12lp". Neither tells a person what to do.
 * `WEBGL_debug_renderer_info` gives the board name, which is both a better
 * signal for the tier and something the panel can show.
 */
function probeRenderer(): string | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2', { powerPreference: 'high-performance' }) ??
      canvas.getContext('webgl', { powerPreference: 'high-performance' })) as
      | WebGLRenderingContext
      | null;
    if (!gl) return null;

    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const value = debug
      ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);

    return typeof value === 'string' && value.trim() !== '' ? value : null;
  } catch {
    return null;
  }
}

/** What WebGPU reports about the GPU it gave us, if it gave us one. */
async function probeAdapter(): Promise<{ hasWebGpu: boolean; adapter: AdapterInfo | null }> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu;
  if (!gpu) return { hasWebGpu: false, adapter: null };

  try {
    // 'high-performance' is the request that matters on a dual-GPU laptop.
    // Chrome may ignore it, which is exactly why tier.ts warns about it.
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { hasWebGpu: false, adapter: null };

    return { hasWebGpu: true, adapter: adapter.info ?? null };
  } catch {
    return { hasWebGpu: false, adapter: null };
  }
}

async function loadModel(): Promise<void> {
  const probe = await probeAdapter();
  const renderer = probeRenderer();
  status.adapter =
    probe.adapter || renderer ? { ...(probe.adapter ?? {}), ...(renderer ? { renderer } : {}) } : null;
  status.tier = chooseTier({ hasWebGpu: probe.hasWebGpu, adapter: status.adapter });

  console.info('[Minuto] tier', status.tier, 'adapter', probe.adapter);

  try {
    const { pipeline, env } = await import('@huggingface/transformers');

    // Models are fetched from the hub; nothing is bundled and nothing local is
    // expected.
    env.allowLocalModels = false;

    // Measured in a real call, and the reason nothing transcribed:
    //
    //   no available backend found. ERR: [webgpu] TypeError: Failed to fetch
    //   dynamically imported module: https://cdn.jsdelivr.net/npm/
    //   onnxruntime-web@.../ort-wasm-simd-threaded.asyncify.mjs
    //
    // transformers.js imports onnxruntime's WASM runtime from jsDelivr at run
    // time, and Manifest V3 refuses to load script from a remote origin —
    // `script-src 'self'` is not a setting we can relax, it is the rule that
    // makes extensions auditable. So the runtime ships inside the extension
    // (build-extension.mjs) and ORT is pointed at it.
    //
    // A string path, not an object: an object switches on the library's own
    // blob-caching path, which fetches the files itself and lands back in the
    // same prohibition.
    const onnx = env.backends.onnx as { wasm?: Record<string, unknown> };
    if (onnx.wasm) {
      onnx.wasm.wasmPaths = chrome.runtime.getURL('ort/');

      // Threads need SharedArrayBuffer, which needs cross-origin isolation,
      // which an extension page does not have. Asking for them produces a
      // failure that reads like a missing file.
      onnx.wasm.numThreads = 1;
    }

    const transcriber = await pipeline('automatic-speech-recognition', status.tier.model, {
      dtype: status.tier.dtype,
      device: probe.hasWebGpu ? 'webgpu' : 'wasm',
    });

    recognise = async (window) => {
      const raw = (await transcriber(window.samples, { return_timestamps: true })) as {
        chunks?: { text?: string; timestamp?: readonly [number | null, number | null] }[];
      };

      const windowMs = Math.round((window.samples.length / SAMPLE_RATE) * 1000);
      return chunksToWords(raw.chunks ?? [], windowMs).map((word) => ({
        text: word.text,
        tStartMs: window.startMs + word.tStartMs,
        tEndMs: window.startMs + word.tEndMs,
      }));
    };

    status.modelReady = true;
    console.info('[Minuto] model ready');
  } catch (error) {
    status.modelError = error instanceof Error ? error.message : String(error);
    console.error('[Minuto] model failed to load', error);
  }
}

// ----------------------------------------------------------------- the audio

/** Transcribes windows one at a time; the GPU gains nothing from overlap. */
function enqueue(window: StreamWindow): void {
  status.windowsSeen++;

  // Silence is never shown to the model — it invents sentences over it
  // (docs/ACCURACY.md §3).
  const speech = detectSpeech(window.samples);
  const speechMs = speech.reduce((sum, region) => sum + (region.endMs - region.startMs), 0);
  if (speechMs < MIN_SPEECH_MS) {
    status.windowsSkipped++;
    return;
  }

  if (!recognise) return;

  pending = pending.then(async () => {
    try {
      const found = await recognise!(window);
      words.push(...found);
      status.words = words.length;
    } catch (error) {
      status.modelError = error instanceof Error ? error.message : String(error);
    }
  });
}

async function startCapture(streamId: string): Promise<void> {
  if (status.capturing) return;

  try {
    const tab = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
      },
    } as MediaStreamConstraints);
    streams.push(tab);

    // Give the tab's audio back to the user, or the meeting goes silent.
    playback = new Audio();
    playback.srcObject = tab;
    await playback.play().catch(() => {});

    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    await context.audioWorklet.addModule(chrome.runtime.getURL('worklet.js'));

    const node = new AudioWorkletNode(context, 'minuto-recorder');
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const window of windower.push(event.data)) enqueue(window);
      status.audioMs = windower.totalMs();
    };

    context.createMediaStreamSource(tab).connect(node);

    // Your own voice is not in the tab's output, so the microphone is a second
    // source. Optional: a refused permission must not stop the rest.
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      streams.push(mic);
      context.createMediaStreamSource(mic).connect(node);
      status.micEnabled = true;
    } catch {
      status.micEnabled = false;
    }

    status.capturing = true;
    console.info('[Minuto] capturing', { mic: status.micEnabled });
  } catch (error) {
    status.captureError = error instanceof Error ? error.message : String(error);
    console.error('[Minuto] capture failed', error);
  }
}

async function stopCapture(): Promise<void> {
  for (const window of windower.flush()) enqueue(window);
  await pending;

  for (const stream of streams) {
    for (const track of stream.getTracks()) track.stop();
  }
  streams = [];

  playback?.pause();
  playback = null;

  await context?.close().catch(() => {});
  context = null;

  windower = createStreamWindower({ windowSec: WINDOW_SEC, overlapSec: OVERLAP_SEC, sampleRate: SAMPLE_RATE });
  status.capturing = false;
}

// --------------------------------------------------------------- messaging

type Command =
  | { kind: 'capture-start'; streamId: string }
  | { kind: 'capture-stop' }
  | { kind: 'capture-status' };

chrome.runtime.onMessage.addListener((message: Command, _sender, respond) => {
  if (message.kind === 'capture-start') {
    void startCapture(message.streamId).then(() => respond({ status, words: words.length }));
    return true;
  }

  if (message.kind === 'capture-stop') {
    void stopCapture().then(() => respond({ status, words: words.slice() }));
    return true;
  }

  if (message.kind === 'capture-status') {
    respond({ status, words: words.length });
    return false;
  }

  return false;
});

// The model download is long, so it starts as soon as this document exists
// rather than when the user asks to record.
void loadModel();
