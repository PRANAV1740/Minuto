/**
 * Picks which Whisper model to run, from what the machine can actually do.
 *
 * The locked decision is that tier A is the target (docs/ARCHITECTURE.md §1),
 * but a user's machine decides what it gets, and guessing wrong in either
 * direction is costly: too large and transcription falls behind the meeting,
 * too small and Hinglish falls apart.
 *
 * The specific trap this exists to catch: on a laptop with both a discrete and
 * an integrated GPU, Chrome often hands WebGPU the **integrated** one. That
 * presents as "Whisper is slow", not as a misconfiguration, so it is worth a
 * day of someone's life if it is not named. Hence the warning, and hence
 * preferring a measured speed over the adapter's name whenever one exists.
 */

export type AdapterInfo = {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
};

export type TierName = 'A' | 'B' | 'C';

export type TierSpec = {
  model: string;
  dtype: 'q4' | 'q8' | 'fp32';
  label: string;
};

export const TIERS: Record<TierName, TierSpec> = {
  A: { model: 'onnx-community/whisper-large-v3-turbo', dtype: 'q4', label: 'high accuracy' },
  B: { model: 'onnx-community/whisper-small', dtype: 'q8', label: 'balanced' },
  C: { model: 'onnx-community/whisper-base', dtype: 'q8', label: 'light' },
};

export type TierChoice = TierSpec & {
  tier: TierName;
  reason: string;
  warning?: string;
};

const WRONG_GPU_WARNING =
  'Chrome may be using the integrated GPU. In Windows Graphics Settings, ' +
  'set Chrome to High performance, then reload.';

/** Markers of a dedicated GPU, which beat the integrated markers below. */
const DISCRETE = /geforce|\brtx\b|\bgtx\b|quadro|tesla|radeon\s*(rx|pro)|\barc\b/i;

/** Markers of shared-memory graphics that are genuinely weak. */
const INTEGRATED = /uhd|iris|hd graphics|integrated|\bvega\b|radeon\s*(\(tm\)\s*)?graphics|\bgen-|adreno|mali/i;

export function looksIntegrated(adapter: AdapterInfo | null | undefined): boolean {
  if (!adapter) return false;

  const text = [adapter.vendor, adapter.architecture, adapter.device, adapter.description]
    .filter((part): part is string => typeof part === 'string')
    .join(' ');

  // Apple silicon shares memory with the CPU but is not a weak GPU, so the
  // shared-memory heuristic must not catch it.
  if (/apple/i.test(text)) return false;

  if (DISCRETE.test(text)) return false;
  return INTEGRATED.test(text);
}

function identifiable(adapter: AdapterInfo | null | undefined): boolean {
  if (!adapter) return false;
  return [adapter.vendor, adapter.architecture, adapter.device, adapter.description].some(
    (part) => typeof part === 'string' && part.trim() !== '',
  );
}

export function chooseTier(input: {
  hasWebGpu: boolean;
  adapter?: AdapterInfo | null;
  /** Measured transcription speed as a multiple of realtime, when known. */
  benchmarkRealtime?: number;
}): TierChoice {
  const { hasWebGpu, adapter, benchmarkRealtime } = input;

  if (!hasWebGpu) {
    return {
      ...TIERS.C,
      tier: 'C',
      reason: 'WebGPU unavailable — falling back to the lightest model',
    };
  }

  const integrated = looksIntegrated(adapter);

  // A measurement beats any guess from the adapter's name, which is why the
  // benchmark exists: names are unreliable and throughput is the thing that
  // actually matters.
  if (benchmarkRealtime !== undefined) {
    const tier: TierName = benchmarkRealtime >= 2 ? 'A' : benchmarkRealtime >= 1 ? 'B' : 'C';
    const suspicious = integrated ? benchmarkRealtime < 2 : benchmarkRealtime < 1;

    return {
      ...TIERS[tier],
      tier,
      reason: `measured ${benchmarkRealtime.toFixed(1)}x realtime`,
      ...(suspicious ? { warning: WRONG_GPU_WARNING } : {}),
    };
  }

  if (integrated) {
    return {
      ...TIERS.B,
      tier: 'B',
      reason: 'adapter looks like integrated graphics',
      warning: WRONG_GPU_WARNING,
    };
  }

  if (!identifiable(adapter)) {
    return { ...TIERS.B, tier: 'B', reason: 'adapter could not be identified — being cautious' };
  }

  return { ...TIERS.A, tier: 'A', reason: 'adapter looks like a dedicated GPU' };
}
