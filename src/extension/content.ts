/**
 * Runs inside the Meet tab. Reads captions, the roster and who is speaking,
 * and reports what it managed to read.
 *
 * It touches the page in exactly two ways, both of them local to this browser
 * and invisible to everyone else in the call: it switches Meet's captions on,
 * because they are the speaker channel the whole design rests on, and it moves
 * the caption panel out of view so the user does not have to watch it. Both
 * can be turned off from the side panel.
 *
 * It still does not post to the meeting chat or do anything else anyone else
 * would notice.
 *
 * The first job of a real run is the diagnostic: whatever it reports is the
 * truth about Meet's current DOM, and src/extension/meet-dom.ts is where the
 * fix goes.
 */

import { createCaptionTracker } from './caption-tracker.ts';
import { captureReport } from './capture-fixture.ts';
import {
  diagnose,
  findCaptionRoot,
  findRoster,
  readCaptions,
  findActiveSpeaker,
} from './meet-dom.ts';
import {
  captionControlLabels,
  captionsAreOn,
  findCaptionsToggle,
  markCaptionRegion,
  pressCaptionsShortcut,
  setCaptionsHidden,
} from './captions-view.ts';
import { DEFAULT_SETTINGS, loadSettings, onSettingsChange, type Settings } from './settings.ts';
import { meetCodeFrom, type SessionSnapshot, type ToBackground } from './messages.ts';
import type { SpeakerSample } from '../fusion/fuse.ts';

const SPEAKER_SAMPLE_MS = 400;
const ROSTER_REFRESH_MS = 5000;
const REPORT_MS = 2000;
const CAPTION_CHECK_MS = 1500;

/**
 * How many times to reach for the CC button before giving up.
 *
 * Unbounded retries would mean a Meet build whose label we misread turns into
 * a script clicking a control several times a second for the whole meeting.
 */
const MAX_ENABLE_ATTEMPTS = 3;

const startedAt = Date.now();
const elapsed = () => Date.now() - startedAt;

const tracker = createCaptionTracker(elapsed);
const speakerSamples: SpeakerSample[] = [];
const starsMs: number[] = [];

let roster: string[] = [];
let observer: MutationObserver | null = null;
let observedRoot: Element | null = null;

let settings: Settings = { ...DEFAULT_SETTINGS };
let enableAttempts = 0;
let shortcutPressed = false;
let sawCaptionsOn = false;

function snapshot(): SessionSnapshot {
  return {
    meetCode: meetCodeFrom(location.pathname),
    startedAt,
    elapsedMs: elapsed(),
    report: diagnose(document),
    captionsOn: captionsAreOn(document),
    captionControls: captionControlLabels(document),
    settings,
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
  // findCaptionRoot, not a fresh querySelector: four elements in a real call
  // carry "caption" in their label, and a loose selector picks whichever comes
  // first in document order — which can be the CC button. Observing a button
  // looks like success and then reports nothing for the whole meeting.
  const root = findCaptionRoot(document)?.element ?? null;

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
  console.info('[Minuto] watching captions', diagnose(document));
}

/**
 * Keeps captions on and out of sight.
 *
 * The one rule worth stating: once captions have been seen on, this never
 * clicks the toggle again. If the user switches them off mid-call that is a
 * decision, not a fault to correct, even though it costs Minuto its speaker
 * names.
 */
function manageCaptions(): void {
  // Marked first, so the stylesheet can only ever act on the element the
  // reader itself chose. Hiding by label matched Meet's own captions settings
  // dialog and put the switch for turning captions on out of reach.
  markCaptionRegion(document, findCaptionRoot(document)?.element ?? null);
  setCaptionsHidden(document, settings.hideCaptions);

  const on = captionsAreOn(document);
  if (on === true) {
    sawCaptionsOn = true;
    return;
  }

  if (!settings.autoCaptions || sawCaptionsOn) return;

  // No control to read. Measured in a real call: with the side panel open the
  // Meet window is too narrow to render a captions button, and the overflow
  // menu it moves into is not in the DOM until opened — so there is nothing
  // to find and nothing to click. Meet's own keyboard shortcut does not care
  // what the toolbar has done with itself.
  if (on === null) {
    // Exactly once. Without a readable state there is no way to tell a press
    // that worked from one that did nothing, and a second press would switch
    // captions back off.
    if (shortcutPressed) return;

    shortcutPressed = pressCaptionsShortcut(document);
    if (shortcutPressed) console.info('[Minuto] pressed c to switch captions on');
    return;
  }

  if (enableAttempts >= MAX_ENABLE_ATTEMPTS) return;

  enableAttempts++;
  (findCaptionsToggle(document) as HTMLElement | null)?.click();
  console.info('[Minuto] switched Meet captions on');
}

function refreshRoster(): void {
  const found = findRoster(document);
  if (found) roster = found.names;
}

function sampleSpeaker(): void {
  const speaker = findActiveSpeaker(document, roster);
  if (speaker) speakerSamples.push({ atMs: elapsed(), speaker });
}

function start(): void {
  // Alt+S marks a moment worth keeping. One keystroke is something to do
  // while listening, and it gives the summariser a strong prior later.
  addEventListener('keydown', (event) => {
    if (event.altKey && event.code === 'KeyS') {
      starsMs.push(elapsed());
      console.info(`[Minuto] starred at ${Math.round(elapsed() / 1000)}s`);
    }
  });

  // Applied before anything is awaited, so the caption panel never flashes up
  // while the stored settings are being read.
  setCaptionsHidden(document, DEFAULT_SETTINGS.hideCaptions);

  void loadSettings().then((loaded) => {
    settings = loaded;
    manageCaptions();
  });

  onSettingsChange((next) => {
    settings = next;
    manageCaptions();
  });

  refreshRoster();
  attachObserver();
  manageCaptions();

  setInterval(refreshRoster, ROSTER_REFRESH_MS);
  setInterval(attachObserver, ROSTER_REFRESH_MS);
  setInterval(sampleSpeaker, SPEAKER_SAMPLE_MS);
  setInterval(manageCaptions, CAPTION_CHECK_MS);
  setInterval(() => send({ kind: 'snapshot', snapshot: snapshot() }), REPORT_MS);

  console.info('[Minuto] content script ready —', diagnose(document));
}

/**
 * Runs once per tab, however many times the file is injected.
 *
 * The service worker re-injects into tabs that were already open when the
 * extension was reloaded, and it cannot tell which of them still has a live
 * script. Without this flag those tabs would end up with two of every timer,
 * two observers and two snapshots a second — all subtly wrong rather than
 * obviously broken.
 */
const ALREADY_RUNNING = '__minutoContentScript';
const scope = globalThis as Record<string, unknown>;

if (scope[ALREADY_RUNNING]) {
  console.info('[Minuto] already running in this tab');
} else {
  scope[ALREADY_RUNNING] = true;
  start();
}
