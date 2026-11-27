import { fileURLToPath } from 'node:url';

/**
 * The core pipeline lives in ../src and is imported directly, so the web app,
 * the CLIs and the extension all run the same extraction, gates and rendering
 * code. Nothing is reimplemented per surface.
 *
 * `fileURLToPath` rather than `URL.pathname`: on Windows the latter yields
 * "/P:/Minuto/", whose leading slash breaks path resolution.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  // ../src sits outside this app's folder, so it has to be traced explicitly
  // for a standalone build to include it.
  outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)),
};

export default config;
