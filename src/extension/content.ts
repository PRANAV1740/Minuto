/**
 * Runs inside the Meet tab. Reads captions, the roster and who is speaking,
 * and reports what it managed to read.
 *
 * This increment deliberately **only reads**. It does not switch captions on,
 * post to the meeting chat, or capture audio — those change what other people
 * in the call see or hear, and none of them should ship before the readers
 * below are known to work against real markup.
 *
 * The first job of a real run is therefore the diagnostic: whatever it reports
 * is the truth about Meet's current DOM, and src/extension/meet-dom.ts is
 * where the fix goes.
 */

import { createCaptionTracker } from './caption-tracker.ts';
import { captureReport } from './capture-fixture.ts';
import { diagnose, findRoster, readCaptions, findActiveSpeaker } from './meet-dom.ts';
import { meetCodeFrom, type SessionSnapshot, type ToBackground } from './messages.ts';
import type { SpeakerSample } from '../fusion/fuse.ts';

const SPEAKER_SAMPLE_MS = 400;
const ROSTER_REFRESH_MS = 5000;
const REPORT_MS = 2000;

const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;

const tracker = createCaptionTracker(elapsed);
const speakerSamples: SpeakerSample[] = [];
const starsMs: number[] = [];

let roster: string[] = [];
let observer: MutationObserver | null = null;
let observedRoot: Element | null = null;

function snapshot(): SessionSnapshot {
  return {
    meetCode: meetCodeFrom(location.pathname),
    startedAt,
    elapsedMs: elapsed(),
    report: diagnose(document),
    capture: captureReport(document),
    captionLines: tracker.lines(),
    speakerSamples,
    starsMs,
  };
}

function send(message: ToBackground): void {
  // The worker may be asleep or the page closing; neither is worth an error.
  chrome.runtime.sendMessage(message).catch(() => {});
}

function readNow(): void {
  tracker.observe(readCaptions(document, roster));
}

/**
 * Captions only exist once they are switched on, and Meet rebuilds the
 * container, so the observer has to be (re)attached when the root appears or
 * is replaced.
 */
function attachObserver(): void {
  const report = diagnose(document);
  const root = report.captionRootStrategy
    ? document.querySelector('[aria-label*="aption"], [aria-live="polite"], [aria-live="assertive"]')
    : null;

  if (root === observedRoot) return;

  observer?.disconnect();
  observedRoot = root;

  if (!root) {
    observer = null;
    return;
  }

  observer = new MutationObserver(readNow);
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  readNow();
  console.info('[Minuto] watching captions', report);
}

function refreshRoster(): void {
  const found = findRoster(document);
  if (found) roster = found.names;
}

function sampleSpeaker(): void {
  const speaker = findActiveSpeaker(document, roster);
  if (speaker) speakerSamples.push({ atMs: elapsed(), speaker });
}

// Alt+S marks a moment worth keeping. One keystroke is something to do while
// listening, and it gives the summariser a strong prior later.
addEventListener('keydown', (event) => {
  if (event.altKey && event.code === 'KeyS') {
    starsMs.push(elapsed());
    console.info(`[Minuto] starred at ${Math.round(elapsed() / 1000)}s`);
  }
});

refreshRoster();
attachObserver();

setInterval(refreshRoster, ROSTER_REFRESH_MS);
setInterval(attachObserver, ROSTER_REFRESH_MS);
setInterval(sampleSpeaker, SPEAKER_SAMPLE_MS);
setInterval(() => send({ kind: 'snapshot', snapshot: snapshot() }), REPORT_MS);

console.info('[Minuto] content script ready —', diagnose(document));
