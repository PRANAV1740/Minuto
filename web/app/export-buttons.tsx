'use client';

/**
 * Getting the minutes out of Minuto.
 *
 * "Copy formatted" puts HTML *and* plain text on the clipboard at once, so
 * pasting into Gmail, Word or a Google Doc keeps the headings and the table,
 * while pasting into a terminal or a plain-text field still works. That is the
 * Google Docs export in practice, with no API, no OAuth scope and no review.
 *
 * Print goes through the browser's own dialog, which offers Save as PDF
 * everywhere — a PDF library on the server would cost a dependency and a cold
 * start to produce something slightly worse.
 */

import { useState } from 'react';

type Props = {
  markdown: string;
  text: string;
  html: string;
  /** Used for the download filename. */
  title: string;
};

const slug = (title: string): string =>
  title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'minutes';

function download(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement('a');

  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();

  // Revoked on the next tick so the download has started.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportButtons({ markdown, text, html, title }: Props) {
  const [said, setSaid] = useState<string | null>(null);

  const flash = (message: string) => {
    setSaid(message);
    setTimeout(() => setSaid(null), 2500);
  };

  const copyFormatted = async () => {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      flash('copied — paste into a doc or email');
    } catch {
      // Older browsers and some contexts refuse the rich write; plain text is
      // better than nothing and never fails for the same reason.
      try {
        await navigator.clipboard.writeText(text);
        flash('copied as plain text');
      } catch {
        flash('the browser would not allow copying');
      }
    }
  };

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      flash('markdown copied');
    } catch {
      flash('the browser would not allow copying');
    }
  };

  return (
    <div className="actions no-print">
      <button type="button" className="secondary" onClick={() => void copyFormatted()}>
        Copy formatted
      </button>
      <button type="button" className="secondary" onClick={() => void copyMarkdown()}>
        Copy Markdown
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => download(`${slug(title)}.md`, markdown, 'text/markdown')}
      >
        Download .md
      </button>
      <button
        type="button"
        className="secondary"
        onClick={() => download(`${slug(title)}.txt`, text, 'text/plain')}
      >
        Download .txt
      </button>
      <button type="button" className="secondary" onClick={() => window.print()}>
        Print / PDF
      </button>
      {said !== null && <span className="chip on">{said}</span>}
    </div>
  );
}
