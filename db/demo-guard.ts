// Positive identification of the demo's stores (layer 2 of the deployment
// guard; layer 1 is lib/deploy-guard.ts). A demo build, and every demo reset,
// requires both:
//   - the database to carry the comment DEMO_DB_COMMENT (COMMENT ON
//     DATABASE), which lives outside the app schema, so no migration ever
//     touches production for it. (A custom ALTER DATABASE ... SET parameter
//     would read more naturally, but Neon's owner role may not set one.)
//   - the Blob store to hold DEMO_BLOB_MARKER.
// Only db/demo-mark.ts writes either marker, and it refuses any store that
// already holds data, so production can never acquire them.
//
// No 'server-only' and relative imports only: next.config.ts runs this at
// build time, outside the React server environment.
import postgres from 'postgres';
import { head } from '@vercel/blob';

export const DEMO_DB_COMMENT = 'tally-demo';

// The current database's comment; the marker check reads it here and inside
// the reset transaction.
export const DEMO_DB_COMMENT_QUERY = `
  SELECT shobj_description(oid, 'pg_database') AS value
  FROM pg_database WHERE datname = current_database()`;
export const DEMO_BLOB_MARKER = '_tally/demo-store-marker.txt';

export async function demoStoreProblems(env: {
  DATABASE_URL?: string;
  BLOB_READ_WRITE_TOKEN?: string;
}): Promise<string[]> {
  const problems: string[] = [];

  if (!env.DATABASE_URL) {
    problems.push('DATABASE_URL is not set.');
  } else {
    const client = postgres(env.DATABASE_URL, { prepare: false, max: 1 });
    try {
      const [row] = await client.unsafe(DEMO_DB_COMMENT_QUERY);
      if (row?.value !== DEMO_DB_COMMENT) {
        problems.push(
          `The database is not marked as the demo's (its comment is ${JSON.stringify(row?.value ?? null)}).`,
        );
      }
    } catch (err) {
      problems.push(`Could not check the database marker: ${(err as Error).message}`);
    } finally {
      await client.end();
    }
  }

  if (!env.BLOB_READ_WRITE_TOKEN) {
    problems.push('BLOB_READ_WRITE_TOKEN is not set.');
  } else {
    try {
      await head(DEMO_BLOB_MARKER, { token: env.BLOB_READ_WRITE_TOKEN });
    } catch {
      problems.push(`The Blob store does not hold the demo marker (${DEMO_BLOB_MARKER}).`);
    }
  }

  return problems;
}
