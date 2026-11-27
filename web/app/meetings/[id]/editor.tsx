'use client';

/**
 * The editor: correcting what the pipeline got wrong.
 *
 * A model will sometimes put the wrong name against a task, or none at all,
 * and the whole product rests on that being a two-second fix rather than a
 * reason to distrust the minutes. Owner, due date and status are editable;
 * the task text and its citations are not, because those are what tie the item
 * back to something that was actually said.
 *
 * Edits apply optimistically and roll back if the server refuses, so a
 * rejected change never looks like it was accepted.
 */

import { useState, useTransition } from 'react';

import { editActionItem } from '../actions.ts';
import type { StoredActionItem } from '../../../../src/store/types.ts';

type Props = {
  meetingId: string;
  items: StoredActionItem[];
  /** Pre-rendered citations, parallel to `items`. */
  cites: string[];
};

export function ActionItems({ meetingId, items, cites }: Props) {
  const [rows, setRows] = useState(items);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  if (rows.length === 0) {
    return <p className="empty">No tasks were found in this meeting.</p>;
  }

  const apply = (id: string, patch: Record<string, unknown>) => {
    const before = rows;
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...patch } as StoredActionItem : row)),
    );
    setError(null);

    startTransition(async () => {
      const result = await editActionItem(meetingId, id, patch);
      if (!result.ok) {
        // Put it back: a refused edit must not look like it stuck.
        setRows(before);
        setError(result.error);
      }
    });
  };

  return (
    <>
      {error !== null && <div className="notice bad">{error}</div>}

      {rows.map((item, index) => (
        <div key={item.id} className="item">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={item.status === 'done'}
              onChange={(event) =>
                apply(item.id, { status: event.target.checked ? 'done' : 'open' })
              }
              aria-label={`Mark "${item.task}" as done`}
            />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                textDecoration: item.status === 'done' ? 'line-through' : 'none',
                opacity: item.status === 'done' ? 0.6 : 1,
              }}
            >
              {item.task}
              <span className="cite">{cites[index]}</span>
            </span>
          </div>

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.4rem', flexWrap: 'wrap' }}>
            <input
              type="text"
              defaultValue={item.ownerName ?? ''}
              placeholder="unassigned"
              aria-label={`Owner of "${item.task}"`}
              style={{ width: '12rem' }}
              onBlur={(event) => {
                const next = event.target.value.trim();
                if (next !== (item.ownerName ?? '')) apply(item.id, { ownerName: next });
              }}
            />
            <input
              type="date"
              defaultValue={item.dueDate ?? ''}
              aria-label={`Due date of "${item.task}"`}
              style={{ width: '10rem' }}
              onChange={(event) => apply(item.id, { dueDate: event.target.value })}
            />
          </div>
        </div>
      ))}
    </>
  );
}
