import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { credentialCount } from '@/db/auth';
import { isDemoMode } from '@/lib/demo-mode';
import { relyingParty } from '@/lib/auth/relying-party';
import { currentUser } from '@/app/_lib/session';
import { BootstrapForm, SignInButton } from '@/app/_components/sign-in';

export const metadata = { title: 'Sign in · tally' };
export const dynamic = 'force-dynamic';

// Public (lib/auth/session-token.ts isPublicPath). Until the first passkey
// exists this sets the app up with AUTH_BOOTSTRAP_TOKEN; after that it only
// signs in.
export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (isDemoMode()) redirect('/');
  const { next } = await searchParams;
  if (await currentUser()) redirect('/');
  const setUp = (await credentialCount()) > 0;
  // A passkey works only at the hostname it was made for. On any other
  // address (a deployment's own URL, a preview) say where to go instead of
  // letting the browser fail with nothing to explain it.
  let elsewhere: { text: string; href?: string } | null = null;
  try {
    const rp = relyingParty(process.env);
    const host = ((await headers()).get('host') ?? '').split(':')[0];
    if (host !== rp.rpID) elsewhere = { text: `Passkeys for Tally belong to ${rp.rpID}.`, href: `${rp.origin}/sign-in` };
  } catch (err) {
    elsewhere = { text: err instanceof Error ? err.message : 'Sign-in is not available here.' };
  }
  if (elsewhere) {
    return (
      <main className="mx-auto max-w-md px-6 py-16">
        <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {elsewhere.text}{' '}
          {elsewhere.href && (
            <a href={elsewhere.href} className="underline underline-offset-2">
              Sign in there
            </a>
          )}
        </p>
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">{setUp ? 'Sign in' : 'Set up Tally'}</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        {setUp
          ? 'Use a passkey saved on this device or one nearby.'
          : 'No passkey exists yet. Create the first one with the setup token.'}
      </p>
      {setUp ? <SignInButton next={typeof next === 'string' ? next : '/'} /> : <BootstrapForm />}
    </main>
  );
}
