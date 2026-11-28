/**
 * The side panel: shows what the DOM readers are managing to read.
 *
 * In this increment the panel is mainly a diagnostic. Its job on a real call
 * is to answer one question — do the strategies in meet-dom.ts match the
 * markup Google is actually serving? — and to make the answer obvious without
 * opening devtools.
 */

import { normaliseCaptions } from '../fusion/captions.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import type { SessionSnapshot, ToPanel } from './messages.ts';

const POLL_MS = 1000;

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`panel is missing #${id}`);
  return node;
};

const session = el('session');
const readers = el('readers');
const problems = el('problems');
const captions = el('captions');
const copyButton = el('copy') as HTMLButtonElement;
const copied = el('copied');
const captureButton = el('capture') as HTMLButtonElement;
const captureStatus = el('captureStatus');
const captureProblem = el('captureProblem');
const captionStatus = el('captionStatus');
const autoCaptions = el('autoCaptions') as HTMLInputElement;
const hideCaptions = el('hideCaptions') as HTMLInputElement;

/**
 * When the user last moved a checkbox.
 *
 * The panel re-renders from the content script every second, which would
 * otherwise snap a box back to its old value in the gap before the new one has
 * been stored and reported.
 */
let settingsTouchedAt = 0;
const SETTLE_MS = 3000;

function showSettings(settings: Settings): void {
  if (Date.now() - settingsTouchedAt < SETTLE_MS) return;
  autoCaptions.checked = settings.autoCaptions;
  hideCaptions.checked = settings.hideCaptions;
}

for (const [box, key] of [
  [autoCaptions, 'autoCaptions'],
  [hideCaptions, 'hideCaptions'],
] as const) {
  box.addEventListener('change', () => {
    settingsTouchedAt = Date.now();
    void saveSettings({ [key]: box.checked });
  });
}

void loadSettings().then(showSettings);

/** Mirrors the offscreen document's state, which is the source of truth. */
type CaptureState = {
  capturing: boolean;
  tier: { tier: string; label: string; model: string; reason: string; warning?: string } | null;
  adapter: {
    vendor?: string;
    architecture?: string;
    device?: string;
    description?: string;
    renderer?: string;
  } | null;
  modelReady: boolean;
  modelError: string | null;
  captureError: string | null;
  micEnabled: boolean;
  audioState: string | null;
  audioMs: number;
  windowsSeen: number;
  windowsSkipped: number;
  words: number;
};

let capturing = false;

/**
 * The last thing that went wrong trying to start.
 *
 * Held in the panel rather than in the offscreen document's status, because
 * the failure that actually happened was in the service worker, before any
 * status existed to write it into — so it went nowhere and the panel said
 * "not started", which is true and useless.
 */
let startError: string | null = null;

captureButton.addEventListener('click', () => {
  captureButton.disabled = true;
  startError = null;

  void chrome.runtime
    .sendMessage({ kind: 'capture-control', action: capturing ? 'stop' : 'start' })
    .then((reply: unknown) => {
      const error = (reply as { error?: string } | undefined)?.error;
      if (error) {
        startError = error;
        console.error('[Minuto] capture did not start:', error);
      }
    })
    .catch((error: unknown) => {
      startError = error instanceof Error ? error.message : String(error);
      console.error('[Minuto] capture did not start:', startError);
    })
    .finally(() => {
      captureButton.disabled = false;
      void pollCapture();
    });
});

/** The GPU in words a person can check against chrome://gpu. */
function describeAdapter(adapter: CaptureState['adapter']): string {
  if (!adapter) return 'not reported';

  // The renderer string carries the board name; the rest is all Chrome will
  // say once it has masked the adapter for privacy.
  if (adapter.renderer) return adapter.renderer;

  const parts = [adapter.vendor, adapter.architecture, adapter.device, adapter.description]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '');

  return parts.length > 0 ? parts.join(' · ') : 'masked by Chrome';
}

