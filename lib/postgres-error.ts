// The Postgres error code behind an error, if any (e.g. '23505' unique
// violation, '23514' check violation). Drizzle wraps driver errors: the
// wrapper's message is the failed SQL with its parameters, and the code sits
// on its `cause`, so checking `err.code` alone never matches. Pure; walks a
// short cause chain.
export function postgresCode(err: unknown): string | null {
  let e: unknown = err;
  for (let depth = 0; e !== null && typeof e === 'object' && depth < 5; depth++) {
    if ('code' in e && typeof e.code === 'string') return e.code;
    e = 'cause' in e ? e.cause : null;
  }
  return null;
}

// Whether an error is Drizzle's query wrapper, whose message is the failed
// SQL with its parameters and so is never shown or logged, whatever its
// cause. Recognised by shape: lib/ does not depend on Drizzle.
export function isWrappedQueryError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.startsWith('Failed query:') || ('query' in err && 'params' in err);
}
