// npm run demo:migrate — apply the app's migrations to the demo database.
//
// Never use `npm run db:migrate` for the demo: drizzle.config.ts reads
// .env.local, which holds the owner's production database. This reads
// .env.demo only and refuses unless the database carries the demo marker
// (db/demo-mark.ts runs first, on the fresh database).
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { demoStoreProblems } from './demo-guard';

config({ path: '.env.demo', quiet: true });

async function main() {
  const problems = await demoStoreProblems({
    DATABASE_URL: process.env.DATABASE_URL,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  });
  if (problems.length > 0) {
    throw new Error(`Refusing to migrate: not the demo's stores.\n- ${problems.join('\n- ')}`);
  }
  const client = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: './drizzle' });
    console.log('Demo database migrated.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
