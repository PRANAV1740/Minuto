/**
 * The behaviour every storage backend must have, as a reusable test suite.
 *
 * Written once and run against each implementation, so "it works in memory but
 * not in Postgres" is a failing test rather than something discovered in use.
 * A new backend is correct when this passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { MinutoStore } from './types.ts';
import type { DraftMinutes, Segment } from '../minutes/validate.ts';

const OWNER = 'user-1';
const OTHER_OWNER = 'user-2';

const segments: Segment[] = [
  { seq: 1, tStartMs: 0, text: 'So we will ship on Friday.', speakerName: 'Pranav K' },
  { seq: 2, tStartMs: 11_000, text: 'I will prepare the deck.', speakerName: 'Asha R' },
];

function minutes(over: Partial<DraftMinutes> = {}): DraftMinutes {
  return {
    title: 'Weekly sync',
    summary: 'We agreed a date.',
    topics: [],
    decisions: [{ decision: 'Ship on Friday', rationale: null, sourceSeqs: [1] }],
    actionItems: [
      {
        task: 'Prepare the deck',
        ownerName: 'Asha R',
        dueDate: null,
        confidence: 'medium',
        sourceSeqs: [2],
      },
    ],
    openQuestions: [],
    attendeesSpeaking: ['Pranav K', 'Asha R'],
    ...over,
  };
}

/**
 * Registers the suite. `makeStore` must hand back an empty store each time.
 */
