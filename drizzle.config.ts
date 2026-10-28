import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Which env file supplies DATABASE_URL. Defaults to .env.local, which is
// production; `npm run db:migrate:dev` points it at the dev branch.
config({ path: process.env.DRIZZLE_ENV_FILE ?? '.env.local' });

export default defineConfig({
  schema: './db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
