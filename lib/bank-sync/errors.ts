// How bank-sync failures are shown and logged. Pure. A message shown to the
// owner is Plaid's own user-facing text when it gives one, otherwise the
// error code; never a request body or a token, and never a database error's
// message, which is the failed SQL with its parameters (one of which can be a
// sealed token).
import { isWrappedQueryError, postgresCode } from '../postgres-error';
import { PlaidApiError } from './plaid/client';
import { classifyItemError } from './item-health';

export function describeSyncError(err: unknown): string {
  if (err instanceof PlaidApiError) {
    return err.displayMessage ?? `The bank provider returned ${err.errorCode}.`;
  }
  if (postgresCode(err) !== null) return 'The database refused the change.';
  if (isWrappedQueryError(err)) return 'Something went wrong.';
  return err instanceof Error ? err.message : 'Something went wrong.';
}

// The log line for a failure: Plaid's type, code and request id; for a
// database error the code only (a wrapped message carries the parameters).
export function syncErrorLogLine(where: string, err: unknown): string {
  if (err instanceof PlaidApiError) {
    return `${where}: ${err.errorType}/${err.errorCode} (request ${err.requestId ?? 'n/a'})`;
  }
  if (postgresCode(err) !== null) return `${where}: database error ${postgresCode(err)}`;
  if (isWrappedQueryError(err)) return `${where}: query failed without a database code`;
  return `${where}: ${err instanceof Error ? err.message : String(err)}`;
}

// The error code when a failure belongs to the whole login rather than one
// account: an Item or institution error the health classifier knows. Every
// other account of the login would fail the same way, so the sync records it
// on the connection and stops. Codes it does not know (PRODUCT_NOT_READY and
// the like) stay with the account, as before.
export function connectionErrorCode(err: unknown): string | null {
  if (!(err instanceof PlaidApiError)) return null;
  if (err.errorType !== 'ITEM_ERROR' && err.errorType !== 'INSTITUTION_ERROR') return null;
  const kind = classifyItemError(err.errorCode);
  return kind === 'healthy' || kind === 'unknown' ? null : err.errorCode;
}

// The provider's error code for a failure, whatever its type; null for a
// failure that did not come from the provider.
export function providerErrorCode(err: unknown): string | null {
  return err instanceof PlaidApiError ? err.errorCode : null;
}
