// One-time provisioning for the demo: mark a FRESH database and Blob store as
// the demo's, so the deployment guard (db/demo-guard.ts) accepts them.
//
//   npm run demo:mark -- <neon-endpoint-id>
//
// Reads .env.demo only — never .env.local, which holds the owner's real
// credentials. The endpoint id argument must match DATABASE_URL's host, as a
// typed confirmation of which database is being marked. Refuses a database
// whose tables hold any rows and a Blob store holding any object other than
// the marker: production can never be marked, by accident or otherwise.
import { config } from 'dotenv';
import postgres from 'postgres';
import { list, put } from '@vercel/blob';
import { databaseEndpointId } from '../lib/deploy-guard';
import { DEMO_BLOB_MARKER, DEMO_DB_COMMENT } from './demo-guard';

config({ path: '.env.demo' });

async function main() {
  const url = process.env.DATABASE_URL;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!url || !token) throw new Error('.env.demo must set DATABASE_URL and BLOB_READ_WRITE_TOKEN');

  const expected = process.argv[2];
  const actual = databaseEndpointId(url);
  if (!expected || expected !== actual) {
    throw new Error(
      `Pass the demo database's endpoint id to confirm. DATABASE_URL points at ${actual}.`,
    );
  }

  const client = postgres(url, { prepare: false, max: 1 });
  try {
    // Every table in the public schema must be empty (or absent: marking
    // before the first migration is fine).
    const tables = await client<{ name: string }[]>`
      SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'
    `;
    for (const { name } of tables) {
      if (name.startsWith('__drizzle')) continue;
      const [{ n }] = await client`SELECT count(*)::int AS n FROM ${client(name)}`;
      if (n > 0) throw new Error(`Refusing to mark: table ${name} holds ${n} rows.`);
    }
    const [{ db }] = await client<{ db: string }[]>`SELECT current_database() AS db`;
    // COMMENT takes no bind parameters; the name is quoted here and the
    // comment is a constant.
    await client.unsafe(
      `COMMENT ON DATABASE "${db.replace(/"/g, '""')}" IS '${DEMO_DB_COMMENT}'`,
    );
    console.log(`Marked database ${db} (${actual}) as the demo's.`);
  } finally {
    await client.end();
  }

  const { blobs } = await list({ token, limit: 10 });
  const others = blobs.filter((b) => b.pathname !== DEMO_BLOB_MARKER);
  if (others.length > 0) {
    throw new Error(`Refusing to mark: the Blob store already holds ${others.length}+ objects.`);
  }
  await put(DEMO_BLOB_MARKER, 'tally demo store\n', {
    token,
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'text/plain',
  });
  console.log('Marked the Blob store as the demo\'s.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
