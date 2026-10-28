// Deployment guard. Pure checks over an environment object; no network.
//
// The public demo is a second Vercel project built from this same repository
// with deployment protection off, so the first failure that matters is a demo
// deployment holding production credentials. Two layers keep that from
// booting:
//
//   1. This module (synchronous, build and boot): a deployment that is a
//      demo — DEMO_MODE=1, or a production URL that names the tally-demo
//      project even if DEMO_MODE was forgotten — must not carry a database
//      endpoint or Blob store whose fingerprint is listed as production's,
//      must set DEMO_MODE explicitly, and must hold neither a Gemini key nor
//      any bank credential.
//   2. db/demo-guard.ts (network, build and reset): the database and Blob
//      store must positively identify themselves as the demo's via markers
//      that only a fresh, empty store can receive. Production can never pass
//      this regardless of what the fingerprint list holds.
//
// The same checks keep `next dev` off production's stores, and keep Plaid's
// environments apart: Sandbox never against the production database, real
// (production) Plaid only in the production deployment. See BANK-SYNC.md.
//
// Fingerprints are sha256 over the Neon endpoint id and the Blob store id,
// never the credentials themselves, so the list can live in a public repo.
// Relative imports only: next.config.ts loads this before path aliases exist.
import { createHash } from 'node:crypto';
import { PRODUCTION_FINGERPRINTS } from './production-fingerprints';

export type GuardEnv = Readonly<Record<string, string | undefined>>;

export type Fingerprints = {
  databaseEndpoints: readonly string[];
  blobStores: readonly string[];
  plaidSecrets: readonly string[];
};

// Neon hosts look like ep-name-1234abcd[-pooler].region.aws.neon.tech; the
// pooled and direct hosts share the endpoint id. Non-Neon hosts (localhost)
// fall back to the whole hostname.
export function databaseEndpointId(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.split('.')[0].replace(/-pooler$/, '');
  } catch {
    return null;
  }
}

// Read-write tokens are vercel_blob_rw_<storeId>_<secret>.
export function blobStoreId(token: string | undefined): string | null {
  const m = token?.match(/^vercel_blob_rw_([A-Za-z0-9]+)_/);
  return m ? m[1].toLowerCase() : null;
}

export function fingerprint(id: string): string {
  return createHash('sha256').update(id).digest('hex');
}

const DEMO_PROJECT_URL = /^tally-demo([.-]|$)/;

export function isDemoDeployment(env: GuardEnv): boolean {
  return (
    env.DEMO_MODE === '1' ||
    DEMO_PROJECT_URL.test(env.VERCEL_PROJECT_PRODUCTION_URL ?? '')
  );
}

// BLOB_STORE_ID is "store_<id>"; @vercel/blob prefers it (with an OIDC token)
// over the read-write token, so it identifies the store just as well.
export function blobStoreIdFromEnv(storeId: string | undefined): string | null {
  const id = storeId?.trim().replace(/^store_/i, '').toLowerCase();
  return id ? id : null;
}

// Whether a connection string is production's database, by fingerprint.
// Used by one-off scripts that must ask before writing there
// (db/auth-reset.ts).
export function isProductionDatabaseUrl(url: string | undefined, production: Fingerprints = PRODUCTION_FINGERPRINTS): boolean {
  return isProductionDatabase({ DATABASE_URL: url }, production);
}

function isProductionDatabase(env: GuardEnv, production: Fingerprints): boolean {
  const endpoint = databaseEndpointId(env.DATABASE_URL);
  return endpoint !== null && production.databaseEndpoints.includes(fingerprint(endpoint));
}

// Which production Blob credentials the environment holds, by variable name.
function productionBlobVars(env: GuardEnv, production: Fingerprints): string[] {
  const vars: string[] = [];
  const token = blobStoreId(env.BLOB_READ_WRITE_TOKEN);
  if (token && production.blobStores.includes(fingerprint(token))) {
    vars.push('BLOB_READ_WRITE_TOKEN');
  }
  const storeId = blobStoreIdFromEnv(env.BLOB_STORE_ID);
  if (storeId && production.blobStores.includes(fingerprint(storeId))) {
    vars.push('BLOB_STORE_ID');
  }
  return vars;
}

