// What every Server Action returns, and how a failure is said and logged
// (ACTION-RESULTS.md). Pure.
//
// An action reports success in plain words (`message`), partial success as a
// `warning`, and failure as `error`; `details` are lines listed under the
// message, one per item. No action returns nothing: a caller that cannot
// tell success from failure cannot tell the owner either.
import { isWrappedQueryError, postgresCode } from './postgres-error';

export type ActionResult =
  | { ok: true; message?: string; warning?: string; details?: string[] }
  | { error: string };

// A SQLSTATE is five digits or capitals. A connection failure carries a
// Node code such as ECONNREFUSED on the same field; that is not one.
function sqlState(err: unknown): string | null {
  const code = postgresCode(err);
  return code !== null && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

// The driver error inside Drizzle's wrapper, whose own message is the failed
// SQL with its parameters and is never shown or logged.
function driverError(err: unknown): { message?: unknown } | null {
  let e: unknown = err;
  for (let depth = 0; e !== null && typeof e === 'object' && depth < 5; depth++) {
    if ('code' in e && typeof e.code === 'string') return e as { message?: unknown };
    e = 'cause' in e ? e.cause : null;
  }
  return null;
}

export const SOMETHING_WENT_WRONG = 'Something went wrong. Reload to see what was saved.';

// The sentence the owner sees for a failure.
//  - P0001 is a RAISE in one of our own triggers, whose text is written for
//    the owner (migrations 0019, 0021), so it is shown as is.
//  - A constraint violation is the database refusing the change.
//  - A serialization failure or deadlock is another change getting there
//    first.
//  - Anything else is not explained, because it cannot be honestly: the
//    owner is pointed at the current state instead.
export function describeActionError(err: unknown): string {
  const code = sqlState(err);
  if (code === 'P0001') {
    const text = driverError(err)?.message;
    return typeof text === 'string' && text.length > 0 ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : SOMETHING_WENT_WRONG;
  }
  if (code !== null && code.startsWith('23')) return 'The database refused the change; nothing was saved.';
  if (code === '40001' || code === '40P01') return 'Another change got there first; nothing was saved. Try again.';
  return SOMETHING_WENT_WRONG;
}

// The log line for a failure: the SQLSTATE for a database error, never its
// message (the failed SQL and its parameters); otherwise the error's message.
export function actionErrorLogLine(where: string, err: unknown): string {
  const code = sqlState(err);
  if (code !== null) return `${where}: database error ${code}`;
  if (driverError(err) !== null) return `${where}: driver error ${postgresCode(err) ?? 'unknown'}`;
  if (isWrappedQueryError(err)) return `${where}: query failed without a database code`;
  return `${where}: ${err instanceof Error ? err.message : String(err)}`;
}
