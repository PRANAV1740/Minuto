/**
 * Talks to whichever language model the user has a key for.
 *
 * Bring-your-own-key, from the environment, because the architecture needs
 * Minuto to cost its users nothing and cost its author nothing either
 * (docs/ARCHITECTURE.md §5). Gemini and Groq both have free tiers generous
 * enough for a few meetings a day, and an OpenAI-compatible base URL covers
 * anything else, including a model running locally.
 *
 * Request building and response reading are separated from the network call so
 * both are tested without a key. The key itself is only ever sent as a header:
 * putting it in a URL would leak it into history, logs and error reports.
 */

import type { Completer, Prompt } from './abstract.ts';

export type ProviderName = 'gemini' | 'groq' | 'openai-compatible';

export type ProviderConfig = {
  provider: ProviderName;
  model: string;
  apiKey: string;
  baseUrl?: string;
};

export type HttpRequest = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
};

const DEFAULT_MODELS: Record<ProviderName, string> = {
  gemini: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  'openai-compatible': 'gpt-4o-mini',
};

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_BASE = 'https://api.groq.com/openai/v1';

/**
 * Reads the provider out of the environment. Returns null when no key is set,
 * which is a normal state: the caller falls back to extractive minutes.
 */
export function resolveProvider(env: Record<string, string | undefined>): ProviderConfig | null {
  const apiKey = env.MINUTO_API_KEY?.trim();
  if (!apiKey) return null;

  const requested = (env.MINUTO_PROVIDER ?? 'gemini').trim().toLowerCase();
  if (requested !== 'gemini' && requested !== 'groq' && requested !== 'openai-compatible') {
    throw new Error(
      `unknown MINUTO_PROVIDER "${requested}" — expected gemini, groq or openai-compatible`,
    );
  }

  const provider = requested satisfies ProviderName as ProviderName;
  const baseUrl = env.MINUTO_BASE_URL?.trim();

  if (provider === 'openai-compatible' && !baseUrl) {
    throw new Error(
      'a base URL is required for an openai-compatible provider — set MINUTO_BASE_URL',
    );
  }

  return {
    provider,
    model: env.MINUTO_MODEL?.trim() || DEFAULT_MODELS[provider],
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

const withoutTrailingSlash = (url: string): string => url.replace(/\/+$/, '');

export function buildRequest(config: ProviderConfig, prompt: Prompt): HttpRequest {
  if (config.provider === 'gemini') {
    return {
      url: `${withoutTrailingSlash(config.baseUrl ?? GEMINI_BASE)}/models/${config.model}:generateContent`,
      // Header, not a query parameter: a key in a URL ends up in logs.
      headers: { 'content-type': 'application/json', 'x-goog-api-key': config.apiKey },
      body: {
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
      },
    };
  }

  const base = config.provider === 'groq' ? (config.baseUrl ?? GROQ_BASE) : config.baseUrl!;

  return {
    url: `${withoutTrailingSlash(base)}/chat/completions`,
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: {
      model: config.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Pulls the generated text out of a provider's response.
 *
 * An empty response throws rather than returning '': a refusal or a safety
 * block would otherwise look like a model that produced empty minutes.
 */
export function extractText(provider: ProviderName, response: unknown): string {
  if (!isRecord(response)) throw new Error('the provider returned no text');

  if (provider === 'gemini') {
    const candidates = response.candidates;
    const first = Array.isArray(candidates) ? candidates[0] : undefined;
    const content = isRecord(first) ? first.content : undefined;
    const parts = isRecord(content) ? content.parts : undefined;

    const text = Array.isArray(parts)
      ? parts
          .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
          .join('')
      : '';

    if (text.trim() === '') throw new Error('the provider returned no text');
    return text;
  }

  const choices = response.choices;
  const first = Array.isArray(choices) ? choices[0] : undefined;
  const message = isRecord(first) ? first.message : undefined;
  const text = isRecord(message) && typeof message.content === 'string' ? message.content : '';

  if (text.trim() === '') throw new Error('the provider returned no text');
  return text;
}

/** The network call, kept to one small function around the tested parts. */
export function createCompleter(config: ProviderConfig): Completer {
  return async (prompt) => {
    const request = buildRequest(config, prompt);

    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
    });

    if (!response.ok) {
      // The body often explains a quota or key problem; the key is never in it.
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`${config.provider} returned ${response.status}: ${detail}`);
    }

    return extractText(config.provider, await response.json());
  };
}
