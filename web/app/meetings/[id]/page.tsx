import Link from 'next/link';
import { notFound } from 'next/navigation';

import { toPlainText, toHtml } from '../../../../src/minutes/export.ts';
import { getStore, storeChoice } from '../../lib/store.ts';
import { requireUser } from '../../lib/session.ts';
import { ActionItems } from './editor.tsx';
import { ExportButtons } from '../../export-buttons.tsx';

export const dynamic = 'force-dynamic';

const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
};

export default async function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const store = await getStore();

  const meeting = await store.getMeeting(id);
  // Not "forbidden": a meeting that is not yours must be indistinguishable
  // from one that does not exist, or the id itself leaks that it is real.
  if (!meeting || meeting.ownerId !== user.id) notFound();

  const [minutes, segments, items] = await Promise.all([
    store.getLatestMinutes(id),
    store.getSegments(id),
    store.listActionItems(id),
  ]);

  const timeOf = new Map(segments.map((segment) => [segment.seq, segment.tStartMs]));
  const cite = (seqs: readonly number[]): string => {
    const stamps = seqs
      .map((seq) => timeOf.get(seq))
      .filter((ms): ms is number => ms !== undefined)
      .map(clock);
    return stamps.length === 0 ? '' : `[${stamps.join(', ')}]`;
  };

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>{meeting.title}</h1>
        <p className="standfirst">
          {meeting.meetingDate ?? new Date(meeting.createdAt).toISOString().slice(0, 10)} ·{' '}
          {segments.length} segments
          {minutes ? ` · written by ${minutes.writtenBy} (v${minutes.version})` : ''}
        </p>
      </header>

      <div className="meta">
        <Link href="/meetings" className="chip">
          ← all meetings
        </Link>
        <span className={storeChoice.kind === 'postgres' ? 'chip on' : 'chip'}>
          {storeChoice.reason}
        </span>
      </div>

      {minutes === null ? (
        <section className="card">
          <p className="empty">No minutes were saved for this meeting.</p>
        </section>
      ) : (
        <div className="grid">
          <section className="card">
            <ExportButtons
              title={meeting.title}
              markdown={minutes.markdown}
              text={toPlainText(minutes.payload, segments)}
              html={toHtml(minutes.payload, segments)}
            />
            <h2 style={{ marginTop: '1.25rem' }}>Action items</h2>
            <ActionItems meetingId={id} items={items} cites={items.map((i) => cite(i.sourceSeqs))} />

            {minutes.payload.decisions.length > 0 && (
              <>
                <h2 style={{ marginTop: '2rem' }}>Decisions</h2>
                {minutes.payload.decisions.map((decision) => (
                  <div key={decision.decision} className="item">
                    {decision.decision}
                    <span className="cite">{cite(decision.sourceSeqs)}</span>
                  </div>
                ))}
              </>
            )}

            {minutes.payload.openQuestions.length > 0 && (
              <>
                <h2 style={{ marginTop: '2rem' }}>Open questions</h2>
                <ul className="plain">
                  {minutes.payload.openQuestions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="card">
            <h2>Summary</h2>
            <p>{minutes.payload.summary}</p>
            {minutes.payload.attendeesSpeaking.length > 0 && (
              <p className="hint">Speakers: {minutes.payload.attendeesSpeaking.join(', ')}</p>
            )}

            <h2 style={{ marginTop: '2rem' }}>Transcript</h2>
            {segments.map((segment) => (
              <div key={segment.seq} className="item">
                <span className="owner">{segment.speakerName ?? 'Unknown'}</span>
                <span className="cite">{clock(segment.tStartMs)}</span> {segment.text}
              </div>
            ))}
          </section>
        </div>
      )}
    </div>
  );
}
