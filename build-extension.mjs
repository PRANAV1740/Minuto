/**
 * Bundles the Chrome extension into dist/extension.
 *
 * esbuild rather than a framework bundler: an MV3 extension is three or four
 * independent entry points with no shared runtime, and content scripts cannot
 * use ES module imports at all, so bundling is the only requirement here.
 *
 *   node build-extension.mjs [--watch]
 */

import { build, context } from 'esbuild';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const SRC = 'src/extension';
const OUT = 'dist/extension';

/** Entry points, each bundled to its own file named in the manifest. */
const ENTRIES = ['content.ts', 'background.ts', 'panel.ts', 'offscreen.ts'];

/** Copied verbatim: a worklet loads by URL into its own realm. */
const VERBATIM = ['worklet.js'];

const options = {
  entryPoints: ENTRIES.map((entry) => join(SRC, entry)),
  outdir: OUT,
  bundle: true,
  format: 'esm',
  target: 'chrome116',
  platform: 'browser',
  sourcemap: 'inline',
  logLevel: 'info',
};

async function copyStatic() {
  await mkdir(OUT, { recursive: true });
  const files = await readdir(SRC);

  for (const file of files) {
    const isStatic = file.endsWith('.json') || file.endsWith('.html') || file.endsWith('.css');
    if (isStatic || VERBATIM.includes(file)) {
      await copyFile(join(SRC, file), join(OUT, file));
    }
  }
}

/**
 * The DOM capture is pasted into devtools rather than loaded by the manifest,
 * so it is built as a single self-contained script with no module syntax.
 */
const captureOptions = {
  entryPoints: [join(SRC, 'capture-entry.ts')],
  outfile: join(OUT, 'capture.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome116',
  platform: 'browser',
  logLevel: 'info',
};

const watch = process.argv.includes('--watch');

await copyStatic();

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log(`watching ${SRC} -> ${OUT}`);
} else {
  await build(options);
  await build(captureOptions);
  console.log(`built ${OUT}`);
}
