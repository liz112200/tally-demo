import { describe, it, expect } from 'vitest';
import {
  blobStoreId,
  blobStoreIdFromEnv,
  databaseEndpointId,
  environmentProblems,
  fingerprint,
  isDemoDeployment, isProductionDatabaseUrl } from './deploy-guard';

const PROD_DB = 'postgres://u:p@ep-prod-name-11111111-pooler.us-east-2.aws.neon.tech/neondb';
const PROD_BLOB = 'vercel_blob_rw_ProdStore123_secretpart';
const DEMO_DB = 'postgres://u:p@ep-demo-name-22222222-pooler.us-east-2.aws.neon.tech/neondb';
const DEMO_BLOB = 'vercel_blob_rw_DemoStore456_secretpart';

const PROD_PLAID_SECRET = '0123456789abcdef0123456789abcd';
const SANDBOX_PLAID_SECRET = 'fedcba9876543210fedcba98765432';

const production = {
  databaseEndpoints: [fingerprint('ep-prod-name-11111111')],
  blobStores: [fingerprint('prodstore123')],
  plaidSecrets: [fingerprint(PROD_PLAID_SECRET)],
};

describe('identifiers', () => {
  it('reads the same endpoint id from pooled and direct hosts', () => {
    expect(databaseEndpointId(PROD_DB)).toBe('ep-prod-name-11111111');
    expect(databaseEndpointId(PROD_DB.replace('-pooler', ''))).toBe('ep-prod-name-11111111');
    expect(databaseEndpointId('not a url')).toBeNull();
    expect(databaseEndpointId(undefined)).toBeNull();
  });

  it('reads the store id from a read-write token', () => {
    expect(blobStoreId(PROD_BLOB)).toBe('prodstore123');
    expect(blobStoreId('something-else')).toBeNull();
  });

  it('reads the store id from BLOB_STORE_ID with or without its prefix', () => {
    expect(blobStoreIdFromEnv('store_ProdStore123')).toBe('prodstore123');
    expect(blobStoreIdFromEnv('ProdStore123')).toBe('prodstore123');
    expect(blobStoreIdFromEnv('')).toBeNull();
    expect(blobStoreIdFromEnv(undefined)).toBeNull();
  });
});

describe('isDemoDeployment', () => {
  it('is a demo when DEMO_MODE is set or the project URL names tally-demo', () => {
    expect(isDemoDeployment({ DEMO_MODE: '1' })).toBe(true);
    expect(isDemoDeployment({ VERCEL_PROJECT_PRODUCTION_URL: 'tally-demo.vercel.app' })).toBe(true);
    expect(isDemoDeployment({ VERCEL_PROJECT_PRODUCTION_URL: 'tally-demo-abc.vercel.app' })).toBe(true);
    expect(isDemoDeployment({ VERCEL_PROJECT_PRODUCTION_URL: 'expense-splitter.vercel.app' })).toBe(false);
    expect(isDemoDeployment({})).toBe(false);
  });
});

describe('environmentProblems', () => {
  it('never blocks a non-demo deployment, even holding production credentials', () => {
    expect(
      environmentProblems(
        { DATABASE_URL: PROD_DB, BLOB_READ_WRITE_TOKEN: PROD_BLOB, GEMINI_API_KEY: 'k' },
        production,
      ),
    ).toEqual([]);
  });

  it('passes a demo deployment on demo credentials', () => {
    expect(
      environmentProblems(
        { DEMO_MODE: '1', DATABASE_URL: DEMO_DB, BLOB_READ_WRITE_TOKEN: DEMO_BLOB },
        production,
      ),
    ).toEqual([]);
  });

  it('blocks a demo deployment on the production database or Blob store', () => {
    const problems = environmentProblems(
      { DEMO_MODE: '1', DATABASE_URL: PROD_DB.replace('-pooler', ''), BLOB_READ_WRITE_TOKEN: PROD_BLOB },
      production,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/production database/);
    expect(problems[1]).toMatch(/production Blob store/);
  });

  it('fails closed when the tally-demo project forgot DEMO_MODE', () => {
    const problems = environmentProblems(
      { VERCEL_PROJECT_PRODUCTION_URL: 'tally-demo.vercel.app', DATABASE_URL: PROD_DB },
      production,
    );
    expect(problems.some((p) => /DEMO_MODE/.test(p))).toBe(true);
    expect(problems.some((p) => /production database/.test(p))).toBe(true);
  });

  it('blocks a demo deployment holding a Gemini key', () => {
    expect(
      environmentProblems({ DEMO_MODE: '1', GEMINI_API_KEY: 'k' }, production),
    ).toEqual([expect.stringMatching(/GEMINI_API_KEY/)]);
  });
});

describe('demo bank credentials', () => {
  it('blocks a demo deployment holding any Plaid variable or token key', () => {
    const problems = environmentProblems(
      { DEMO_MODE: '1', PLAID_CLIENT_ID: 'c', PLAID_SECRET: 's', BANK_TOKEN_KEY: 'k' },
      production,
    );
    expect(problems).toEqual([
      expect.stringMatching(/BANK_TOKEN_KEY, PLAID_CLIENT_ID, PLAID_SECRET set/),
    ]);
  });

  it('ignores a bank variable that is present but empty', () => {
    expect(environmentProblems({ DEMO_MODE: '1', PLAID_SECRET: '' }, production)).toEqual([]);
  });

  it('blocks a demo deployment whose BLOB_STORE_ID is production\'s', () => {
    expect(
      environmentProblems({ DEMO_MODE: '1', BLOB_STORE_ID: 'store_ProdStore123' }, production),
    ).toEqual([expect.stringMatching(/BLOB_STORE_ID belongs to the production Blob store/)]);
  });
});

