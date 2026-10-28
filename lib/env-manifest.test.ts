// The environment manifest (lib/env-manifest.ts), enforced structurally: every
// variable the source reads is classified there, and nothing is listed that
// nothing reads. The source is read from the filesystem, like the auth and
// action conventions, so the list cannot drift from the code.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENV_VARS, missingEnvironment } from './env-manifest';

const root = process.cwd();
const ROOTS = ['app', 'lib', 'db', 'scripts', 'proxy.ts', 'next.config.ts', 'vercel.ts', 'drizzle.config.ts'];

function sources(path: string): string[] {
  const full = join(root, path);
  if (statSync(full).isFile()) return [path];
  return readdirSync(full, { withFileTypes: true }).flatMap((e) => {
    const child = join(path, e.name);
    if (e.isDirectory()) return child === join('db', 'test') ? [] : sources(child);
    return /\.(ts|tsx|mjs)$/.test(e.name) && !/\.(test|dbtest)\.ts$/.test(e.name) ? [child] : [];
  });
}

// process.env.NAME, env.NAME (an env object passed in), env['NAME'].
const READ = /\benv(?:\.([A-Z][A-Z0-9_]+)|\[['"]([A-Z][A-Z0-9_]+)['"]\])/g;

function readsByName(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const file of ROOTS.flatMap(sources)) {
    for (const m of readFileSync(join(root, file), 'utf8').matchAll(READ)) {
      const name = m[1] ?? m[2];
      out.set(name, [...new Set([...(out.get(name) ?? []), file])]);
    }
  }
  return out;
}

describe('Environment variables', () => {
  const reads = readsByName();

  it('are found (the test reads the right files)', () => {
    expect(reads.get('DATABASE_URL')).toContain('db/index.ts');
    expect(reads.size).toBeGreaterThan(15);
  });

  it('every one the code reads is classified in lib/env-manifest.ts', () => {
    const unlisted = [...reads.keys()].filter((name) => !(name in ENV_VARS)).map((name) => `${name} (${reads.get(name)!.join(', ')})`);
    expect(unlisted).toEqual([]);
  });

  it('every one listed is read somewhere', () => {
    expect(Object.keys(ENV_VARS).filter((name) => !reads.has(name))).toEqual([]);
  });
});

describe('missingEnvironment', () => {
  const app = {
    VERCEL_ENV: 'production',
    VERCEL_PROJECT_PRODUCTION_URL: 'example.vercel.app',
    DATABASE_URL: 'postgres://x',
    BLOB_STORE_ID: 'store_x',
    GEMINI_API_KEY: 'k',
    AUTH_BOOTSTRAP_TOKEN: 't',
    NEXT_PUBLIC_SHARE_BASE_URL: 'https://share.example',
    BANK_TOKEN_KEY: 'k',
    PLAID_CLIENT_ID: 'c',
    PLAID_SECRET: 's',
    PLAID_ENV: 'production',
    PLAID_REDIRECT_URI: 'https://example.vercel.app/accounts/oauth',
  };
  const demo = {
    VERCEL_ENV: 'production',
    VERCEL_PROJECT_PRODUCTION_URL: 'tally-demo.vercel.app',
    DEMO_MODE: '1',
    DATABASE_URL: 'postgres://y',
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_y',
    CRON_SECRET: 'c',
  };

  it('passes a complete app and a complete demo', () => {
    expect(missingEnvironment(app)).toEqual([]);
    expect(missingEnvironment(demo)).toEqual([]);
  });

  it('names a missing variable, and an empty one counts as missing', () => {
    expect(missingEnvironment({ ...app, PLAID_REDIRECT_URI: undefined })).toEqual([
      'PLAID_REDIRECT_URI is not set (OAuth institutions; Plaid is sent a redirect URI only when this is set, whatever the dashboard allows).',
    ]);
    expect(missingEnvironment({ ...app, AUTH_BOOTSTRAP_TOKEN: ' ' })).toHaveLength(1);
    expect(missingEnvironment({ ...demo, CRON_SECRET: undefined })).toEqual(["CRON_SECRET is not set (authorizes Vercel Cron's requests)."]);
  });

  it('accepts either Blob variable on the app, and requires one', () => {
    expect(missingEnvironment({ ...app, BLOB_STORE_ID: undefined, BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' })).toEqual([]);
    expect(missingEnvironment({ ...app, BLOB_STORE_ID: undefined })).toEqual([
      'None of BLOB_STORE_ID, BLOB_READ_WRITE_TOKEN is set (receipt images: @vercel/blob uses BLOB_STORE_ID with OIDC, else the token).',
    ]);
  });

  it('holds the demo to the demo list, not the app list', () => {
    expect(missingEnvironment(demo).join(' ')).not.toMatch(/PLAID|GEMINI|BANK_TOKEN_KEY/);
  });

  it('checks nothing outside a production deployment', () => {
    expect(missingEnvironment({ VERCEL_ENV: 'preview' })).toEqual([]);
    expect(missingEnvironment({})).toEqual([]);
  });
});
