// Runs once before the database suite. Marks the database as the test
// database and applies every migration, straight to Postgres (not through
// PgBouncer). It refuses any database that is not local, and any database
// that holds tables without the `tally-test` comment: the mark is only ever
// written on an empty database, so a real one can never acquire it (the same
// pattern as the demo marker, db/demo-guard.ts).
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { TEST_MARKER, localTestUrl } from './target';

export default async function setup(): Promise<void> {
  localTestUrl('TEST_DATABASE_URL');
  const client = postgres(localTestUrl('TEST_DATABASE_DIRECT_URL'), { max: 1, onnotice: () => {} });
  try {
    const [{ name, comment }] = await client<{ name: string; comment: string | null }[]>`
      select current_database() as name, shobj_description(oid, 'pg_database') as comment
      from pg_database where datname = current_database()`;
    if (comment !== TEST_MARKER) {
      const [{ tables }] = await client<{ tables: number }[]>`
        select count(*)::int as tables from pg_tables
        where schemaname not in ('pg_catalog', 'information_schema')`;
      if (tables > 0) {
        throw new Error(`Refusing: database ${name} has tables and is not marked ${TEST_MARKER}.`);
      }
      await client.unsafe(`comment on database "${name.replace(/"/g, '""')}" is '${TEST_MARKER}'`);
    }
    await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  } finally {
    await client.end();
  }
}
