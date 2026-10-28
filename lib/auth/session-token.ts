// Session tokens, cookies, and which paths are public (AUTH.md). Pure.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// 256 random bits, base64url. The cookie holds this; the database holds only
// its sha256, so a leaked sessions table opens nothing.
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Sessions slide: each use pushes expiry out to this many days from now, at
// most once a day so a page view is not a write.
export const SESSION_DAYS = 30;
export const SESSION_SLIDE_AFTER_HOURS = 24;

// The session cookie. `__Host-` requires Secure and Path=/ and forbids a
// Domain, so no subdomain can set or read it; localhost in dev is plain
// http, where a Secure cookie is not reliably kept, so dev uses a plain name.
export function sessionCookie(secure: boolean) {
  return {
    name: secure ? '__Host-tally_session' : 'tally_session',
    options: {
      httpOnly: true,
      secure,
      sameSite: 'lax' as const,
      path: '/',
      // The browser's own cap; the database expiry is the authority.
      maxAge: 400 * 24 * 60 * 60,
    },
  };
}

// Routes reachable without a session. Everything else needs one, checked in
// the page or action itself (requireUser); proxy.ts only redirects early.
//  - /sign-in: where the owner signs in.
//  - /s/<token>: share snapshots, public by design (CLAUDE.md).
//  - /api/cron/: authorised by CRON_SECRET instead (isCronRequest).
//  - /api/demo/: 404s outside the demo, which is public.
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === '/sign-in' ||
    pathname.startsWith('/s/') ||
    pathname.startsWith('/api/cron/') ||
    pathname.startsWith('/api/demo/')
  );
}

// Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Constant time, and
// never true when the secret is unset or short: an empty secret would match
// an empty header.
export function isCronRequest(authorization: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(authorization);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// The bootstrap token, compared in constant time; unset or short refuses all.
export function isBootstrapToken(given: string, expected: string | undefined): boolean {
  if (!expected || expected.length < 16) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}
