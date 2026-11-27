/**
 * In-memory storage.
 *
 * Not a stand-in for the real thing: it is what the contract suite runs
 * against, and what the web app uses before a database is configured, so the
 * app is usable on a fresh clone with nothing installed. Nothing survives a
 * restart, and the app says so rather than pretending otherwise.
 *
 * Everything is cloned on the way in and out. A caller holding a reference
 * into the store could otherwise mutate "saved" data without saving, which
 * the Postgres backend would never allow — and the whole point of the shared
 * contract is that the two behave alike.
 */

import { randomUUID } from 'node:crypto';

import type { Segment } from '../minutes/validate.ts';
import type {
  ActionItemPatch,
  Meeting,
  MeetingInput,
  MinutesInput,
  MinutoStore,
  StoredActionItem,
  StoredMinutes,
} from './types.ts';

const clone = <T>(value: T): T => structuredClone(value);

export function createMemoryStore(): MinutoStore {
  const meetings = new Map<string, Meeting>();
  const segmentsByMeeting = new Map<string, Segment[]>();
  const minutes: StoredMinutes[] = [];
  const actionItems: StoredActionItem[] = [];

  // A counter, not a timestamp: two meetings created in the same millisecond
  // would otherwise sort arbitrarily, and the listing order is tested.
  let sequence = 0;
  const order = new Map<string, number>();

  return {
    async createMeeting(input: MeetingInput): Promise<Meeting> {
      const meeting: Meeting = {
        ...input,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };

      meetings.set(meeting.id, meeting);
      order.set(meeting.id, sequence++);
      return clone(meeting);
    },

    async getMeeting(id) {
      const found = meetings.get(id);
      return found ? clone(found) : null;
    },

    async listMeetings(ownerId) {
      return [...meetings.values()]
        .filter((meeting) => meeting.ownerId === ownerId)
        .sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0))
        .map(clone);
    },

    async deleteMeeting(id) {
      meetings.delete(id);
      order.delete(id);
      segmentsByMeeting.delete(id);

      for (let i = minutes.length - 1; i >= 0; i--) {
        if (minutes[i]!.meetingId === id) minutes.splice(i, 1);
      }
      for (let i = actionItems.length - 1; i >= 0; i--) {
        if (actionItems[i]!.meetingId === id) actionItems.splice(i, 1);
      }
    },

    async saveSegments(meetingId, incoming) {
      const sorted = [...incoming].sort((a, b) => a.seq - b.seq).map(clone);
      segmentsByMeeting.set(meetingId, sorted);
    },

    async getSegments(meetingId) {
      return (segmentsByMeeting.get(meetingId) ?? []).map(clone);
    },

    async saveMinutes(input: MinutesInput): Promise<StoredMinutes> {
      const previous = minutes.filter((entry) => entry.meetingId === input.meetingId);

      const saved: StoredMinutes = {
        ...clone(input),
        id: randomUUID(),
        version: previous.length + 1,
        createdAt: new Date().toISOString(),
      };
      minutes.push(saved);

      // Action items are filed as rows of their own so they can be edited and
      // gathered across meetings, rather than living inside the payload.
      for (const item of input.payload.actionItems) {
        actionItems.push({
          id: randomUUID(),
          meetingId: input.meetingId,
          minutesId: saved.id,
          task: item.task,
          ownerName: item.ownerName,
          dueDate: item.dueDate,
          confidence: item.confidence,
          status: 'open',
          sourceSeqs: [...item.sourceSeqs],
        });
      }

      return clone(saved);
    },

    async getLatestMinutes(meetingId) {
      const forMeeting = minutes
        .filter((entry) => entry.meetingId === meetingId)
        .sort((a, b) => b.version - a.version);

      return forMeeting.length === 0 ? null : clone(forMeeting[0]!);
    },

    async listActionItems(meetingId) {
      return actionItems.filter((item) => item.meetingId === meetingId).map(clone);
    },

    async listActionItemsFor(ownerId, ownerName) {
      const mine = new Set(
        [...meetings.values()].filter((m) => m.ownerId === ownerId).map((m) => m.id),
      );

      return actionItems
        .filter((item) => mine.has(item.meetingId) && item.ownerName === ownerName)
        .map(clone);
    },

    async updateActionItem(id, patch: ActionItemPatch) {
      const item = actionItems.find((candidate) => candidate.id === id);
      if (!item) return null;

      // Only the named keys move: an absent key leaves the value alone, while
      // an explicit null clears it.
      if ('ownerName' in patch) item.ownerName = patch.ownerName ?? null;
      if ('dueDate' in patch) item.dueDate = patch.dueDate ?? null;
      if (patch.status !== undefined) item.status = patch.status;

      return clone(item);
    },

    async close() {
      // Nothing to release.
    },
  };
}
