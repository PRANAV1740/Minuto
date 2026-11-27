/**
 * Validates what the editor sends, and decides which storage backend to use.
 *
 * The validation matters more than it looks. A server action is reachable by
 * direct POST, not only through the form — Next's own docs warn about it — so
 * this is a trust boundary, not a convenience. Anything unexpected is refused
 * by name, and unknown keys are dropped rather than passed through, so a
 * crafted request cannot rewrite a task or move it to another meeting.
 */

import type { ActionItemPatch, ActionItemStatus } from './types.ts';

export type PatchResult =
  | { ok: true; patch: ActionItemPatch }
  | { ok: false; error: string };

const STATUSES: readonly ActionItemStatus[] = ['open', 'done', 'dropped'];
const PLACEHOLDER = /^(unassigned|unknown|none|null|n\/a|na|tbd|tba|-|—)$/i;
const MAX_OWNER_LENGTH = 120;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A real calendar date, so 31 February is refused rather than stored. */
function isRealDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function parseActionItemPatch(input: unknown): PatchResult {
  if (!isRecord(input)) return { ok: false, error: 'the patch must be an object' };

  const patch: ActionItemPatch = {};

  if ('ownerName' in input) {
    const raw = input.ownerName;

    if (raw === null) {
      patch.ownerName = null;
    } else if (typeof raw !== 'string') {
      return { ok: false, error: 'the owner must be text, or null to unassign' };
    } else {
      const name = raw.trim();
      if (name.length > MAX_OWNER_LENGTH) {
        return { ok: false, error: `the owner name is too long (over ${MAX_OWNER_LENGTH})` };
      }
      // Clearing the field and typing "unassigned" mean the same thing.
      patch.ownerName = name === '' || PLACEHOLDER.test(name) ? null : name;
    }
  }

  if ('dueDate' in input) {
    const raw = input.dueDate;

    if (raw === null) {
      patch.dueDate = null;
    } else if (typeof raw !== 'string') {
      return { ok: false, error: 'the due date must be text, or null to clear it' };
    } else {
      const date = raw.trim();
      if (date === '') {
        patch.dueDate = null;
      } else if (!isRealDate(date)) {
        return { ok: false, error: `"${date}" is not a date in YYYY-MM-DD form` };
      } else {
        patch.dueDate = date;
      }
    }
  }

  if ('status' in input) {
    const raw = input.status;
    if (typeof raw !== 'string' || !STATUSES.includes(raw as ActionItemStatus)) {
      return { ok: false, error: `the status must be one of ${STATUSES.join(', ')}` };
    }
    patch.status = raw as ActionItemStatus;
  }

  return { ok: true, patch };
}

// ------------------------------------------------------------ store choice

export type StoreChoice =
  | { kind: 'memory'; reason: string }
  | { kind: 'postgres'; reason: string; connectionString: string; ssl: boolean };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Which backend the environment asks for, and why — the "why" is shown in the
 * app so nobody wonders where their meetings went after a restart.
 *
 * Never includes the password: this string is displayed.
 */
export function describeStore(env: Record<string, string | undefined>): StoreChoice {
  const raw = env.DATABASE_URL?.trim();

  if (!raw) {
    return { kind: 'memory', reason: 'no database configured — nothing is saved between restarts' };
  }

  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return {
      kind: 'memory',
      reason: 'the database URL could not be read — nothing is saved between restarts',
    };
  }

  // A hosted database needs TLS; a local one usually has no certificate.
  const ssl = !LOCAL_HOSTS.has(host);

  return {
    kind: 'postgres',
    reason: `saving to Postgres at ${host}`,
    connectionString: raw,
    ssl,
  };
}
