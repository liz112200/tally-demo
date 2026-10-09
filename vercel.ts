import type { VercelConfig } from '@vercel/config/v1';

// One repository, two projects: the private app and the public demo. Only the
// demo schedules the daily reset (db/demo-reset.ts); declaring it statically
// would also schedule it against production, where the route is a 404.
//
// Mirrors isDemoDeployment in lib/deploy-guard.ts. Inlined because this file
// is compiled by plain Node ESM, which cannot resolve the app's extensionless
// TypeScript imports.
const isDemo =
  process.env.DEMO_MODE === '1' ||
  /^tally-demo([.-]|$)/.test(process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '');

const config: VercelConfig = {
  framework: 'nextjs',
  crons: isDemo ? [{ path: '/api/demo/reset', schedule: '0 9 * * *' }] : [],
};

// The default export is the vercel.json body; a named export would become a
// literal top-level key.
export default config;
