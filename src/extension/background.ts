/**
 * Service worker. Holds the latest snapshot per tab and serves it to the side
 * panel.
 *
 * Deliberately thin: no audio, no model, no network. MV3 workers are stopped
 * and restarted at the browser's discretion, so anything that must survive
 * that belongs in storage or in the page, not here.
 */

import type { SessionSnapshot, ToBackground, ToPanel } from './messages.ts';

const snapshots = new Map<number, SessionSnapshot>();

/**
 * The offscreen document is created on demand and kept, because it holds the
 * loaded model — tearing it down would mean downloading the weights again.
 */
async function ensureOffscreen(): Promise<void> {
  if (await chrome.offscreen.hasDocument()) return;

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Transcribe meeting audio on this device, without uploading it.',
  });
}

async function captureControl(action: 'start' | 'stop' | 'status'): Promise<unknown> {
  await ensureOffscreen();

  if (action === 'start') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return { error: 'no active tab' };

    // The stream id has to be minted here: tabCapture is not available to an
    // offscreen document, only the id it produces.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    return chrome.runtime.sendMessage({ kind: 'capture-start', streamId });
  }

  return chrome.runtime.sendMessage({ kind: action === 'stop' ? 'capture-stop' : 'capture-status' });
}

chrome.runtime.onMessage.addListener(
  (message: ToBackground, sender, respond: (reply: ToPanel) => void) => {
    if (message.kind === 'snapshot') {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) snapshots.set(tabId, message.snapshot);
      return false;
    }

    if (message.kind === 'capture-control') {
      captureControl(message.action)
        .then((result) => respond(result as ToPanel))
        .catch((error: unknown) =>
          respond({ error: error instanceof Error ? error.message : String(error) } as unknown as ToPanel),
        );
      return true;
    }

    if (message.kind === 'panel-state') {
      // The panel has no tab of its own, so it asks about the active one.
      chrome.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
          const tabId = tabs[0]?.id;
          respond({ kind: 'state', snapshot: tabId === undefined ? null : snapshots.get(tabId) ?? null });
        })
        .catch(() => respond({ kind: 'state', snapshot: null }));
      return true;
    }

    return false;
  },
);

chrome.tabs.onRemoved.addListener((tabId) => snapshots.delete(tabId));

// Clicking the toolbar icon opens the panel rather than a popup.
chrome.sidePanel
  ?.setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});
