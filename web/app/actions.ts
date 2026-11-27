'use server';

/**
 * The one server action behind the workbench.
 *
 * It runs exactly the pipeline the CLI runs — parse, extract, summarise,
 * gates, render — by importing it from ../../src rather than reimplementing
 * anything. A difference between what the web app produces and what
 * `npm run minutes` produces would be a bug by definition.
 */

import { parseTranscript } from '../../src/minutes/parse.ts';
import { buildExtractiveMinutes } from '../../src/minutes/extractive.ts';
import { summariseMinutes } from '../../src/minutes/summarise.ts';
import { createCompleter, resolveProvider } from '../../src/minutes/providers.ts';
import { validateMinutes, type DraftMinutes, type Segment } from '../../src/minutes/validate.ts';
import { renderMinutes } from '../../src/minutes/render.ts';
import { correctWithGlossary } from '../../src/glossary/correct.ts';

export type Flag = { kind: string; text: string; entity: string };
export type Dropped = { kind: string; text: string; reason: string };

export type MinutesResult =
  | {
      ok: true;
      /** Which path wrote the minutes, so the reader knows what they're reading. */
      wrote: string;
      minutes: DraftMinutes;
      segments: Segment[];
      markdown: string;
      flagged: Flag[];
      dropped: Dropped[];
      corrections: { from: string; to: string }[];
      refused: string[];
    }
  | { ok: false; error: string };

const asText = (value: FormDataEntryValue | null): string =>
  typeof value === 'string' ? value.trim() : '';

export async function generateMinutes(
  _previous: MinutesResult | null,
  form: FormData,
): Promise<MinutesResult> {
  const raw = asText(form.get('transcript'));
  if (raw === '') return { ok: false, error: 'Paste a transcript first.' };

  const title = asText(form.get('title')) || undefined;
  const date = asText(form.get('date')) || undefined;
  const useModel = form.get('useModel') === 'on';

  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'The date needs to be YYYY-MM-DD.' };
  }

  const terms = asText(form.get('glossary'))
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term !== '');

  const parsed = parseTranscript(raw);
  if (parsed.length === 0) {
    return { ok: false, error: 'That transcript parsed to nothing — check the format.' };
  }

  // Fix near-misses on known names first, so cue phrases match the right words.
  const corrections: { from: string; to: string }[] = [];
  const segments = parsed.map((segment) => {
    const fixed = correctWithGlossary(segment.text, terms);
    corrections.push(...fixed.corrections);
    return { ...segment, text: fixed.text };
  });

  const options = { title, meetingDate: date };
  let draft: DraftMinutes;
  let refused: string[] = [];
  let wrote = 'extraction';

  let provider = null;
  try {
    provider = useModel ? resolveProvider(process.env) : null;
  } catch {
    provider = null;
  }

  if (provider) {
    try {
      const result = await summariseMinutes(segments, createCompleter(provider), options);
      draft = result.minutes;
      refused = result.rejected;
      wrote = `${provider.provider} / ${provider.model}`;
    } catch (error) {
      // Never leave the user with nothing: extraction always works.
      refused = [`the model failed: ${error instanceof Error ? error.message : String(error)}`];
      draft = buildExtractiveMinutes(segments, options);
      wrote = 'extraction (the model failed)';
    }
  } else {
    draft = buildExtractiveMinutes(segments, options);
  }

  const checked = validateMinutes(draft, segments, { glossary: terms });

  return {
    ok: true,
    wrote,
    minutes: checked.minutes,
    segments,
    markdown: renderMinutes(checked.minutes, segments, { flagged: checked.flagged }),
    flagged: checked.flagged,
    dropped: checked.dropped,
    corrections,
    refused,
  };
}

/** Whether a model is configured, so the form can say so honestly. */
export async function modelAvailable(): Promise<string | null> {
  try {
    const provider = resolveProvider(process.env);
    return provider ? `${provider.provider} / ${provider.model}` : null;
  } catch {
    return null;
  }
}
