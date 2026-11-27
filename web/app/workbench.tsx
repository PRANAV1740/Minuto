'use client';

import { useActionState, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

import { generateMinutes, type MinutesResult } from './actions.ts';
import { saveMeeting } from './meetings/actions.ts';
import { ExportButtons } from './export-buttons.tsx';
import { toPlainText, toHtml } from '../../src/minutes/export.ts';

const SAMPLE = `[0:04] Pranav K: Morning everyone, thanks for joining.
[0:11] Pranav K: So we'll ship the geodasist demo on Friday. The deck is nearly ready.
[0:26] Asha R: I will prepare the slide deck by Thursday.
[0:41] Pranav K: Who is presenting the demo?
[1:02] Pranav K: Ravi will book the room for 5000 rupees.
[1:15] Asha R: We agreed to postpone the launch until the next sprint.`;

const clock = (ms: number): string => {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return total >= 3600
    ? `${Math.floor(total / 3600)}:${String(minutes % 60).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
};

export function Workbench({ model }: { model: string | null }) {
  const [result, submit, pending] = useActionState<MinutesResult | null, FormData>(
    generateMinutes,
    null,
  );

  // Controlled on purpose: React resets an uncontrolled form once a server
  // action resolves, which would wipe the transcript and settings every time
  // you pressed the button — exactly when you want to adjust and run again.
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [glossary, setGlossary] = useState('');
  const [transcript, setTranscript] = useState(SAMPLE);

  return (
    <div className="grid">
      <form action={submit}>
        <section className="card">
          <h2>Transcript</h2>

          <div className="row">
            <div>
              <label htmlFor="title">Title</label>
              <input
                id="title"
                name="title"
                type="text"
                placeholder="Weekly sync"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="date">Date</label>
              <input
                id="date"
                name="date"
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="glossary">Names and terms</label>
            <input
              id="glossary"
              name="glossary"
              type="text"
              placeholder="Geodesis, Pranav, Asha, Ravi"
              value={glossary}
              onChange={(event) => setGlossary(event.target.value)}
            />
            <p className="hint">
              Used to correct misheard names, and counted as known when checking what the minutes
              claim.
            </p>
          </div>

          <div className="field">
            <label htmlFor="transcript">Transcript</label>
            <textarea
              id="transcript"
              name="transcript"
              value={transcript}
              onChange={(event) => setTranscript(event.target.value)}
              spellCheck={false}
              aria-describedby="transcript-hint"
            />
            <p className="hint" id="transcript-hint">
              One line per utterance. <code>[1:02] Name: text</code>, or just{' '}
              <code>Name: text</code>. Wrapped lines join the line above.
            </p>
          </div>

          <div className="check">
            <input
              id="useModel"
              name="useModel"
              type="checkbox"
              defaultChecked={model !== null}
              disabled={model === null}
            />
            <label htmlFor="useModel" style={{ margin: 0 }}>
              {model === null
                ? 'No model configured — minutes will be extracted by rule. Set MINUTO_API_KEY to enable one.'
                : `Let ${model} write the minutes`}
            </label>
          </div>

          <button type="submit" disabled={pending}>
            {pending ? 'Working…' : 'Make minutes'}
          </button>
        </section>
      </form>

      <section className="card">
        <h2>Minutes</h2>
        {result === null ? (
          <p className="empty">Nothing yet. Paste a transcript and press Make minutes.</p>
        ) : result.ok ? (
          <Minutes result={result} title={title} date={date} />
        ) : (
          <div className="notice bad">{result.error}</div>
        )}
      </section>
    </div>
  );
}

function Minutes({
  result,
  title,
  date,
}: {
  result: Extract<MinutesResult, { ok: true }>;
  title: string;
  date: string;
}) {
  const { minutes, segments, flagged, dropped, corrections, refused, wrote } = result;
  const timeOf = new Map(segments.map((segment) => [segment.seq, segment.tStartMs]));
  const router = useRouter();
  const [saving, startSaving] = useTransition();
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = () => {
    setSaveError(null);
    startSaving(async () => {
      try {
        const { id } = await saveMeeting({
          title: title.trim() === '' ? minutes.title : title,
          meetingDate: date === '' ? null : date,
          segments,
          minutes,
          markdown: result.markdown,
          writtenBy: wrote,
        });
        router.push(`/meetings/${id}`);
      } catch (error) {
        setSaveError(error instanceof Error ? error.message : 'could not save');
      }
    });
  };

  const cite = (seqs: readonly number[]): string => {
    const stamps = seqs
      .map((seq) => timeOf.get(seq))
      .filter((ms): ms is number => ms !== undefined)
      .map(clock);
    return stamps.length === 0 ? '' : `[${stamps.join(', ')}]`;
  };

  const warningFor = (text: string): string | null => {
    const hits = flagged.filter((flag) => flag.text === text).map((flag) => flag.entity);
    return hits.length === 0 ? null : `unverified: ${hits.join(', ')}`;
  };

  return (
    <div className="minutes">
      <div className="meta">
        <span className="chip on">written by {wrote}</span>
        <span className="chip">{segments.length} segments</span>
        <span className="chip">{minutes.decisions.length} decisions</span>
        <span className="chip">{minutes.actionItems.length} actions</span>
      </div>

      <div className="actions" style={{ marginTop: 0, marginBottom: '1rem' }}>
        <button type="button" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save and edit'}
        </button>
        <Link href="/meetings" className="chip" style={{ alignSelf: 'center' }}>
          all meetings →
        </Link>
      </div>

      {saveError !== null && <div className="notice bad">{saveError}</div>}

      <ExportButtons
        title={minutes.title}
        markdown={result.markdown}
        text={toPlainText(minutes, segments)}
        html={toHtml(minutes, segments)}
      />

      {corrections.length > 0 && (
        <div className="notice">
          Corrected against your terms:{' '}
          {corrections.map((fix) => `“${fix.from}” → “${fix.to}”`).join(', ')}
        </div>
      )}

      {dropped.length > 0 && (
        <div className="notice bad">
          Dropped as untraceable:{' '}
          {dropped.map((item) => `“${item.text}” (${item.reason})`).join('; ')}
        </div>
      )}

      {refused.length > 0 && (
        <div className="notice bad">
          Refused from the model: {refused.join('; ')}
        </div>
      )}

      <h3>{minutes.title}</h3>
      <p>{minutes.summary}</p>

      {minutes.attendeesSpeaking.length > 0 && (
        <p className="hint">Speakers: {minutes.attendeesSpeaking.join(', ')}</p>
      )}

      {minutes.topics.length > 0 && (
        <>
          <h4>Topics</h4>
          {minutes.topics.map((topic) => (
            <div key={topic.heading} className="item">
              <strong>{topic.heading}</strong>
              <ul className="plain">
                {topic.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </div>
          ))}
        </>
      )}

      {minutes.decisions.length > 0 && (
        <>
          <h4>Decisions</h4>
          {minutes.decisions.map((decision) => (
            <div key={decision.decision} className="item">
              {decision.decision}
              {decision.rationale !== null && (
                <span className="because"> — {decision.rationale}</span>
              )}
              <span className="cite">{cite(decision.sourceSeqs)}</span>
              {warningFor(decision.decision) !== null && (
                <span className="flagwarn">{warningFor(decision.decision)}</span>
              )}
            </div>
          ))}
        </>
      )}

      {minutes.actionItems.length > 0 && (
        <>
          <h4>Action items</h4>
          {minutes.actionItems.map((item) => (
            <div key={item.task} className="item">
              <span className={item.ownerName === null ? 'owner none' : 'owner'}>
                {item.ownerName ?? 'unassigned'}
              </span>
              {item.task}
              {item.dueDate !== null && <span className="because"> — due {item.dueDate}</span>}
              <span className="cite">{cite(item.sourceSeqs)}</span>
              {warningFor(item.task) !== null && (
                <span className="flagwarn">{warningFor(item.task)}</span>
              )}
            </div>
          ))}
        </>
      )}

      {minutes.openQuestions.length > 0 && (
        <>
          <h4>Open questions</h4>
          <ul className="plain">
            {minutes.openQuestions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </>
      )}

      <h4>Markdown</h4>
      <pre className="markdown">{result.markdown}</pre>
    </div>
  );
}
