import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, sessionCookie } from '@/lib/auth/session-token';

// An early redirect to /sign-in for a page request with no session cookie
// (AUTH.md). Optimistic only, as Next documents proxy: it checks that a
// cookie is present, not that it is valid. The authorization is requireUser
// in every page, action and route handler (lib/auth-convention.test.ts).
// Non-GET requests (Server Actions) pass through to that check.
export function proxy(request: NextRequest) {
  if (process.env.DEMO_MODE === '1') return NextResponse.next();
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (request.method !== 'GET' && request.method !== 'HEAD') return NextResponse.next();
  if (request.cookies.has(sessionCookie(true).name) || request.cookies.has(sessionCookie(false).name)) {
    return NextResponse.next();
  }
  const url = request.nextUrl.clone();
  url.pathname = '/sign-in';
  url.search = pathname === '/' && !search ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Not Next's own assets or the icon.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon|apple-icon).*)'],
};
