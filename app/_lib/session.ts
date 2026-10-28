import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createSession, sessionUser, type SignedInUser } from '@/db/auth';
import { isDemoMode } from '@/lib/demo-mode';
import { hashSessionToken, newSessionToken, sessionCookie } from '@/lib/auth/session-token';

// The session check every page and Server Action makes first (AUTH.md).
// This, not proxy.ts, is the authorization: Next documents proxy as an
// optimistic check only. lib/auth-convention.test.ts fails the build if an
// action, page or route handler does not call it (or is not on its short
// list of public entry points).

// The public demo has no sign-in: every request is this user, who owns
// nothing (the demo's ledger is synthetic). DEMO_MODE=1 can never hold
// production credentials (lib/deploy-guard.ts), so this cannot open the real
// ledger.
const DEMO_USER: SignedInUser = { id: 'demo', displayName: 'Demo', personId: null, sessionId: 'demo' };

const secureCookies = () => process.env.NODE_ENV === 'production';

// The signed-in user, or null.
export async function currentUser(): Promise<SignedInUser | null> {
  if (isDemoMode()) return DEMO_USER;
  const jar = await cookies();
  const token = jar.get(sessionCookie(secureCookies()).name)?.value;
  if (!token) return null;
  return sessionUser(hashSessionToken(token));
}

// The signed-in user; without one, to /sign-in. From a Server Action the
// redirect is a client navigation, so an expired session never shows as a
// crash (attempt() lets the redirect through).
export async function requireUser(): Promise<SignedInUser> {
  const user = await currentUser();
  if (!user) redirect('/sign-in');
  return user;
}

// After a verified passkey: a new session, its token in the cookie.
export async function startSession(userId: string): Promise<void> {
  const token = newSessionToken();
  const agent = (await headers()).get('user-agent');
  await createSession({ userId, tokenHash: hashSessionToken(token), userAgent: agent ? agent.slice(0, 300) : null });
  const { name, options } = sessionCookie(secureCookies());
  (await cookies()).set(name, token, options);
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(sessionCookie(secureCookies()).name);
}
