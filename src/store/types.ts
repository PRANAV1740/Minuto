/**
 * What Minuto stores, and the one interface every backend implements.
 *
 * Two backends exist on purpose: an in-memory one that the tests and the web
 * app's first run use, and Postgres for anything that has to survive a
 * restart. They are held to the same contract (`contract.ts`), so a behaviour
 * difference between them is a failing test rather than a surprise in
 * production.
 *
 * The shapes mirror docs/ARCHITECTURE.md §6. Action items are a real table
 * rather than a blob inside the minutes, because "everything assigned to me,
 * across every meeting" is the query that turns this from a minutes tool into
 * something used every day.
 */

import type { DraftMinutes, Segment } from '../minutes/validate.ts';

export type MeetingInput = {
  ownerId: string;
  /** The Meet code (abc-defg-hij), when the meeting came from a call. */
  meetCode: string | null;
  title: string;
  /** YYYY-MM-DD, used to resolve "by Friday" into a date. */
  meetingDate: string | null;
};

export type Meeting = MeetingInput & {
  id: string;
  createdAt: string;
};

export type MinutesInput = {
  meetingId: string;
  payload: DraftMinutes;
  markdown: string;
  /** Which path produced these minutes, e.g. "extraction" or "gemini / …". */
  writtenBy: string;
};

export type StoredMinutes = MinutesInput & {
  id: string;
  version: number;
  createdAt: string;
};

export type ActionItemStatus = 'open' | 'done' | 'dropped';

export type StoredActionItem = {
  id: string;
  meetingId: string;
  minutesId: string;
  task: string;
  ownerName: string | null;
  dueDate: string | null;
  confidence: 'high' | 'medium' | 'low';
  status: ActionItemStatus;
  sourceSeqs: number[];
};

/** What the editor is allowed to change. */
export type ActionItemPatch = {
  ownerName?: string | null;
  dueDate?: string | null;
  status?: ActionItemStatus;
};

export interface MinutoStore {
  createMeeting(input: MeetingInput): Promise<Meeting>;
  getMeeting(id: string): Promise<Meeting | null>;
  /** Most recent first. */
  listMeetings(ownerId: string): Promise<Meeting[]>;
  deleteMeeting(id: string): Promise<void>;

  /** Replaces whatever was stored for the meeting. */
  saveSegments(meetingId: string, segments: readonly Segment[]): Promise<void>;
  getSegments(meetingId: string): Promise<Segment[]>;

  /** Appends a new version; earlier versions are kept. */
  saveMinutes(input: MinutesInput): Promise<StoredMinutes>;
  getLatestMinutes(meetingId: string): Promise<StoredMinutes | null>;

  listActionItems(meetingId: string): Promise<StoredActionItem[]>;
  /** Everything assigned to one person, across every meeting they own. */
  listActionItemsFor(ownerId: string, ownerName: string): Promise<StoredActionItem[]>;
  updateActionItem(id: string, patch: ActionItemPatch): Promise<StoredActionItem | null>;

  close(): Promise<void>;
}
