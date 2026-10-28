import { describe, expect, it } from 'vitest';
import { actionErrorLogLine, describeActionError, SOMETHING_WENT_WRONG } from './action-result';

// Drizzle wraps a driver error: its own message is the SQL with parameters.
const wrapped = (driver: Error) =>
  new Error('Failed query: delete from "persons" where "id" = $1 params: 6b1f-secret-id', { cause: driver });
const driver = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('describeActionError', () => {
  it("passes our own triggers' refusals through, as a sentence", () => {
    const err = wrapped(
      driver('P0001', 'category "Transfers" is not counted as spending and still has transactions; recategorize them before deleting it'),
    );
    expect(describeActionError(err)).toBe(
      'Category "Transfers" is not counted as spending and still has transactions; recategorize them before deleting it.',
    );
  });

  it('says a constraint refused the change, and a conflict got there first', () => {
    expect(describeActionError(wrapped(driver('23514', 'violates check constraint "x"')))).toBe(
      'The database refused the change; nothing was saved.',
    );
    expect(describeActionError(wrapped(driver('23505', 'duplicate key')))).toBe('The database refused the change; nothing was saved.');
    expect(describeActionError(wrapped(driver('40001', 'could not serialize')))).toBe(
      'Another change got there first; nothing was saved. Try again.',
    );
  });

  it('never shows the failed SQL or its parameters, whatever the error', () => {
    for (const err of [
      wrapped(driver('23514', 'check')),
      wrapped(driver('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432')),
      wrapped(new Error('no code')),
      new Error('plain'),
      'a string',
    ]) {
      const shown = describeActionError(err);
      expect(shown).not.toMatch(/Failed query|params|secret|delete from/);
    }
    expect(describeActionError(new Error('plain'))).toBe(SOMETHING_WENT_WRONG);
    expect(describeActionError(wrapped(driver('ECONNREFUSED', 'connect ECONNREFUSED')))).toBe(SOMETHING_WENT_WRONG);
  });
});

describe('actionErrorLogLine', () => {
  it('logs the code of a database or driver error, never the wrapped SQL', () => {
    expect(actionErrorLogLine('deletePerson', wrapped(driver('23503', 'fk')))).toBe('deletePerson: database error 23503');
    expect(actionErrorLogLine('deletePerson', wrapped(driver('ECONNREFUSED', 'connect')))).toBe(
      'deletePerson: driver error ECONNREFUSED',
    );
    expect(actionErrorLogLine('deletePerson', new Error('Invalid id'))).toBe('deletePerson: Invalid id');
    expect(actionErrorLogLine('deletePerson', wrapped(new Error('no code')))).toBe(
      'deletePerson: query failed without a database code',
    );
  });
});
