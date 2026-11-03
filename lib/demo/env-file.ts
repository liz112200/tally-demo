// Which credentials file the demo scripts read: .env.demo (tally-demo's own
// stores) by default, or .env.demo-local (a local database and a Blob store of
// its own, for checking demo changes without touching tally-demo) with
// DEMO_ENV=local. Nothing else, and never .env.local, which holds the owner's
// real credentials. Either way db/demo-guard.ts still requires both markers.
export const DEMO_ENV_FILES = { demo: '.env.demo', local: '.env.demo-local' } as const;

export function demoEnvFile(env: { DEMO_ENV?: string; [name: string]: string | undefined } = process.env): string {
  const which = env.DEMO_ENV ?? 'demo';
  if (which !== 'demo' && which !== 'local') {
    throw new Error(`DEMO_ENV must be "demo" or "local", not ${JSON.stringify(which)}.`);
  }
  return DEMO_ENV_FILES[which];
}
