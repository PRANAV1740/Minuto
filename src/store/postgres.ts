/**
 * Postgres storage.
 *
 * Plain SQL over `pg` rather than an ORM: the schema is six tables read and
 * written in fixed ways, and the queries below are shorter than the mapping
 * configuration an ORM would need. Every one of them is held to the same
 * contract as the in-memory store (`contract.ts`), so the two cannot drift.
 *
 * Works unchanged against a local Postgres or a hosted one (Neon, Supabase):
 * only the connection string differs.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

import { SCHEMA_SQL } from './schema.ts';

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

export type PostgresOptions = {
  connectionString: string;
  /** Apply the schema on first use. Off for a database managed by migrations. */
  migrate?: boolean;
  /** Postgres needs TLS when hosted; local usually does not. */
  ssl?: boolean;
};

type MeetingRow = {
  id: string;
  owner_id: string;
  meet_code: string | null;
  title: string;
  meeting_date: Date | string | null;
  created_at: Date;
};

type MinutesRow = {
  id: string;
  meeting_id: string;
  version: number;
  payload: StoredMinutes['payload'];
  markdown: string;
  written_by: string;
  created_at: Date;
};

type ActionRow = {
  id: string;
  meeting_id: string;
  minutes_id: string;
  task: string;
  owner_name: string | null;
  due_date: Date | string | null;
  confidence: StoredActionItem['confidence'];
  status: StoredActionItem['status'];
  source_seqs: number[];
};

/** Dates come back as Date or string depending on the driver's settings. */
const toIsoDate = (value: Date | string | null): string | null => {
  if (value === null) return null;
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
};

const toMeeting = (row: MeetingRow): Meeting => ({
  id: row.id,
  ownerId: row.owner_id,
  meetCode: row.meet_code,
  title: row.title,
  meetingDate: toIsoDate(row.meeting_date),
  createdAt: row.created_at.toISOString(),
});

const toMinutes = (row: MinutesRow): StoredMinutes => ({
  id: row.id,
  meetingId: row.meeting_id,
  version: row.version,
  payload: row.payload,
  markdown: row.markdown,
  writtenBy: row.written_by,
  createdAt: row.created_at.toISOString(),
});

const toActionItem = (row: ActionRow): StoredActionItem => ({
  id: row.id,
  meetingId: row.meeting_id,
  minutesId: row.minutes_id,
  task: row.task,
  ownerName: row.owner_name,
  dueDate: toIsoDate(row.due_date),
  confidence: row.confidence,
  status: row.status,
  sourceSeqs: row.source_seqs,
});

