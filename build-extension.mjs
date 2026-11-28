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

/**
 * onnxruntime-web's WASM runtime, shipped inside the extension.
 *
 * Measured in a real call: transformers.js defaults to importing these from
 * jsDelivr at run time, and Manifest V3 forbids an extension loading script
 * from a remote origin, so the model never loaded —
 *
 *   no available backend found. ERR: [webgpu] TypeError: Failed to fetch
 *   dynamically imported module: https://cdn.jsdelivr.net/npm/onnxruntime-web
 *
 * Copying them in and pointing `wasmPaths` at the extension's own URL is the
 * fix. All variants are copied rather than the one we expect to be used:
 * which of jsep/asyncify/jspi ORT reaches for depends on the browser's WASM
 * feature detection, and being wrong costs another whole meeting to discover.
 */
const ORT_DIR = 'node_modules/onnxruntime-web/dist';
const ORT_OUT = join(OUT, 'ort');

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

  await copyOnnxRuntime();
}

async function copyOnnxRuntime() {
  await mkdir(ORT_OUT, { recursive: true });

  const runtime = (await readdir(ORT_DIR)).filter(
    (file) => file.startsWith('ort-wasm') && (file.endsWith('.mjs') || file.endsWith('.wasm')),
  );

  if (runtime.length === 0) {
    throw new Error(
      `no onnxruntime-web runtime files in ${ORT_DIR} — the extension would fall back to the ` +
        'CDN, which Manifest V3 blocks. Run npm install.',
    );
  }

  for (const file of runtime) {
    await copyFile(join(ORT_DIR, file), join(ORT_OUT, file));
  }

  console.log(`copied ${runtime.length} onnxruntime files -> ${ORT_OUT}`);
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
