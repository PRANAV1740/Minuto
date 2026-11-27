/**
 * Loads evaluation cases from disk.
 *
 * A case is a folder holding an audio file and a `truth.json` describing what
 * was actually said. The format is validated rather than trusted: a fixture
 * with a missing field or a reversed timestamp would quietly skew a score, and
 * a wrong benchmark is worse than no benchmark.
 *
 * See eval/README.md for the format.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

import type { CaptionLine } from '../fusion/captions.ts';
import type { SpeakerSample } from '../fusion/fuse.ts';
import type { Truth } from './score.ts';

const AUDIO_EXTENSIONS = ['wav', 'm4a', 'mp3', 'webm', 'ogg', 'flac', 'opus'] as const;

const SegmentSchema = z
  .object({
    startMs: z.number().nonnegative(),
    endMs: z.number().nonnegative(),
    speaker: z.string().min(1),
    text: z.string().min(1),
  })
  .refine((segment) => segment.endMs > segment.startMs, {
    message: 'segment endMs must be after startMs',
  });

const TruthSchema = z.object({
  name: z.string().min(1).optional(),
  language: z.string().min(1).optional(),
  glossary: z.array(z.string()).default([]),
  segments: z.array(SegmentSchema).min(1, 'a case needs at least one segment'),
  captions: z
    .array(
      z.object({
        speaker: z.string().min(1),
        startMs: z.number().nonnegative(),
        endMs: z.number().nonnegative(),
        text: z.string(),
      }),
    )
    .optional(),
  speakerSamples: z
    .array(z.object({ atMs: z.number().nonnegative(), speaker: z.string().min(1) }))
    .optional(),
});

export type CaseTruth = Truth & {
  captions?: CaptionLine[];
  speakerSamples?: SpeakerSample[];
};

export type EvalCase = {
  dir: string;
  audioPath: string;
  truth: CaseTruth;
};

export function parseTruth(raw: unknown, folderName: string): CaseTruth {
  const parsed = TruthSchema.safeParse(raw);

  if (!parsed.success) {
    // The folder name goes in the message because that is what the person has
    // to go and open.
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'truth'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid case "${folderName}" — ${detail}`);
  }

  return { ...parsed.data, name: parsed.data.name ?? folderName };
}

export async function loadCases(root: string): Promise<EvalCase[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    // No cases directory yet is a normal state for a fresh clone.
    return [];
  }

  const cases: EvalCase[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(root, entry.name);
    const files = await readdir(dir);
    if (!files.includes('truth.json')) continue;

    const audio = files.find((file) =>
      AUDIO_EXTENSIONS.some((extension) => file.toLowerCase() === `audio.${extension}`),
    );
    if (audio === undefined) {
      throw new Error(
        `case "${entry.name}" has a truth.json but no audio file ` +
        `(expected audio.${AUDIO_EXTENSIONS.join(' / audio.')})`,
      );
    }

    const raw = JSON.parse(await readFile(join(dir, 'truth.json'), 'utf8')) as unknown;
    cases.push({ dir, audioPath: join(dir, audio), truth: parseTruth(raw, entry.name) });
  }

  return cases.sort((a, b) => a.truth.name.localeCompare(b.truth.name));
}