function demoProblems(env: GuardEnv, production: Fingerprints): string[] {
  if (!isDemoDeployment(env)) return [];
  const problems: string[] = [];
  if (env.DEMO_MODE !== '1') {
    problems.push(
      'This is the tally-demo project but DEMO_MODE is not "1"; set it so demo safeguards apply.',
    );
  }
  if (isProductionDatabase(env, production)) {
    problems.push('DATABASE_URL points at the production database.');
  }
  for (const name of productionBlobVars(env, production)) {
    problems.push(`${name} belongs to the production Blob store.`);
  }
  if (env.GEMINI_API_KEY) {
    problems.push(
      'GEMINI_API_KEY is set; the demo stubs receipt extraction and must not hold a key.',
    );
  }
  // The demo's bank rows come from the synthetic provider, which needs no
  // credentials; any Plaid variable or token key here is a misconfiguration.
  const bankVars = Object.keys(env).filter(
    (name) => (name.startsWith('PLAID_') || name === 'BANK_TOKEN_KEY') && env[name],
  );
  if (bankVars.length > 0) {
    problems.push(
      `${bankVars.sort().join(', ')} set; the demo uses the synthetic bank provider and must hold no bank credentials.`,
    );
  }
  return problems;
}

// `next dev` never touches a production store. .env.development.local
// overrides .env.local (which is production) key by key, and a key it omits
// falls through, so a gap in that file would otherwise write to production.
function devProblems(env: GuardEnv, production: Fingerprints): string[] {
  if (env.NODE_ENV !== 'development') return [];
  const problems: string[] = [];
  if (isProductionDatabase(env, production)) {
    problems.push(
      'DATABASE_URL points at the production database under next dev; set the dev branch in .env.development.local.',
    );
  }
  for (const name of productionBlobVars(env, production)) {
    problems.push(
      `${name} belongs to the production Blob store under next dev; override it in .env.development.local.`,
    );
  }
  return problems;
}

// Sandbox rows never reach the real ledger, and real Items are only ever
// created by the production deployment (the Trial's Item budget is finite;
// see CLAUDE.md).
function plaidProblems(env: GuardEnv, production: Fingerprints): string[] {
  // The production secret is recognized by value, not by the PLAID_ENV label
  // beside it: it once sat in a local env file marked sandbox. Wherever it
  // appears outside the production deployment, that is the problem.
  const secret = env.PLAID_SECRET?.trim();
  if (
    secret &&
    production.plaidSecrets.includes(fingerprint(secret)) &&
    (env.PLAID_ENV !== 'production' || env.VERCEL_ENV !== 'production')
  ) {
    return [
      'PLAID_SECRET is the production Plaid secret; only the production deployment may hold it.',
    ];
  }
  const plaidEnv = env.PLAID_ENV;
  if (!plaidEnv) return [];
  if (plaidEnv === 'sandbox') {
    return isProductionDatabase(env, production)
      ? ['PLAID_ENV=sandbox against the production database; Sandbox rows must never reach the real ledger.']
      : [];
  }
  if (plaidEnv === 'production') {
    const problems: string[] = [];
    if (!isProductionDatabase(env, production)) {
      problems.push('PLAID_ENV=production but DATABASE_URL is not the production database.');
    }
    if (env.VERCEL_ENV !== 'production') {
      problems.push(
        'PLAID_ENV=production outside the production deployment; real Items are created only there.',
      );
    }
    return problems;
  }
  return [`PLAID_ENV must be "sandbox" or "production", not ${JSON.stringify(plaidEnv)}.`];
}

// Every problem with this environment, empty when it is safe to boot.
export function environmentProblems(
  env: GuardEnv,
  production: Fingerprints = PRODUCTION_FINGERPRINTS,
): string[] {
  return [
    ...demoProblems(env, production),
    ...devProblems(env, production),
    ...plaidProblems(env, production),
  ];
}

export function assertSafeEnvironment(env: GuardEnv, where: string): void {
  const problems = environmentProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to ${where}: deployment guard failed.\n- ${problems.join('\n- ')}`,
    );
  }
}
