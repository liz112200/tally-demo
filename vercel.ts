import type { VercelConfig } from '@vercel/config/v1';

// One repository, two projects: the private app and the public demo. The app
// schedules the daily bank sync (SCHEDULED-SYNC.md) at 10:00 UTC, which Hobby
// runs within the following hour; the demo schedules its daily reset
// (db/demo-reset.ts) instead. Each route is a 404 on the other project.
//
// Mirrors isDemoDeployment in lib/deploy-guard.ts. Inlined because this file
// is compiled by plain Node ESM, which cannot resolve the app's extensionless
// TypeScript imports.
const isDemo =
  process.env.DEMO_MODE === '1' ||
  /^tally-demo([.-]|$)/.test(process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '');

const config: VercelConfig = {
  framework: 'nextjs',
  crons: isDemo
    ? [{ path: '/api/demo/reset', schedule: '0 9 * * *' }]
    : [{ path: '/api/cron/sync', schedule: '0 10 * * *' }],
};

// The default export is the vercel.json body; a named export would become a
// literal top-level key.
export default config;