function renderCapture(state: CaptureState | null): void {
  if (!state) {
    captureButton.textContent = 'Start capture';
    rows(captureStatus, [['status', 'not started', 'warn']]);
    showNotes(startError ? [startError] : []);
    return;
  }

  capturing = state.capturing;
  captureButton.textContent = state.capturing ? 'Stop capture' : 'Start capture';

  rows(captureStatus, [
    ['tier', state.tier ? `${state.tier.tier} · ${state.tier.label}` : 'deciding…'],
    ['why', state.tier?.reason ?? '—'],
    // Shown always, not only on failure: "adapter looks like integrated
    // graphics" is a conclusion, and a conclusion with no evidence under it
    // cannot be argued with when it is wrong.
    ['gpu', describeAdapter(state.adapter)],
    ['model', state.modelReady ? 'ready' : state.modelError ? 'failed' : 'loading…',
      state.modelReady ? 'ok' : state.modelError ? 'warn' : undefined],
    ['capture', state.capturing ? 'running' : 'stopped', state.capturing ? 'ok' : undefined],
    ['microphone', state.micEnabled ? 'on' : 'off'],
    [
      'audio context',
      state.audioState ?? 'not started',
      state.audioState === 'running' ? 'ok' : state.audioState ? 'warn' : undefined,
    ],
    ['audio', clock(state.audioMs)],
    ['windows', `${state.windowsSeen} (${state.windowsSkipped} silent)`],
    ['words', String(state.words)],
  ]);

  showNotes(
    [startError, state.tier?.warning, state.modelError, state.captureError].filter(
      (note): note is string => Boolean(note),
    ),
  );
}

/** Whatever is currently wrong with capture, or nothing. */
function showNotes(notes: readonly string[]): void {
  if (notes.length === 0) {
    captureProblem.replaceChildren();
    return;
  }

  const list = document.createElement('ul');
  list.className = 'warn';
  list.replaceChildren(
    ...notes.map((note) => {
      const item = document.createElement('li');
      item.textContent = note;
      return item;
    }),
  );
  captureProblem.replaceChildren(list);
}

async function pollCapture(): Promise<void> {
  try {
    const reply = (await chrome.runtime.sendMessage({
      kind: 'capture-control',
      action: 'status',
    })) as { status?: CaptureState } | undefined;
    renderCapture(reply?.status ?? null);
  } catch {
    renderCapture(null);
  }
}

/** Held so the copy button always offers the most recent capture. */
let latestCapture: unknown = null;

copyButton.addEventListener('click', () => {
  if (latestCapture === null) return;

  const json = JSON.stringify(latestCapture, null, 2);
  void navigator.clipboard
    .writeText(json)
    .then(() => {
      copied.textContent = 'copied';
      copied.hidden = false;
      setTimeout(() => {
        copied.hidden = true;
      }, 2500);
    })
    .catch(() => {
      // Clipboard refused: show the JSON so it can still be selected by hand.
      copied.textContent = 'clipboard blocked — see console';
      copied.hidden = false;
      console.log(json);
    });
});

function rows(target: HTMLElement, pairs: readonly [string, string, string?][]): void {
  target.replaceChildren(
    ...pairs.flatMap(([label, value, className]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dd.className = className ? `mono ${className}` : 'mono';
      return [dt, dd];
    }),
  );
}

const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Two different nothings.
 *
 * Not being in a call and being in a call Minuto cannot see look identical
 * from here, and the second is what every open tab becomes when the extension
 * is reloaded. Saying which one it is turns a mystery into one keystroke.
 */
function renderEmpty(onMeet: boolean): void {
  latestCapture = null;
  copyButton.disabled = true;

  rows(session, [
    ['status', onMeet ? 'Meet tab found, not reporting' : 'no Meet tab active', 'warn'],
  ]);
  rows(captionStatus, [['captions in Meet', onMeet ? 'not reporting' : 'no call open']]);
  readers.replaceChildren();

  if (onMeet) {
    const list = document.createElement('ul');
    list.className = 'warn';
    const item = document.createElement('li');
    item.textContent =
      'Minuto is not running in this tab. Reload the Meet tab (F5) — Chrome drops ' +
      'content scripts from tabs that were already open when the extension was reloaded.';
    list.replaceChildren(item);
    problems.replaceChildren(list);
  } else {
    problems.replaceChildren();
  }

  captions.replaceChildren(
    Object.assign(document.createElement('div'), {
      className: 'empty',
      textContent: onMeet ? 'Nothing read — reload the Meet tab.' : 'Open a Google Meet call to begin.',
    }),
  );
}

