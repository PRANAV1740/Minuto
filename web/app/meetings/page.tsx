import Link from 'next/link';

import { getStore, storeChoice } from '../lib/store.ts';
import { requireUser } from '../lib/session.ts';

export const dynamic = 'force-dynamic';

export default async function MeetingsPage() {
  const user = await requireUser();
  const store = await getStore();
  const meetings = await store.listMeetings(user.id);

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>Meetings</h1>
        <p className="standfirst">
          {storeChoice.kind === 'postgres'
            ? 'Saved and editable. Correcting an owner here sticks.'
            : 'Running without a database — these disappear when the server restarts.'}
        </p>
      </header>

      <div className="meta">
        <span className={storeChoice.kind === 'postgres' ? 'chip on' : 'chip'}>
          {storeChoice.reason}
        </span>
        <Link href="/" className="chip">
          new minutes →
        </Link>
      </div>

      {meetings.length === 0 ? (
        <section className="card">
          <p className="empty">
            Nothing saved yet. <Link href="/">Make some minutes</Link> and they will appear here.
          </p>
        </section>
      ) : (
        <section className="card">
          {meetings.map((meeting) => (
            <div key={meeting.id} className="item">
              <Link href={`/meetings/${meeting.id}`}>
                <strong>{meeting.title}</strong>
              </Link>
              <span className="because">
                {' '}
                — {meeting.meetingDate ?? new Date(meeting.createdAt).toISOString().slice(0, 10)}
              </span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
