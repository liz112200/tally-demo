# Action results

Every Server Action tells the owner what it did, and every failure is shown.
Before this slice, twelve actions returned nothing: their callers could not
tell success from failure, and `ConfirmDialog` closed either way. A refusal
by the database (slices 3 and 4 added CHECKs and triggers that refuse
legitimately) reached the error boundary or did nothing visible. On splits
and settlements that can leave balances other than what the owner believes.

## The convention (CLAUDE.md, Architecture)

- Every exported Server Action returns an `ActionResult`
  (`lib/action-result.ts`):
  `{ ok: true; message?: string; warning?: string; details?: string[] } | { error: string }`,
  or a form state that carries `message` on success. No action returns
  nothing.
- A change that matched nothing (already deleted, deleted from another tab,
  wrong id) is an error. Query functions return what they changed so the
  action can tell; none reports success for a change that did not happen.
- Every caller shows the result where it outlives the control that ran it
  (the lesson of the Reconnect message on /accounts).
- `ConfirmDialog` stays open on an error and shows it in the dialog; on
  success it closes and the page result line says what was done.
- A count of ledger rows says "row" everywhere: the page header, the
  summary strip, group headers, confirmations and results. "Transaction"
  names one item ("Delete this transaction?"), never a count. A dialog that
  said "Delete 5 transactions" beside a group of "5 rows" read as two
  different numbers. `lib/action-convention.test.ts` fails on a count that
  says "transaction".

## How it is enforced

- **`lib/action-convention.test.ts`** reads every `'use server'` file in
  `app/_actions/` with the TypeScript compiler API and fails if an exported
  function declares no return type or returns `void`/`undefined`. It found
  three void actions the manual sweep missed (`setImportHidden`,
  `showAllImports`, `removeReceipt`).
- **Types at the call site.** `ConfirmDialog`'s `onConfirm` is typed
  `() => Promise<ActionResult>`, and React types a `<form action>` as
  returning nothing, so a result-returning action passed straight to a form
  no longer compiles. Both caught callers the sweep had not listed (the two
  "Remove split" forms in the split editor).

## The helpers

- **`attempt(where, body)`** (`app/_actions/attempt.ts`, server-only, not a
  Server Action) runs an action's body and turns a throw into `{ error }`:
  - SQLSTATE `P0001` (a RAISE in our own triggers, migrations 0019 and
    0021): its message, as a sentence;
  - a constraint violation (`23…`): "The database refused the change;
    nothing was saved.";
  - a serialization failure or deadlock: "Another change got there first;
    nothing was saved. Try again.";
  - anything else: "Something went wrong. Reload to see what was saved."
  It logs the SQLSTATE or the driver code, never the error's message.
  Drizzle's wrapper message is the failed SQL with its parameters; it is
  recognised by shape (`isWrappedQueryError`, lib/postgres-error.ts) and
  never shown or logged, even when its cause carries no code. The same gap
  in bank sync's error text (`describeSyncError`, `syncErrorLogLine`) is
  closed with the same check.
- **`PageResultProvider`** (`app/_components/page-result.tsx`), in
  `app/template.tsx`: one result line per page, fixed above the bottom of
  the viewport (above the Expenses bulk-action bar), replaced by the next
  result, dismissable. Next mounts a template afresh on every navigation, so
  the line belongs to one visit to one page and leaving discards it. It was
  first in the root layout, which never unmounts, cleared by an effect on
  the pathname; the owner saw a result from Expenses still showing on
  /people. That was not reproduced (every client navigation tried in
  Chromium cleared it, including a result arriving after the page was left),
  so the fix is structural rather than aimed at a known cause.
- **`useAction()`** runs an action, reports its result to the page line,
  and returns it to the caller; with `errorsInPlace` an error stays with the
  caller instead (a dialog that stays open). A request that fails without an
  answer is reported as "Something went wrong. Reload to see what was
  saved.", since the action may or may not have run.
