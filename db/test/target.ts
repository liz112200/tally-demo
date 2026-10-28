// Where the database tests may connect, checked before any connection: only
// a local database, named by the test runner's own variables. Never
// DATABASE_URL from an env file, which is dev or production.
export const TEST_MARKER = 'tally-test';

export function localTestUrl(name: 'TEST_DATABASE_URL' | 'TEST_DATABASE_DIRECT_URL'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; run the suite with npm run test:db.`);
  const host = new URL(value).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`${name} must point at a local database, not ${host}.`);
  }
  return value;
}
