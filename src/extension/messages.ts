/**
 * The message shapes passed between the content script, the service worker
 * and the side panel. One file so the three stay in step.
 */

import type { CaptionLine } from '../fusion/captions.ts';
import type { SpeakerSample } from '../fusion/fuse.ts';
import type { CaptureReport } from './capture-fixture.ts';
import type { DomReport } from './meet-dom.ts';
import type { Settings } from './settings.ts';

export type SessionSnapshot = {
  meetCode: string | null;
  /** Wall clock when capture began; all other times are offsets from it. */
  startedAt: number;
  elapsedMs: number;
  report: DomReport | null;
  /** Whether Meet's captions are on; null when the control cannot be read. */
  captionsOn: boolean | null;
  /**
   * Labels of every caption-ish control found on the page. Interface wording
   * only — it is what makes a detection failure diagnosable instead of a
   * second round of guessing at Google's phrasing.
   */
  captionControls: string[];
  /** What the content script is currently acting on, so the panel agrees. */
  settings: Settings;
  /**
   * The redacted DOM capture, carried so the panel can offer it for copying.
   * Saves pasting a script into devtools to get the same thing.
   */
  capture: CaptureReport | null;
  captionLines: CaptionLine[];
  speakerSamples: SpeakerSample[];
  starsMs: number[];
};

export type ToBackground =
  | { kind: 'snapshot'; snapshot: SessionSnapshot }
  | { kind: 'panel-state' }
  | { kind: 'capture-control'; action: 'start' | 'stop' | 'status' };

export type ToPanel = {
  kind: 'state';
  snapshot: SessionSnapshot | null;
};

/** Pulls the Meet code (abc-defg-hij) out of a Meet URL. */
export function meetCodeFrom(pathname: string): string | null {
  const match = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i.exec(pathname);
  return match ? match[1]!.toLowerCase() : null;
}
