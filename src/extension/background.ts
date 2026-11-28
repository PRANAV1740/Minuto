/**
 * Service worker. Holds the latest snapshot per tab and serves it to the side
 * panel.
 *
 * Deliberately thin: no audio, no model, no network. MV3 workers are stopped
 * and restarted at the browser's discretion, so anything that must survive
 * that belongs in storage or in the page, not here.
 */

import { isMeetUrl } from './messages.ts';
import type { SessionSnapshot, ToBackground, ToPanel } from './messages.ts';

const snapshots = new Map<number, SessionSnapshot>();

const MEET_TABS = { url: 'https://meet.google.com/*' } as const;

/**
 * Puts the content script back into Meet tabs that are already open.
 *
 * Chrome injects content scripts when a page loads, and reloading the
 * extension orphans every one already running — the tab keeps its call, the
 * script stops reporting, and the panel says "no Meet tab active" while the
 * user is plainly looking at a meeting. Measured: exactly that, in a real
 * call, after reloading at chrome://extensions.
 *
 * Re-injecting on install and on startup means a reload costs nothing. The
 * content script guards against running twice, so a tab that already has a
 * live script is left alone.
 */
async function injectIntoOpenMeetTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query(MEET_TABS);

    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) return;
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
        } catch {
          // A tab mid-navigation, or one Chrome will not let us touch. The
          // next page load injects it the ordinary way.
        }
      }),
    );
  } catch {
    // No tabs permission, or the query failed; nothing to recover.
  }
}

chrome.runtime.onInstalled.addListener(() => void injectIntoOpenMeetTabs());
chrome.runtime.onStartup.addListener(() => void injectIntoOpenMeetTabs());

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

    if (tab?.id === undefined) return { error: 'No active tab to capture.' };
    if (!isMeetUrl(tab.url)) {
      return { error: 'The tab in front is not a Meet call — switch to it and try again.' };
    }

    // The stream id has to be minted here: tabCapture is not available to an
    // offscreen document, only the id it produces.
    //
    // This is where capture silently did nothing: the call threw, the panel
    // showed "not started", and no error reached anywhere a person would
    // look. Chrome's usual complaint here is that the extension has not been
    // invoked for the page, which is about the activeTab grant rather than
    // about anything the user did wrong.
    let streamId: string;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { error: `Chrome refused tab capture: ${detail}` };
    }

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
          const tab = tabs[0];
          const snapshot = tab?.id === undefined ? null : snapshots.get(tab.id) ?? null;
          respond({ kind: 'state', snapshot, onMeet: isMeetUrl(tab?.url) });
        })
        .catch(() => respond({ kind: 'state', snapshot: null, onMeet: false }));
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
