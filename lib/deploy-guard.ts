// Deployment guard for the public demo. Pure checks over an environment
// object; no network. The demo is a second Vercel project built from this
// same repository with deployment protection off, so the one failure that
// matters is a demo deployment holding production credentials. Two layers
// keep that from booting:
//
//   1. This module (synchronous, build and boot): a deployment that is a
//      demo — DEMO_MODE=1, or a production URL that names the tally-demo
//      project even if DEMO_MODE was forgotten — must not carry a database
//      endpoint or Blob store whose fingerprint is listed as production's,
//      must set DEMO_MODE explicitly, and must not hold a Gemini key.
//   2. db/demo-guard.ts (network, build and reset): the database and Blob
//      store must positively identify themselves as the demo's via markers
//      that only a fresh, empty store can receive. Production can never pass
//      this regardless of what the fingerprint list holds.
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

// Every problem with this environment, empty when it is safe to boot.
export function environmentProblems(
  env: GuardEnv,
  production: Fingerprints = PRODUCTION_FINGERPRINTS,
): string[] {
  if (!isDemoDeployment(env)) return [];
  const problems: string[] = [];
  if (env.DEMO_MODE !== '1') {
    problems.push(
      'This is the tally-demo project but DEMO_MODE is not "1"; set it so demo safeguards apply.',
    );
  }
  const endpoint = databaseEndpointId(env.DATABASE_URL);
  if (endpoint && production.databaseEndpoints.includes(fingerprint(endpoint))) {
    problems.push('DATABASE_URL points at the production database.');
  }
  const store = blobStoreId(env.BLOB_READ_WRITE_TOKEN);
  if (store && production.blobStores.includes(fingerprint(store))) {
    problems.push('BLOB_READ_WRITE_TOKEN belongs to the production Blob store.');
  }
  if (env.GEMINI_API_KEY) {
    problems.push(
      'GEMINI_API_KEY is set; the demo stubs receipt extraction and must not hold a key.',
    );
  }
  return problems;
}

export function assertSafeEnvironment(env: GuardEnv, where: string): void {
  const problems = environmentProblems(env);
  if (problems.length > 0) {
    throw new Error(
      `Refusing to ${where}: demo deployment guard failed.\n- ${problems.join('\n- ')}`,
    );
  }
}