export async function createPostgresStore(options: PostgresOptions): Promise<MinutoStore> {
  const pool = new Pool({
    connectionString: options.connectionString,
    ...(options.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  if (options.migrate !== false) {
    await pool.query(SCHEMA_SQL);
  }

  return {
    async createMeeting(input: MeetingInput): Promise<Meeting> {
      const { rows } = await pool.query<MeetingRow>(
        `INSERT INTO meetings (id, owner_id, meet_code, title, meeting_date)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, owner_id, meet_code, title, meeting_date, created_at`,
        [randomUUID(), input.ownerId, input.meetCode, input.title, input.meetingDate],
      );

      return toMeeting(rows[0]!);
    },

    async getMeeting(id) {
      // An id that is not a UUID would raise rather than simply not match.
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

      const { rows } = await pool.query<MeetingRow>(
        `SELECT id, owner_id, meet_code, title, meeting_date, created_at
         FROM meetings WHERE id = $1`,
        [id],
      );

      return rows.length === 0 ? null : toMeeting(rows[0]!);
    },

    async listMeetings(ownerId) {
      const { rows } = await pool.query<MeetingRow>(
        `SELECT id, owner_id, meet_code, title, meeting_date, created_at
         FROM meetings WHERE owner_id = $1 ORDER BY sort_key DESC`,
        [ownerId],
      );

      return rows.map(toMeeting);
    },

    async deleteMeeting(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return;
      // Segments, minutes and action items go with it via ON DELETE CASCADE.
      await pool.query('DELETE FROM meetings WHERE id = $1', [id]);
    },

    async saveSegments(meetingId, incoming) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM transcript_segments WHERE meeting_id = $1', [meetingId]);

        for (const segment of incoming) {
          await client.query(
            `INSERT INTO transcript_segments (meeting_id, seq, t_start_ms, text, speaker_name)
             VALUES ($1, $2, $3, $4, $5)`,
            [meetingId, segment.seq, segment.tStartMs, segment.text, segment.speakerName ?? null],
          );
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async getSegments(meetingId): Promise<Segment[]> {
      if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return [];

      const { rows } = await pool.query<{
        seq: number;
        t_start_ms: number;
        text: string;
        speaker_name: string | null;
      }>(
        `SELECT seq, t_start_ms, text, speaker_name
         FROM transcript_segments WHERE meeting_id = $1 ORDER BY seq`,
        [meetingId],
      );

      return rows.map((row) => ({
        seq: row.seq,
        tStartMs: row.t_start_ms,
        text: row.text,
        // Absent rather than null, matching what the parser produces.
        ...(row.speaker_name === null ? {} : { speakerName: row.speaker_name }),
      }));
    },

    async saveMinutes(input: MinutesInput): Promise<StoredMinutes> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { rows } = await client.query<MinutesRow>(
          `INSERT INTO minutes (id, meeting_id, version, payload, markdown, written_by)
           SELECT $1, $2, COALESCE(MAX(version), 0) + 1, $3, $4, $5
           FROM minutes WHERE meeting_id = $2
           RETURNING id, meeting_id, version, payload, markdown, written_by, created_at`,
          [randomUUID(), input.meetingId, JSON.stringify(input.payload), input.markdown, input.writtenBy],
        );

        const saved = rows[0]!;

        for (const item of input.payload.actionItems) {
          await client.query(
            `INSERT INTO action_items
               (id, meeting_id, minutes_id, task, owner_name, due_date, confidence, source_seqs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              randomUUID(),
              input.meetingId,
              saved.id,
              item.task,
              item.ownerName,
              item.dueDate,
              item.confidence,
              item.sourceSeqs,
            ],
          );
        }

        await client.query('COMMIT');
        return toMinutes(saved);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },

    async getLatestMinutes(meetingId) {
      if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return null;

      const { rows } = await pool.query<MinutesRow>(
        `SELECT id, meeting_id, version, payload, markdown, written_by, created_at
         FROM minutes WHERE meeting_id = $1 ORDER BY version DESC LIMIT 1`,
        [meetingId],
      );

      return rows.length === 0 ? null : toMinutes(rows[0]!);
    },

    async listActionItems(meetingId) {
      if (!/^[0-9a-f-]{36}$/i.test(meetingId)) return [];

      const { rows } = await pool.query<ActionRow>(
        `SELECT id, meeting_id, minutes_id, task, owner_name, due_date, confidence, status, source_seqs
         FROM action_items WHERE meeting_id = $1 ORDER BY id`,
        [meetingId],
      );

      return rows.map(toActionItem);
    },

    async listActionItemsFor(ownerId, ownerName) {
      const { rows } = await pool.query<ActionRow>(
        `SELECT a.id, a.meeting_id, a.minutes_id, a.task, a.owner_name, a.due_date,
                a.confidence, a.status, a.source_seqs
         FROM action_items a
         JOIN meetings m ON m.id = a.meeting_id
         WHERE m.owner_id = $1 AND a.owner_name = $2
         ORDER BY a.id`,
        [ownerId, ownerName],
      );

      return rows.map(toActionItem);
    },

    async updateActionItem(id, patch: ActionItemPatch) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

      // COALESCE would treat an explicit null as "leave alone", which would
      // make it impossible to clear an owner — so each key is applied only
      // when present.
      const sets: string[] = [];
      const values: unknown[] = [id];

      if ('ownerName' in patch) {
        values.push(patch.ownerName ?? null);
        sets.push(`owner_name = $${values.length}`);
      }
      if ('dueDate' in patch) {
        values.push(patch.dueDate ?? null);
        sets.push(`due_date = $${values.length}`);
      }
      if (patch.status !== undefined) {
        values.push(patch.status);
        sets.push(`status = $${values.length}`);
      }

      if (sets.length === 0) {
        const { rows } = await pool.query<ActionRow>(
          `SELECT id, meeting_id, minutes_id, task, owner_name, due_date, confidence, status, source_seqs
           FROM action_items WHERE id = $1`,
          [id],
        );
        return rows.length === 0 ? null : toActionItem(rows[0]!);
      }

      const { rows } = await pool.query<ActionRow>(
        `UPDATE action_items SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, meeting_id, minutes_id, task, owner_name, due_date, confidence, status, source_seqs`,
        values,
      );

      return rows.length === 0 ? null : toActionItem(rows[0]!);
    },

    async close() {
      await pool.end();
    },
  };
}
