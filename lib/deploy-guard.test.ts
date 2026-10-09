import { describe, it, expect } from 'vitest';
import {
  blobStoreId,
  databaseEndpointId,
  environmentProblems,
  fingerprint,
  isDemoDeployment,
} from './deploy-guard';

const PROD_DB = 'postgres://u:p@ep-prod-name-11111111-pooler.us-east-2.aws.neon.tech/neondb';
const PROD_BLOB = 'vercel_blob_rw_ProdStore123_secretpart';
const DEMO_DB = 'postgres://u:p@ep-demo-name-22222222-pooler.us-east-2.aws.neon.tech/neondb';
const DEMO_BLOB = 'vercel_blob_rw_DemoStore456_secretpart';

const production = {
  databaseEndpoints: [fingerprint('ep-prod-name-11111111')],
  blobStores: [fingerprint('prodstore123')],
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
