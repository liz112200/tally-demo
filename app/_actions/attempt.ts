import 'server-only';
import { unstable_rethrow } from 'next/navigation';
import { actionErrorLogLine, describeActionError, type ActionResult } from '@/lib/action-result';

// Runs a Server Action's body and turns anything it throws into the error the
// owner sees (lib/action-result.ts), logged without the failed SQL or its
// parameters. Not a Server Action itself: this file has no 'use server', so
// the client can never call it. Next's own control flow is let through
// (unstable_rethrow): requireUser's redirect to /sign-in for an expired
// session is a navigation, not an error.
export async function attempt<T extends ActionResult>(where: string, body: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await body();
  } catch (err) {
    unstable_rethrow(err);
    console.error(actionErrorLogLine(where, err));
    return { error: describeActionError(err) };
  }
}
