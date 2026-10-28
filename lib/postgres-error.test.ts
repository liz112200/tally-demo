import { describe, it, expect } from 'vitest';
import { isWrappedQueryError, postgresCode } from './postgres-error';
import { describeSyncError, syncErrorLogLine } from './bank-sync/errors';

describe('postgresCode', () => {
  it('reads the code from a driver error', () => {
    expect(postgresCode(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe('23505');
  });

  it('reads the code from the cause of a wrapped error (Drizzle)', () => {
    const driver = Object.assign(new Error('violates check constraint'), { code: '23514' });
    const wrapped = new Error('Failed query: update "bank_accounts" ... params: true,<id>', { cause: driver });
    expect(postgresCode(wrapped)).toBe('23514');
  });

  it('returns null for errors with no database code', () => {
    expect(postgresCode(new Error('plain'))).toBeNull();
    expect(postgresCode('a string')).toBeNull();
    expect(postgresCode(null)).toBeNull();
    expect(postgresCode({ code: 42 })).toBeNull();
  });
});

describe('isWrappedQueryError', () => {
  it("recognises Drizzle's wrapper by its message or its fields, with or without a coded cause", () => {
    expect(isWrappedQueryError(new Error('Failed query: select 1\nparams: '))).toBe(true);
    expect(isWrappedQueryError(Object.assign(new Error('x'), { query: 'select 1', params: [] }))).toBe(true);
    expect(isWrappedQueryError(new Error('Invalid id'))).toBe(false);
    expect(isWrappedQueryError('Failed query: a string')).toBe(false);
  });
});

describe('bank sync text for a wrapped error with no code', () => {
  it('neither shows nor logs the SQL and its parameters', () => {
    const err = new Error('Failed query: update "bank_connections" set "access_token_sealed" = $1\nparams: v1:sealed', {
      cause: new TypeError('boom'),
    });
    expect(describeSyncError(err)).toBe('Something went wrong.');
    expect(syncErrorLogLine('sync', err)).toBe('sync: query failed without a database code');
  });
});
