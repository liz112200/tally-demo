import { isDemoDeployment, type GuardEnv } from './deploy-guard';

// Every environment variable the app's code reads, and where it must be set.
// lib/env-manifest.test.ts reads the source for every variable read and fails
// on one missing here (or listed here and read nowhere), so a new variable
// cannot ship unclassified. next.config.ts fails a production build that
// lacks a variable its deployment requires, naming it: two required
// variables were found missing only when they were needed
// (AUTH_BOOTSTRAP_TOKEN's ordering, PLAID_REDIRECT_URI).
//
// The two production deployments built from this code:
//   app  — the private app (VERCEL_ENV=production, not demo)
//   demo — tally-demo (VERCEL_ENV=production, isDemoDeployment)
// Previews and local builds are not checked; the share project (share/) is
// a separate build that reads only DATABASE_URL.
export type EnvUse =
  // Must be set on these production deployments.
  | { required: readonly ('app' | 'demo')[] }
  // Read, but its absence is handled, or it is for local work and scripts.
  | { optional: true }
  // Set by Vercel or Node, not by the owner; listed so the test accounts for it.
  | { platform: true };

export const ENV_VARS: Record<string, EnvUse & { why: string }> = {
  DATABASE_URL: { required: ['app', 'demo'], why: 'the ledger' },
  BLOB_STORE_ID: {
    optional: true,
    why: 'receipt images on the app (with Vercel OIDC); one of it or BLOB_READ_WRITE_TOKEN is required there, see ANY_OF',
  },
  BLOB_READ_WRITE_TOKEN: { required: ['demo'], why: 'receipt images; the demo reset passes it explicitly' },
  GEMINI_API_KEY: { required: ['app'], why: 'receipt extraction (the demo stubs it and the guard refuses a key there)' },
  AUTH_BOOTSTRAP_TOKEN: {
    required: ['app'],
    why: 'the first passkey, recovery after auth:reset, and re-registering for a new domain (AUTH.md); inert while a passkey exists',
  },
  NEXT_PUBLIC_SHARE_BASE_URL: {
    required: ['app'],
    why: 'share links point at the share project; unset, they point at the app, which recipients cannot open',
  },
  BANK_TOKEN_KEY: { required: ['app'], why: 'seals Plaid access tokens (BANK-SYNC.md); backed up outside Vercel' },
  PLAID_CLIENT_ID: { required: ['app'], why: 'Plaid' },
  PLAID_SECRET: { required: ['app'], why: 'Plaid; its value is checked by the deploy guard' },
  PLAID_ENV: { required: ['app'], why: 'Plaid; production on the app, checked by the deploy guard' },
  PLAID_REDIRECT_URI: {
    required: ['app'],
    why: 'OAuth institutions; Plaid is sent a redirect URI only when this is set, whatever the dashboard allows',
  },
  // Required wherever a cron is declared (vercel.ts): the demo's daily reset
  // today; the app too once slice 5 schedules production syncs.
  CRON_SECRET: { required: ['demo'], why: "authorizes Vercel Cron's requests" },
  DEMO_MODE: { required: ['demo'], why: 'the demo runs as a synthetic user with synthetic data' },
  VERCEL_PROJECT_PRODUCTION_URL: {
    required: ['app'],
    why: 'set by Vercel; the passkey relying party, which refuses to run without it',
  },
  AUTH_ORIGIN: { optional: true, why: 'the relying party under next dev' },
  DRIZZLE_ENV_FILE: { optional: true, why: 'which env file drizzle-kit migrates' },
  NEXT_PUBLIC_OWNER_NAME: { optional: true, why: "db/seed.ts: the owner's name in a fresh database" },
  NODE_ENV: { platform: true, why: 'set by Next.js' },
  VERCEL_ENV: { platform: true, why: 'set by Vercel' },
  GITHUB_TOKEN: { platform: true, why: "set by GitHub Actions; scripts/ci/wait-deployments.mjs reads Vercel's deployment statuses with it" },
};

// Requirements met by any one of a group.
export const ANY_OF: readonly { names: readonly string[]; on: 'app' | 'demo'; why: string }[] = [
  {
    names: ['BLOB_STORE_ID', 'BLOB_READ_WRITE_TOKEN'],
    on: 'app',
    why: 'receipt images: @vercel/blob uses BLOB_STORE_ID with OIDC, else the token',
  },
];

// Which production deployment this build is, or null when it is neither.
export function deploymentKind(env: GuardEnv): 'app' | 'demo' | null {
  if (env.VERCEL_ENV !== 'production') return null;
  return isDemoDeployment(env) ? 'demo' : 'app';
}

// The variables a production build lacks, one sentence each; empty when
// nothing is missing or the build is not a production deployment.
export function missingEnvironment(env: GuardEnv): string[] {
  const kind = deploymentKind(env);
  if (kind === null) return [];
  const set = (name: string) => (env[name] ?? '').trim() !== '';
  const missing = Object.entries(ENV_VARS)
    .filter(([name, use]) => 'required' in use && use.required.includes(kind) && !set(name))
    .map(([name, use]) => `${name} is not set (${use.why}).`);
  for (const group of ANY_OF) {
    if (group.on === kind && !group.names.some(set)) {
      missing.push(`None of ${group.names.join(', ')} is set (${group.why}).`);
    }
  }
  return missing;
}
