import { isDemoMode } from '@/lib/demo-mode';
import { duplicateOverrideAllowed } from '@/lib/bank-sync/link-guard';
import { OAuthResume } from '@/app/_components/oauth-resume';
import { requireUser } from '@/app/_lib/session';

export const metadata = { title: 'Bank sign-in · tally' };

// A finished Reconnect syncs the login (completeUpdate), so this page allows
// the same 300 s as /accounts.
export const maxDuration = 300;

// Where an OAuth institution sends the browser back when Link could not use a
// popup (PLAID_REDIRECT_URI; mobile web views). Link reopens here with the
// link token the Accounts page remembered and finishes the same flow.
export default async function OAuthRedirectPage() {
  await requireUser();
  return (
    <main className="mx-auto max-w-4xl px-6 py-8">
      <h1 className="text-xl font-semibold tracking-tight">Bank sign-in</h1>
      {isDemoMode() ? (
        <p className="mt-2 text-sm text-muted-foreground">Bank linking is not available in the demo.</p>
      ) : (
        <OAuthResume sandboxOverride={duplicateOverrideAllowed(process.env.PLAID_ENV)} />
      )}
    </main>
  );
}
