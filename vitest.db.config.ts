import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The database suite (npm run test:db, scripts/test-db.sh): db/**/*.dbtest.ts
// against the throwaway Postgres + PgBouncer from docker-compose.test.yml.
// Files run one at a time; tests inside a file share one database and build
// their own rows, so no test depends on another's leftovers.
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': root,
      // The real package throws outside a React server bundle.
      'server-only': fileURLToPath(new URL('./db/test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['db/**/*.dbtest.ts'],
    globalSetup: ['db/test/global-setup.ts'],
    setupFiles: ['db/test/setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
