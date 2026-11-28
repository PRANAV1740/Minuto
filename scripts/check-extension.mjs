/**
 * Preflight for the built extension.
 *
 *   npm run check:ext
 *
 * Catches the failures that would otherwise be discovered by loading the
 * extension in Chrome and reading a terse error — a file the manifest names
 * but the build did not emit, a bundle that does not parse, a page pointing at
 * a script that is not there.
 *
 * Worth having because the one thing this project most needs is a real run in
 * a real meeting, and a wasted attempt costs a meeting rather than a minute.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = 'dist/extension';
const problems = [];
const checked = [];

function check(label, ok, detail = '') {
  checked.push({ label, ok, detail });
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

if (!existsSync(join(OUT, 'manifest.json'))) {
  console.error(`No build found in ${OUT}. Run: npm run build:ext`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(OUT, 'manifest.json'), 'utf8'));

// ---- manifest shape ----
check('manifest version 3', manifest.manifest_version === 3, `got ${manifest.manifest_version}`);
check('has a name', typeof manifest.name === 'string' && manifest.name.length > 0);
check('has a version', /^\d+(\.\d+)*$/.test(manifest.version ?? ''), manifest.version);

// WebAssembly will not run under MV3 without this, and the model needs it.
check(
  'CSP allows wasm',
  /wasm-unsafe-eval/.test(manifest.content_security_policy?.extension_pages ?? ''),
  'offscreen Whisper needs wasm-unsafe-eval',
);

// Narrow host permissions are both a privacy promise and a review question.
check(
  'host permissions limited to Meet',
  JSON.stringify(manifest.host_permissions ?? []) === JSON.stringify(['https://meet.google.com/*']),
  JSON.stringify(manifest.host_permissions),
);

for (const needed of ['tabCapture', 'offscreen', 'sidePanel', 'storage', 'scripting']) {
  check(`permission: ${needed}`, (manifest.permissions ?? []).includes(needed));
}

// ---- every referenced file exists ----
const referenced = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? []),
  manifest.side_panel?.default_path,
  ...(manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources ?? []),
  'offscreen.html',
].filter(Boolean);

for (const file of referenced) {
  check(`file present: ${file}`, existsSync(join(OUT, file)));
}

// ---- the ONNX runtime is shipped, not fetched ----
//
// Manifest V3 refuses to load script from a remote origin, so a missing ort/
// directory does not degrade to a slow first run: the model never loads at
// all, and the error names a CDN rather than this directory.
const ortDir = join(OUT, 'ort');
const ort = existsSync(ortDir) ? readdirSync(ortDir) : [];

check('onnxruntime bundled (not fetched from a CDN)', ort.length > 0, `${ort.length} files`);
for (const variant of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.jsep.mjs']) {
  check(`ort runtime: ${variant}`, ort.includes(variant));
}
check(
  'ort wasm binaries present',
  ort.filter((file) => file.endsWith('.wasm')).length > 0,
);

// ---- pages point at scripts that exist ----
for (const page of ['panel.html', 'offscreen.html']) {
  if (!existsSync(join(OUT, page))) continue;
  const html = readFileSync(join(OUT, page), 'utf8');

  for (const match of html.matchAll(/src="([^"]+)"/g)) {
    const src = match[1];
    if (/^https?:/.test(src)) continue;
    check(`${page} -> ${src}`, existsSync(join(OUT, src)));
  }
}

// ---- every bundle parses ----
for (const file of ['background.js', 'content.js', 'panel.js', 'offscreen.js', 'capture.js', 'worklet.js']) {
  if (!existsSync(join(OUT, file))) continue;
  try {
    execFileSync(process.execPath, ['--check', join(OUT, file)], { stdio: 'pipe' });
    check(`parses: ${file}`, true);
  } catch (error) {
    check(`parses: ${file}`, false, String(error.stderr ?? error).split('\n')[0]);
  }
}

// ---- report ----
for (const { label, ok, detail } of checked) {
  console.log(`${ok ? 'ok   ' : 'FAIL '}${label}${detail && !ok ? ` — ${detail}` : ''}`);
}

console.log(
  problems.length === 0
    ? `\n${checked.length} checks passed — ready to load unpacked from ${OUT}`
    : `\n${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`,
);

process.exit(problems.length === 0 ? 0 : 1);