- **`useReportSuccess(state)`** does the same for a `useActionState` form:
  its `message` goes to the page line once per submission; field errors stay
  in the form.
- **`InlineAction`** (`app/_components/inline-action.tsx`): a destructive
  button inside an open dialog (Remove split, Remove receipt); error beside
  it, success on the page line and the dialog closes.
- **/accounts opts out of the page line.** Each login there has its own
  result slot (`login-result.tsx`), and its controls never report to the
  page line, so a result never shows in two places; the page line is
  discarded on navigation, so one from another page is never left beside
  them.

## The actions

| Action | Success says | Refused / no match says |
|---|---|---|
| `deletePerson` | "Alex deleted. Their history stays; they no longer appear in new splits or settlements." | not found or already deleted (the owner included) |
| `hardDeletePerson` | "Alex erased, with N settlements." | not found or not deleted first |
| `deleteRule` | "Rule UBER deleted. Rows it categorized keep their category." | not found |
| `deleteSettlement` | "Payment of $X deleted[, with its offset]. What it paid is outstanding again." | not found |
| `deleteExternalExpense` | "Expense deleted. Any payment applied to it is credit again." | not found |
| `removeSplit` | "Split removed; the charge is all yours.[ N payment allocations on it went back to credit.]" | no split on the row |
| `deleteTransaction` | "Transaction deleted." | not found or already deleted |
| `bulkDeleteTransactions` | "N transactions deleted." (warning when some were already deleted) | none matched |
| `undoImport` | "Import undone: N rows deleted. Restore brings them back." | already undone |
| `restoreImport` | "Restored N rows." | not undone |
| `removeReceipt` | "Receipt removed[, and the item split made from it…]." | no receipt on the row |
| `setImportHidden`, `showAllImports` | nothing (the group moving is the confirmation) | not found |

Saves that closed a dialog or cleared a form in silence now say what they
saved: a split, an item split, a payment (inline and picker), an expense you
paid, a new person, rule or transaction. A rule says, beside Save and after
it, "Applies to new rows; existing rows change when you apply rules."

## Found on the way

- **Undo membership is recorded** (migration 0025). Restore found an
  import's rows as those whose `deleted_at` equalled the import's; that
  failed once by losing microseconds through a JS Date and would have failed
  again after a second Undo, which re-stamped the import so nothing matched.
  The rows an Undo deletes are now marked `deleted_by_undo` (a CHECK keeps
  the mark on deleted import rows only); Restore and the restorable count
  read the mark. The migration's backfill makes the old inference once more,
  inside Postgres where the timestamps compare exactly. A second Undo, a
  second Restore, and deleting an already deleted row or person now change
  nothing.
- **Removing a receipt left the wizard on its review.** It adopted a
  receipt from the refreshed page only when one was present; it now closes
  on success.
- **Restore** ran on a plain click with no pending state; it has one now.

## Failure paths

- An action that throws past `attempt` (a bug), or a request with no
  answer: the caller shows "Something went wrong. Reload to see what was
  saved."
- A result for a page that has changed (a delete on a row another tab
  already deleted): the "no match" errors above.
- Navigation while an action is pending: the result is dropped with the
  page it belonged to; the next page shows the true state.

## Tests

- Unit: the error mapping and log line (lib/action-result.test.ts), the
  wrapper check in both places (lib/postgres-error.test.ts), the
  convention test.
- Database (db/action-results.dbtest.ts): every action above on success, on
  no match and on a second call; undo twice, restore, and a second round; a
  row marked `deleted_by_undo` that is not deleted refused by the CHECK; our
  trigger's refusal shown as written and logged as its code; a NOT NULL
  violation shown without its SQL. Breaking the Undo guard on purpose fails
  exactly the undo test.
- Not covered by an automated test: the client components (no component
  test setup). The browser checklist covers them.

## Out of scope

- Actions that already returned a result keep their shapes.
- Toasts that fade, undo-after-delete, and optimistic updates.
