// Runs in each test file before its imports: points the app's database
// module (db/index.ts) at the test database, through PgBouncer, and checks
// the marker the global setup wrote, so no test can run against anything
// else even if the global setup were skipped.
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { beforeAll, vi } from 'vitest';
import { TEST_MARKER, localTestUrl } from './target';
import { cookieStore, testRequest } from './request';

// Server Actions read the request through next/headers, which only exists
// inside Next; tests give them the in-memory one (db/test/request.ts).
vi.mock('next/headers', () => ({
  cookies: async () => cookieStore,
  headers: async () => testRequest.headers,
}));

process.env.DATABASE_URL = localTestUrl('TEST_DATABASE_URL');

beforeAll(async () => {
  const client = postgres(process.env.DATABASE_URL as string, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [{ comment }] = await client<{ comment: string | null }[]>`
      select shobj_description(oid, 'pg_database') as comment
      from pg_database where datname = current_database()`;
    if (comment !== TEST_MARKER) throw new Error(`Refusing: the database is not marked ${TEST_MARKER}.`);
    // Each file signs in as its own user through a real session row, so the
    // real requireUser runs in every action a test calls.
    const [user] = await client<{ id: string }[]>`insert into users (display_name) values ('Test user') returning id`;
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await client`insert into sessions (user_id, token_hash, expires_at) values (${user.id}, ${tokenHash}, now() + interval '1 day')`;
    testRequest.cookies.clear();
    testRequest.cookies.set('tally_session', { name: 'tally_session', value: token });
  } finally {
    await client.end();
  }
});