export function testStoreContract(label: string, makeStore: () => Promise<MinutoStore>): void {
  const withStore = async (body: (store: MinutoStore) => Promise<void>): Promise<void> => {
    const store = await makeStore();
    try {
      await body(store);
    } finally {
      await store.close();
    }
  };

  const seedMeeting = async (store: MinutoStore, title = 'Weekly sync') =>
    store.createMeeting({ ownerId: OWNER, meetCode: 'abc-defg-hij', title, meetingDate: '2026-11-25' });

  // ---------- meetings ----------

  test(`${label}: a created meeting can be read back`, async () => {
    await withStore(async (store) => {
      const created = await seedMeeting(store);
      const found = await store.getMeeting(created.id);

      assert.equal(found?.title, 'Weekly sync');
      assert.equal(found?.meetCode, 'abc-defg-hij');
      assert.equal(found?.ownerId, OWNER);
    });
  });

  test(`${label}: a meeting that does not exist reads back as nothing`, async () => {
    await withStore(async (store) => {
      assert.equal(await store.getMeeting('nope'), null);
    });
  });

  test(`${label}: every meeting gets its own id`, async () => {
    await withStore(async (store) => {
      const first = await seedMeeting(store, 'One');
      const second = await seedMeeting(store, 'Two');
      assert.notEqual(first.id, second.id);
    });
  });

  test(`${label}: meetings are listed most recent first`, async () => {
    await withStore(async (store) => {
      await seedMeeting(store, 'Older');
      await seedMeeting(store, 'Newer');

      const listed = await store.listMeetings(OWNER);
      assert.deepEqual(listed.map((m) => m.title), ['Newer', 'Older']);
    });
  });

  test(`${label}: a listing shows only that owner meetings`, async () => {
    await withStore(async (store) => {
      await seedMeeting(store, 'Mine');
      await store.createMeeting({
        ownerId: OTHER_OWNER,
        meetCode: null,
        title: 'Theirs',
        meetingDate: null,
      });

      assert.deepEqual((await store.listMeetings(OWNER)).map((m) => m.title), ['Mine']);
    });
  });

  test(`${label}: a meeting with no code and no date is allowed`, async () => {
    await withStore(async (store) => {
      const created = await store.createMeeting({
        ownerId: OWNER,
        meetCode: null,
        title: 'Pasted notes',
        meetingDate: null,
      });

      const found = await store.getMeeting(created.id);
      assert.equal(found?.meetCode, null);
      assert.equal(found?.meetingDate, null);
    });
  });

  // ---------- segments ----------

  test(`${label}: segments are saved and read back in order`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveSegments(meeting.id, [...segments].reverse());

      const read = await store.getSegments(meeting.id);
      assert.deepEqual(read.map((s) => s.seq), [1, 2]);
      assert.equal(read[0]!.speakerName, 'Pranav K');
      assert.equal(read[1]!.text, 'I will prepare the deck.');
    });
  });

  test(`${label}: saving segments again replaces the previous set`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveSegments(meeting.id, segments);
      await store.saveSegments(meeting.id, [segments[0]!]);

      assert.equal((await store.getSegments(meeting.id)).length, 1);
    });
  });

  test(`${label}: a meeting with no segments reads back empty`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      assert.deepEqual(await store.getSegments(meeting.id), []);
    });
  });

  test(`${label}: a segment with no speaker survives the round trip`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveSegments(meeting.id, [{ seq: 1, tStartMs: 0, text: 'Anonymous line.' }]);

      const read = await store.getSegments(meeting.id);
      assert.equal(read[0]!.speakerName, undefined);
    });
  });

  // ---------- minutes ----------

  test(`${label}: the first saved minutes are version one`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      const saved = await store.saveMinutes({
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '# Weekly sync',
        writtenBy: 'extraction',
      });

      assert.equal(saved.version, 1);
    });
  });

  test(`${label}: saving again makes a new version and keeps the old one`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      const input = {
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '# v1',
        writtenBy: 'extraction',
      };

      await store.saveMinutes(input);
      const second = await store.saveMinutes({ ...input, markdown: '# v2' });

      assert.equal(second.version, 2);
      assert.equal((await store.getLatestMinutes(meeting.id))?.markdown, '# v2');
    });
  });

  test(`${label}: a meeting with no minutes has none to fetch`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      assert.equal(await store.getLatestMinutes(meeting.id), null);
    });
  });

  test(`${label}: the stored minutes keep their whole structure`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveMinutes({
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '# Weekly sync',
        writtenBy: 'gemini / test',
      });

      const latest = await store.getLatestMinutes(meeting.id);
      assert.equal(latest?.writtenBy, 'gemini / test');
      assert.deepEqual(latest?.payload.decisions[0]!.sourceSeqs, [1]);
      assert.equal(latest?.payload.attendeesSpeaking.length, 2);
    });
  });

  // ---------- action items ----------

  test(`${label}: saving minutes files their action items`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveMinutes({
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '#',
        writtenBy: 'extraction',
      });

      const items = await store.listActionItems(meeting.id);
      assert.equal(items.length, 1);
      assert.equal(items[0]!.task, 'Prepare the deck');
      assert.equal(items[0]!.ownerName, 'Asha R');
      assert.equal(items[0]!.status, 'open');
      assert.deepEqual(items[0]!.sourceSeqs, [2]);
    });
  });

  test(`${label}: an owner can be corrected`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveMinutes({
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '#',
        writtenBy: 'extraction',
      });

      const [item] = await store.listActionItems(meeting.id);
      const updated = await store.updateActionItem(item!.id, { ownerName: 'Ravi M' });

      assert.equal(updated?.ownerName, 'Ravi M');
      assert.equal((await store.listActionItems(meeting.id))[0]!.ownerName, 'Ravi M');
    });
  });

  test(`${label}: an owner can be cleared back to unassigned`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveMinutes({
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '#',
        writtenBy: 'extraction',
      });

      const [item] = await store.listActionItems(meeting.id);
      assert.equal((await store.updateActionItem(item!.id, { ownerName: null }))?.ownerName, null);
    });
  });

  test(`${label}: a task can be marked done`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveMinutes({
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '#',
        writtenBy: 'extraction',
      });

      const [item] = await store.listActionItems(meeting.id);
      assert.equal((await store.updateActionItem(item!.id, { status: 'done' }))?.status, 'done');
    });
  });

  test(`${label}: updating a task that does not exist changes nothing`, async () => {
    await withStore(async (store) => {
      assert.equal(await store.updateActionItem('nope', { status: 'done' }), null);
    });
  });

  test(`${label}: one person tasks are gathered from every meeting`, async () => {
    await withStore(async (store) => {
      for (const title of ['Monday sync', 'Tuesday sync']) {
        const meeting = await seedMeeting(store, title);
        await store.saveMinutes({
          meetingId: meeting.id,
          payload: minutes(),
          markdown: '#',
          writtenBy: 'extraction',
        });
      }

      const mine = await store.listActionItemsFor(OWNER, 'Asha R');
      assert.equal(mine.length, 2);
    });
  });

  test(`${label}: another owner tasks are not gathered`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveMinutes({
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '#',
        writtenBy: 'extraction',
      });

      assert.deepEqual(await store.listActionItemsFor(OTHER_OWNER, 'Asha R'), []);
    });
  });

  // ---------- deletion ----------

  test(`${label}: deleting a meeting takes its transcript and minutes with it`, async () => {
    await withStore(async (store) => {
      const meeting = await seedMeeting(store);
      await store.saveSegments(meeting.id, segments);
      await store.saveMinutes({
        meetingId: meeting.id,
        payload: minutes(),
        markdown: '#',
        writtenBy: 'extraction',
      });

      await store.deleteMeeting(meeting.id);

      assert.equal(await store.getMeeting(meeting.id), null);
      assert.deepEqual(await store.getSegments(meeting.id), []);
      assert.equal(await store.getLatestMinutes(meeting.id), null);
      assert.deepEqual(await store.listActionItems(meeting.id), []);
    });
  });

  test(`${label}: deleting a meeting that does not exist is harmless`, async () => {
    await withStore(async (store) => {
      await store.deleteMeeting('nope');
    });
  });
}
