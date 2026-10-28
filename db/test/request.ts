// A stand-in for the request Next would give a Server Action: its cookies
// and headers, in memory. db/test/setup.ts points next/headers here, so the
// real requireUser (app/_lib/session.ts) runs in every database test against
// a real session row. Each test file starts signed in as its own test user;
// auth tests sign out or in through these helpers.
type Cookie = { name: string; value: string; options?: Record<string, unknown> };

export const testRequest = {
  cookies: new Map<string, Cookie>(),
  headers: new Headers({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' }),
};

export const cookieStore = {
  get: (name: string) => testRequest.cookies.get(name),
  has: (name: string) => testRequest.cookies.has(name),
  getAll: () => [...testRequest.cookies.values()],
  set: (name: string, value: string, options?: Record<string, unknown>) => {
    testRequest.cookies.set(name, { name, value, options });
  },
  delete: (name: string) => {
    testRequest.cookies.delete(name);
  },
};
