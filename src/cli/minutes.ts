/**
 * Transcript in, minutes out.
 *
 *   npm run minutes -- transcript.txt
 *   npm run minutes -- notes.txt --title "Weekly sync" --date 2026-11-25
 *   npm run minutes -- notes.txt --glossary "Geodesis,Pranav,Asha" --json
 *   type notes.txt | npm run minutes
 *
 * With a key in the environment it asks a model to write the minutes from
 * extracted sentences. Without one — or if the model fails — it falls back to
 * extraction, which needs nothing and always works:
 *
 *   $env:MINUTO_API_KEY = "..."         # gemini by default
 *   $env:MINUTO_PROVIDER = "groq"       # or openai-compatible with a base URL
 *
 * Either way every decision and task cites the moment it came from.
 */

import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';

import { parseTranscript } from '../minutes/parse.ts';
import { buildExtractiveMinutes } from '../minutes/extractive.ts';
import { summariseMinutes } from '../minutes/summarise.ts';
import { createCompleter, resolveProvider } from '../minutes/providers.ts';
import { validateMinutes, type DraftMinutes } from '../minutes/validate.ts';
import { renderMinutes } from '../minutes/render.ts';
import { toPlainText, toHtml } from '../minutes/export.ts';
import { correctWithGlossary } from '../glossary/correct.ts';

const USAGE = `
Usage: npm run minutes -- <transcript-file> [options]

  --title <text>       meeting title
  --date <YYYY-MM-DD>  meeting date, so "by Friday" becomes a real date
  --glossary <a,b,c>   names and terms to correct and to count as grounded
  --no-llm             skip the model even if a key is set
  --format <f>         md (default) | txt | html
  --json               print the structured record instead of Markdown

Set MINUTO_API_KEY to have a model write the minutes. Optional:
MINUTO_PROVIDER (gemini | groq | openai-compatible), MINUTO_MODEL,
MINUTO_BASE_URL.
`.trim();

async function readInput(file: string | undefined): Promise<string> {
  if (file !== undefined) return readFile(file, 'utf8');

  if (process.stdin.isTTY) {
    console.error(`No transcript given.\n\n${USAGE}`);
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      title: { type: 'string' },
      date: { type: 'string' },
      glossary: { type: 'string' },
      'no-llm': { type: 'boolean' },
      format: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  if (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) {
    console.error('--date must be YYYY-MM-DD');
    process.exit(1);
  }

  const terms = (values.glossary ?? '')
    .split(',')
    .map((term) => term.trim())
    .filter((term) => term !== '');

  const raw = await readInput(positionals[0]);
  const parsed = parseTranscript(raw);

  if (parsed.length === 0) {
    console.error('Nothing to work with — the transcript parsed to no segments.');
    process.exit(1);
  }

  // Correct near-misses on known names before extraction, so a cue phrase is
  // matched against the right words.
  const corrections: string[] = [];
  const segments = parsed.map((segment) => {
    const fixed = correctWithGlossary(segment.text, terms);
    for (const fix of fixed.corrections) corrections.push(`"${fix.from}" -> "${fix.to}"`);
    return { ...segment, text: fixed.text };
  });

  const options = { title: values.title, meetingDate: values.date };
  const extractive = () => buildExtractiveMinutes(segments, options);

  let draft: DraftMinutes;
  let rejected: string[] = [];
  let wrote = 'extraction (no model)';

  // A model writes the minutes when a key is available. Any failure — no key,
  // spent quota, a refusal, bad JSON — falls back to extraction rather than
  // leaving the user with nothing (docs/ARCHITECTURE.md §5).
  let provider = null;
  try {
    provider = values['no-llm'] ? null : resolveProvider(process.env);
  } catch (error) {
    console.error(`provider not configured: ${error instanceof Error ? error.message : error}`);
  }

  if (provider) {
    try {
      const result = await summariseMinutes(segments, createCompleter(provider), options);
      draft = result.minutes;
      rejected = result.rejected;
      wrote = `${provider.provider} / ${provider.model}`;
    } catch (error) {
      console.error(
        `the model path failed (${error instanceof Error ? error.message : error}) — ` +
        'falling back to extraction',
      );
      draft = extractive();
    }
  } else {
    draft = extractive();
  }

  const checked = validateMinutes(draft, segments, { glossary: terms });

  // Diagnostics to stderr so stdout stays pipeable.
  console.error(
    `written by ${wrote} · ${segments.length} segments · ` +
    `${checked.minutes.decisions.length} decisions · ` +
    `${checked.minutes.actionItems.length} actions · ${checked.minutes.openQuestions.length} questions`,
  );
  if (corrections.length > 0) console.error(`glossary: ${corrections.join(', ')}`);
  for (const refusal of rejected) console.error(`refused: ${refusal}`);
  for (const dropped of checked.dropped) {
    console.error(`dropped (${dropped.reason}): ${dropped.text}`);
  }
  for (const flag of checked.flagged) {
    console.error(`unverified "${flag.entity}" in: ${flag.text}`);
  }

  if (values.json) {
    console.log(JSON.stringify({ minutes: checked.minutes, segments }, null, 2));
    return;
  }

  const format = values.format ?? 'md';
  if (format !== 'md' && format !== 'txt' && format !== 'html') {
    console.error(`unknown --format "${format}" — expected md, txt or html`);
    process.exit(1);
  }

  // All three come from the same structured record, so they cannot disagree.
  if (format === 'txt') console.log(toPlainText(checked.minutes, segments));
  else if (format === 'html') console.log(toHtml(checked.minutes, segments));
  else console.log(renderMinutes(checked.minutes, segments, { flagged: checked.flagged }));
}

await main();
