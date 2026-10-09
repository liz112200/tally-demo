# Phase 4+ candidates

Out of scope for phase 3, captured here so they are neither lost nor built
early.

- **LLM fallback for unmatched merchants.** When no rule matches, fall back to
  an LLM to suggest a category (fork 6 deferred this to a phase 3.5). Rules
  stay the fast, deterministic first pass; the LLM only fills gaps.
- **Personal / not-splittable filter.** Rent, payroll, Zelle transfers, and
  card-to-card payments import as ordinary uncategorized rows today. A flag or
  filter to exclude them from the split and category views is deferred (also
  noted in PHASE3.md).
- **Rule management extras.** Import/export of rule sets, per-rule hit counts,
  and match statistics.
- **Test a rule before saving.** A preview that runs a draft pattern against
  arbitrary text (or existing merchants) so the user sees what it would match
  before committing it.
- **Category hierarchy.** Categories are a flat list in v1; sub-categories are
  deferred.
- **Bulk category editing.** Selecting many transactions and setting a category
  in one action.

Surfaced while building phase 3:

- **Regex safety on user-entered rules.** A rule's regex runs with the `i`
  flag directly during import and retroactive apply. There is no timeout or
  ReDoS guard, so a pathological user-entered pattern could hang a large
  import. Consider a match timeout or a safe-regex check when rule volume or
  input size grows.
- **Re-normalization on normalize.ts changes.** `merchant_normalized` is
  computed once at insert. If the normalization regex set changes later,
  existing rows keep their old normalized string until a backfill re-runs it
  (and rules should then be re-applied). Worth a small maintenance script when
  normalization is next revised.