describe('next dev', () => {
  const dev = { NODE_ENV: 'development' };

  it('passes on the dev branch and a dev Blob store', () => {
    expect(
      environmentProblems(
        { ...dev, DATABASE_URL: DEMO_DB, BLOB_READ_WRITE_TOKEN: DEMO_BLOB, BLOB_STORE_ID: '' },
        production,
      ),
    ).toEqual([]);
  });

  it('refuses every production store credential', () => {
    const problems = environmentProblems(
      {
        ...dev,
        DATABASE_URL: PROD_DB,
        BLOB_READ_WRITE_TOKEN: PROD_BLOB,
        BLOB_STORE_ID: 'store_prodstore123',
      },
      production,
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/production database under next dev/);
    expect(problems[1]).toMatch(/BLOB_READ_WRITE_TOKEN .* under next dev/);
    expect(problems[2]).toMatch(/BLOB_STORE_ID .* under next dev/);
  });

  it('does not apply to a production build or runtime', () => {
    expect(
      environmentProblems(
        { NODE_ENV: 'production', DATABASE_URL: PROD_DB, BLOB_READ_WRITE_TOKEN: PROD_BLOB },
        production,
      ),
    ).toEqual([]);
  });
});

describe('Plaid environments', () => {
  it('allows Sandbox against a non-production database', () => {
    expect(
      environmentProblems({ PLAID_ENV: 'sandbox', DATABASE_URL: DEMO_DB }, production),
    ).toEqual([]);
  });

  it('refuses Sandbox against the production database', () => {
    expect(
      environmentProblems({ PLAID_ENV: 'sandbox', DATABASE_URL: PROD_DB }, production),
    ).toEqual([expect.stringMatching(/Sandbox rows must never reach the real ledger/)]);
  });

  it('allows production Plaid only in the production deployment on the production database', () => {
    expect(
      environmentProblems(
        { PLAID_ENV: 'production', DATABASE_URL: PROD_DB, VERCEL_ENV: 'production' },
        production,
      ),
    ).toEqual([]);
  });

  it('refuses production Plaid from a laptop or a preview', () => {
    expect(
      environmentProblems({ PLAID_ENV: 'production', DATABASE_URL: PROD_DB }, production),
    ).toEqual([expect.stringMatching(/outside the production deployment/)]);
    expect(
      environmentProblems(
        { PLAID_ENV: 'production', DATABASE_URL: PROD_DB, VERCEL_ENV: 'preview' },
        production,
      ),
    ).toEqual([expect.stringMatching(/outside the production deployment/)]);
  });

  it('refuses production Plaid against any other database', () => {
    expect(
      environmentProblems(
        { PLAID_ENV: 'production', DATABASE_URL: DEMO_DB, VERCEL_ENV: 'production' },
        production,
      ),
    ).toEqual([expect.stringMatching(/not the production database/)]);
  });

  it('refuses an unknown PLAID_ENV', () => {
    expect(environmentProblems({ PLAID_ENV: 'development' }, production)).toEqual([
      expect.stringMatching(/must be "sandbox" or "production"/),
    ]);
  });
});

describe('the production Plaid secret', () => {
  it('is refused under a sandbox label, whatever the database', () => {
    for (const DATABASE_URL of [DEMO_DB, PROD_DB]) {
      expect(
        environmentProblems(
          { PLAID_ENV: 'sandbox', PLAID_SECRET: PROD_PLAID_SECRET, DATABASE_URL },
          production,
        ),
      ).toEqual([expect.stringMatching(/PLAID_SECRET is the production Plaid secret/)]);
    }
  });

  it('is refused with no PLAID_ENV at all, and outside the production deployment', () => {
    expect(environmentProblems({ PLAID_SECRET: PROD_PLAID_SECRET }, production)).toEqual([
      expect.stringMatching(/only the production deployment may hold it/),
    ]);
    expect(
      environmentProblems(
        { PLAID_ENV: 'production', PLAID_SECRET: PROD_PLAID_SECRET, DATABASE_URL: PROD_DB, VERCEL_ENV: 'preview' },
        production,
      ),
    ).toEqual([expect.stringMatching(/only the production deployment may hold it/)]);
  });

  it('is allowed in the production deployment on the production database', () => {
    expect(
      environmentProblems(
        {
          PLAID_ENV: 'production',
          PLAID_SECRET: PROD_PLAID_SECRET,
          DATABASE_URL: PROD_DB,
          VERCEL_ENV: 'production',
        },
        production,
      ),
    ).toEqual([]);
  });

  it('leaves any other secret to the PLAID_ENV rules', () => {
    expect(
      environmentProblems(
        { PLAID_ENV: 'sandbox', PLAID_SECRET: SANDBOX_PLAID_SECRET, DATABASE_URL: DEMO_DB },
        production,
      ),
    ).toEqual([]);
  });
});

describe('isProductionDatabaseUrl', () => {
  it("recognises production's database by fingerprint, and nothing else", () => {
    expect(isProductionDatabaseUrl(PROD_DB, production)).toBe(true);
    expect(isProductionDatabaseUrl(DEMO_DB, production)).toBe(false);
    expect(isProductionDatabaseUrl(undefined, production)).toBe(false);
    expect(isProductionDatabaseUrl('not a url', production)).toBe(false);
  });
});