/**
 * Why there are no captions on screen, in the user's terms.
 *
 * Three different nothings, and the difference is the whole value of the
 * panel: one is the user's move, one is everyone else's, and one is ours.
 */
function emptyCaptionsMessage(snapshot: SessionSnapshot): string {
  if (snapshot.report?.waitingForSpeech) {
    return 'Captions are on and empty — nothing has been said yet.';
  }
  if (snapshot.captionsOn === true) {
    return 'Nothing read yet — captions appear a moment after somebody speaks.';
  }

  // Not an instruction any more. Minuto transcribes the call's audio itself;
  // Meet's captions are an optional extra that adds speaker names, and on
  // Hinglish they were too inaccurate to be worth switching on.
  return 'Meet captions are off. Minuto transcribes the call audio instead — captions only add speaker names.';
}

function render(snapshot: SessionSnapshot): void {
  const report = snapshot.report;

  latestCapture = snapshot.capture;
  copyButton.disabled = snapshot.capture === null;

  rows(session, [
    ['meeting', snapshot.meetCode ?? 'not in a call'],
    ['elapsed', clock(snapshot.elapsedMs)],
    ['starred', String(snapshot.starsMs.length)],
  ]);

  showSettings(snapshot.settings);
  rows(captionStatus, [
    [
      'captions in Meet',
      snapshot.captionsOn === null ? 'cannot tell yet' : snapshot.captionsOn ? 'on' : 'off',
      snapshot.captionsOn === true ? 'ok' : 'warn',
    ],
    ['on your screen', snapshot.settings.hideCaptions ? 'hidden' : 'visible'],
    // Only worth the space when something went wrong; when captions are on,
    // the controls found are not news.
    ...(snapshot.captionsOn === true
      ? []
      : ([
          [
            'controls found',
            snapshot.captionControls.length > 0 ? snapshot.captionControls.join(' · ') : 'none',
            snapshot.captionControls.length > 0 ? undefined : 'warn',
          ],
        ] as [string, string, string?][])),
  ]);

  rows(readers, [
    ['captions', report?.captionRootStrategy ?? 'not found', report?.captionRootStrategy ? 'ok' : 'warn'],
    ['roster', report?.rosterStrategy ?? 'not found', report?.rosterStrategy ? 'ok' : 'warn'],
    ['people', String(report?.rosterCount ?? 0)],
    [
      'lines on screen',
      report?.waitingForSpeech ? '0 — waiting for speech' : String(report?.captionsRead ?? 0),
    ],
    ['speaking now', report?.activeSpeaker ?? '—'],
    ['speaker samples', String(snapshot.speakerSamples.length)],
  ]);

  if (report && report.problems.length > 0) {
    const list = document.createElement('ul');
    list.className = 'warn';
    list.replaceChildren(
      ...report.problems.map((problem) => {
        const item = document.createElement('li');
        item.textContent = problem;
        return item;
      }),
    );
    problems.replaceChildren(list);
  } else {
    problems.replaceChildren();
  }

  // Collapsed, so the panel shows utterances rather than Meet's growth steps.
  const lines = normaliseCaptions(snapshot.captionLines);

  if (lines.length === 0) {
    captions.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'empty',
        textContent: emptyCaptionsMessage(snapshot),
      }),
    );
    return;
  }

  captions.replaceChildren(
    ...lines.slice(-40).map((line) => {
      const wrap = document.createElement('div');
      wrap.className = 'line';

      const who = document.createElement('div');
      who.className = 'who';
      who.textContent = `${line.speaker} · ${clock(line.startMs)}`;

      const text = document.createElement('div');
      text.textContent = line.text;

      wrap.replaceChildren(who, text);
      return wrap;
    }),
  );
}

async function poll(): Promise<void> {
  try {
    const reply = (await chrome.runtime.sendMessage({ kind: 'panel-state' })) as ToPanel | undefined;
    if (reply?.snapshot) render(reply.snapshot);
    else renderEmpty(reply?.onMeet === true);
  } catch {
    renderEmpty(false);
  }
}

void poll();
void pollCapture();
setInterval(() => {
  void poll();
  void pollCapture();
}, POLL_MS);
