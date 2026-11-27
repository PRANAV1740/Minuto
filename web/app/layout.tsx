import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Nav } from './nav.tsx';
import { currentUser } from './lib/session.ts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Minuto',
  description: 'Accurate minutes from meeting transcripts, with every claim traceable.',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await currentUser();

  return (
    <html lang="en">
      <body>
        <Nav user={user} />
        {children}
      </body>
    </html>
  );
}
