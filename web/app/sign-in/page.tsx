import { redirect } from 'next/navigation';

import { googleEnabled } from '../lib/auth.ts';
import { currentUser } from '../lib/session.ts';
import { SignInForm } from './form.tsx';

export const dynamic = 'force-dynamic';

export default async function SignInPage() {
  if (await currentUser()) redirect('/meetings');

  return (
    <div className="wrap" style={{ maxWidth: '26rem' }}>
      <header className="masthead">
        <h1>Sign in to Minuto</h1>
        <p className="standfirst">
          Your meetings and minutes are kept to your account. Nothing is shared with anyone else.
        </p>
      </header>

      <SignInForm googleEnabled={googleEnabled} />
    </div>
  );
}
