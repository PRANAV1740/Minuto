'use server';

/**
 * Saving a meeting, and editing what it produced.
 *
 * Every action here re-checks what it is given. A server action is reachable
 * by direct POST, so the form is not the only way in, and "the UI would never
 * send that" is not a safety argument.
 */

import { revalidatePath } from 'next/cache';

import { parseActionItemPatch } from '../../../src/store/patch.ts';
import type { DraftMinutes, Segment } from '../../../src/minutes/validate.ts';
import { getStore } from '../lib/store.ts';
import { requireUser } from '../lib/session.ts';

export type SaveInput = {
  title: string;
  meetingDate: string | null;
  segments: Segment[];
  minutes: DraftMinutes;
  markdown: string;
  writtenBy: string;
};

/** Stores a generated set of minutes and returns the meeting to open. */
export async function saveMeeting(input: SaveInput): Promise<{ id: string }> {
  const user = await requireUser();
  const store = await getStore();

  const meeting = await store.createMeeting({
    ownerId: user.id,
    meetCode: null,
    title: input.title.trim() === '' ? 'Meeting minutes' : input.title.trim(),
    meetingDate: input.meetingDate,
  });

  await store.saveSegments(meeting.id, input.segments);
  await store.saveMinutes({
    meetingId: meeting.id,
    payload: input.minutes,
    markdown: input.markdown,
    writtenBy: input.writtenBy,
  });

  revalidatePath('/meetings');
  return { id: meeting.id };
}

export type EditResult = { ok: true } | { ok: false; error: string };

/**
 * Applies one correction to one task — the point of the whole editor, since a
 * model will sometimes put the wrong name against a task and the fix has to
 * stick.
 */
export async function editActionItem(
  meetingId: string,
  itemId: string,
  raw: unknown,
): Promise<EditResult> {
  const parsed = parseActionItemPatch(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const user = await requireUser();
  const store = await getStore();

  // The item must belong to a meeting this owner has, or the edit is refused:
  // an id alone must not be enough to reach somebody else's task.
  const meeting = await store.getMeeting(meetingId);
  if (!meeting || meeting.ownerId !== user.id) {
    return { ok: false, error: 'that meeting is not yours' };
  }

  const items = await store.listActionItems(meetingId);
  if (!items.some((item) => item.id === itemId)) {
    return { ok: false, error: 'that task is not in this meeting' };
  }

  const updated = await store.updateActionItem(itemId, parsed.patch);
  if (updated === null) return { ok: false, error: 'that task no longer exists' };

  revalidatePath(`/meetings/${meetingId}`);
  return { ok: true };
}

export async function deleteMeeting(id: string): Promise<EditResult> {
  const user = await requireUser();
  const store = await getStore();

  const meeting = await store.getMeeting(id);
  if (!meeting || meeting.ownerId !== user.id) {
    return { ok: false, error: 'that meeting is not yours' };
  }

  await store.deleteMeeting(id);
  revalidatePath('/meetings');
  return { ok: true };
}
