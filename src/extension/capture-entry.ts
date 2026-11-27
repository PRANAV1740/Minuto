/**
 * Console entry point for the DOM capture. Bundled to a self-contained script
 * you paste into devtools during a real Meet call.
 *
 * Kept separate from capture-fixture.ts so that module stays importable by the
 * tests without running on import.
 */

import { captureReport } from './capture-fixture.ts';

const report = captureReport(document);
const json = JSON.stringify(report, null, 2);

console.log('%c[Minuto] DOM capture — no meeting content included', 'font-weight:bold');
console.log(json);

// Kept on the window so it can be re-read or re-copied without running again.
(globalThis as unknown as Record<string, unknown>).minutoCapture = report;

navigator.clipboard
  ?.writeText(json)
  .then(() => console.log('[Minuto] copied to clipboard — paste it back to share'))
  .catch(() =>
    console.log('[Minuto] clipboard refused; copy the JSON above, or run: copy(minutoCapture)'),
  );
