# Phase 2 candidates

Out of scope for phase 1, captured here so they are neither lost nor built
early.

- **Debit/credit sign convention.** v1 stores manual amounts exactly as
  typed (`parseDollars`), with no fixed meaning for the sign. When the
  phase 2 importer sets signs from bank statements, decide the canonical
  convention and normalize manual entry to match.
- **Optimistic UI for mutations.** v1 refreshes via `revalidatePath` after
  the Server Action resolves. Client-side optimistic updates were
  deliberately deferred.
- **Inline (pre-submit) form validation.** The add-transaction form
  validates in the Server Action and surfaces errors via `useActionState`,
  so feedback arrives after a submit round-trip. On-blur client validation
  is a later nicety.
