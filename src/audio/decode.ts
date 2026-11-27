/**
 * Decodes any audio file to the mono 16 kHz float samples Whisper expects.
 *
 * ffmpeg does the work rather than a JavaScript decoder, because the formats
 * that actually arrive from a meeting — WebM/Opus from a tab capture, M4A from
 * a phone, whatever a user drags in — are a codec problem, not a parsing
 * problem. One external tool handles all of them; hand-rolling that is the
 * wrong fight.
 *
 * Every failure here is loud. Silently returning an empty or silent buffer
 * would surface much later as "Whisper produced nothing", which is a far worse
 * thing to debug than a decode error.
 */

import { spawn } from 'node:child_process';

import { SAMPLE_RATE } from './windows.ts';

export type DecodeOptions = {
  sampleRate?: number;
  /** Overridable mainly so a missing binary can be tested. */
  ffmpegPath?: string;
};

/** Keeps the useful end of ffmpeg's complaint without pasting a wall of it. */
function lastLines(text: string, count = 3): string {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .join('; ');
}

export function decodeToPcm(
  filePath: string,
  options: DecodeOptions = {},
): Promise<Float32Array> {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE;
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';

  return new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner',
      '-nostdin',
      '-loglevel', 'error',
      '-i', filePath,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(new Error(
          `ffmpeg not found at "${ffmpegPath}". Install it and make sure it is on PATH.`,
        ));
        return;
      }
      reject(new Error(`ffmpeg failed to start: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        // ffmpeg refuses to write an empty stream, so a file whose only track
        // is video fails here rather than at the empty-output check below.
        // Worth naming precisely: it is the one failure a user can fix.
        if (/does not contain any stream|matches no streams/i.test(stderr)) {
          reject(new Error(`no audio found in ${filePath} — does it have an audio track?`));
          return;
        }
        reject(new Error(
          `ffmpeg could not decode ${filePath} (exit ${code}): ${lastLines(stderr) || 'no error output'}`,
        ));
        return;
      }

      const raw = Buffer.concat(chunks);
      if (raw.length < 4) {
        reject(new Error(`no audio found in ${filePath} — does it have an audio track?`));
        return;
      }

      // Copy into a fresh buffer so the Float32Array view is 4-byte aligned;
      // a pooled Buffer's byteOffset is not guaranteed to be.
      const usable = raw.length - (raw.length % 4);
      const aligned = new Uint8Array(usable);
      aligned.set(raw.subarray(0, usable));

      resolve(new Float32Array(aligned.buffer));
    });
  });
}
