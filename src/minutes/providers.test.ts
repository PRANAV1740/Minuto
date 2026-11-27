import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveProvider, buildRequest, extractText } from './providers.ts';

const KEY = 'test-key-not-real';

// ---------- resolveProvider ----------

test('no key means no provider', () => {
  assert.equal(resolveProvider({}), null);
});

test('a blank key means no provider', () => {
  assert.equal(resolveProvider({ MINUTO_API_KEY: '   ' }), null);
});

test('a key alone defaults to Gemini', () => {
  const config = resolveProvider({ MINUTO_API_KEY: KEY });
  assert.equal(config?.provider, 'gemini');
  assert.ok(config!.model.length > 0);
});

test('the provider can be chosen explicitly', () => {
  assert.equal(resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'groq' })?.provider, 'groq');
});

test('the provider name is case-insensitive', () => {
  assert.equal(resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'GROQ' })?.provider, 'groq');
});

test('each provider has its own default model', () => {
  const gemini = resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'gemini' })!;
  const groq = resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'groq' })!;
  assert.notEqual(gemini.model, groq.model);
});

test('the model can be overridden', () => {
  const config = resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_MODEL: 'some-other-model' });
  assert.equal(config?.model, 'some-other-model');
});

test('an OpenAI-compatible endpoint needs a base URL', () => {
  assert.throws(
    () => resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'openai-compatible' }),
    /base url/i,
  );
});

test('an OpenAI-compatible endpoint takes the given base URL', () => {
  const config = resolveProvider({
    MINUTO_API_KEY: KEY,
    MINUTO_PROVIDER: 'openai-compatible',
    MINUTO_BASE_URL: 'https://example.test/v1',
  });
  assert.equal(config?.baseUrl, 'https://example.test/v1');
});

test('an unknown provider is rejected by name', () => {
  assert.throws(
    () => resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'wishful' }),
    /wishful/,
  );
});

// ---------- buildRequest ----------

const PROMPT = { system: 'be careful', user: 'the sentences' };

test('a Gemini request names the model and asks for JSON', () => {
  const config = resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'gemini' })!;
  const request = buildRequest(config, PROMPT);

  assert.match(request.url, /generateContent/);
  assert.ok(request.url.includes(config.model));
  assert.match(JSON.stringify(request.body), /application\/json/);
});

test('a Gemini request sends the key as a header, never in the URL', () => {
  const config = resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'gemini' })!;
  const request = buildRequest(config, PROMPT);

  assert.equal(request.headers['x-goog-api-key'], KEY);
  assert.equal(request.url.includes(KEY), false, 'the key must not appear in the URL');
});

test('a Gemini request carries the system prompt separately', () => {
  const config = resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'gemini' })!;
  const body = JSON.stringify(buildRequest(config, PROMPT).body);

  assert.match(body, /systemInstruction/);
  assert.match(body, /be careful/);
  assert.match(body, /the sentences/);
});

test('a Groq request posts chat completions with a bearer token', () => {
  const config = resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'groq' })!;
  const request = buildRequest(config, PROMPT);

  assert.match(request.url, /chat\/completions$/);
  assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(request.url.includes(KEY), false);
});

test('a Groq request sends both messages and asks for a JSON object', () => {
  const config = resolveProvider({ MINUTO_API_KEY: KEY, MINUTO_PROVIDER: 'groq' })!;
  const body = buildRequest(config, PROMPT).body as {
    messages: { role: string; content: string }[];
    response_format?: { type: string };
  };

  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user']);
  assert.equal(body.response_format?.type, 'json_object');
});

test('an OpenAI-compatible request uses the given base URL', () => {
  const config = resolveProvider({
    MINUTO_API_KEY: KEY,
    MINUTO_PROVIDER: 'openai-compatible',
    MINUTO_BASE_URL: 'https://example.test/v1',
  })!;
  assert.equal(buildRequest(config, PROMPT).url, 'https://example.test/v1/chat/completions');
});

test('a trailing slash on the base URL does not double up', () => {
  const config = resolveProvider({
    MINUTO_API_KEY: KEY,
    MINUTO_PROVIDER: 'openai-compatible',
    MINUTO_BASE_URL: 'https://example.test/v1/',
  })!;
  assert.equal(buildRequest(config, PROMPT).url, 'https://example.test/v1/chat/completions');
});

// ---------- extractText ----------

test('text is read out of a Gemini response', () => {
  const response = { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] };
  assert.equal(extractText('gemini', response), '{"ok":true}');
});

test('several Gemini parts are joined', () => {
  const response = { candidates: [{ content: { parts: [{ text: '{"ok":' }, { text: 'true}' }] } }] };
  assert.equal(extractText('gemini', response), '{"ok":true}');
});

test('text is read out of an OpenAI-shaped response', () => {
  const response = { choices: [{ message: { content: '{"ok":true}' } }] };
  assert.equal(extractText('groq', response), '{"ok":true}');
});

test('an empty Gemini response is an error', () => {
  assert.throws(() => extractText('gemini', { candidates: [] }), /no text/i);
});

test('an empty OpenAI-shaped response is an error', () => {
  assert.throws(() => extractText('groq', { choices: [] }), /no text/i);
});

test('a response that is not an object is an error', () => {
  assert.throws(() => extractText('groq', 'nope'), /no text/i);
});

test('a Gemini refusal with no parts is an error rather than empty minutes', () => {
  assert.throws(
    () => extractText('gemini', { candidates: [{ finishReason: 'SAFETY' }] }),
    /no text/i,
  );
});
