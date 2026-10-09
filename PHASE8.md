# Phase 8 candidates

Deferred work, captured here so it is neither lost nor built early. (This
file was PHASE7.md; the phase 7 batch shipped import grouping, bulk
operations, inline field editing, and /insights, and rolled the rest
forward.)

## Rolled forward from earlier phases

- **Orphan receipts.** A receipt must belong to a transaction; standalone
  receipt capture (snap now, match to a bank row later) is deferred.
- **PDF and HEIC receipts.** JPG/PNG only in v1; iPhone captures need
  HEIC→JPG conversion before upload.
- **Batch upload** and a **receipt gallery / search view**.
- **Re-extract an existing receipt.** The retry affordance exists only in
  the moment of a failed upload; re-running extraction on a stored image
  (e.g. after a prompt improvement) is deferred.
- **OCR-only fallback** if the LLM refuses an image outright.
- **Merchant-name normalization across receipts and imports** (e.g. tie
  `RIVERTON ASIAN MARKET` on the receipt to a future bank row).
- **Per-item confidence scores** and multi-page receipts.
- **Editing a receipt after an item split exists** replaces the items and
  cascades the assignments away, but the split's stored shares are not
  re-derived until the user re-saves assignments. A "receipt edited since
  split saved" hint would close the gap.
- **Blob orphan on interrupted flows.** Failed extractions delete their
  blob best-effort; a crash between put() and the cleanup could leak one.
  A periodic list-and-sweep against receipts.blob_url would tidy it.
- **Free-tier data-training caveat** (lib/receipt/extract.ts): free-tier
  prompts may be used for model training. Fine for the owner's personal
  receipts; must be revisited before any multi-user mode.
- **Deleted-transaction visibility.** A "show deleted" toggle (or a trash
  view) would make the soft-delete state inspectable without SQL.
- **Saved filter presets.** Filters live in the URL, so bookmarks work,
  but there is no in-app way to name and recall a view.
- **Keyboard navigation for row expansion.** Rows toggle with Enter/Space
  when focused, but arrow-key traversal of the table is deferred.

## Deferred from phase 7

- **Restore-from-trash UI.** Soft delete now covers single rows, bulk
  selections, and whole imports ("undo import"), all restorable in
  principle — but there is still no restore UI, and no hard delete with
  blob cleanup.
- **Undone imports orphan their receipts' blobs.** Undoing an import
  soft-deletes its transactions; any receipts on them stay in the
  database and in Blob storage, invisible until a restore or hard-delete
  path exists. Acceptable for now; flagged so the eventual hard delete
  remembers to sweep blobs.
- **Custom date ranges on /insights.** The dashboard shows fixed
  calendar-month views with prev/next navigation (?month=YYYY-MM); free
  date ranges, comparisons, and year views are deferred.
- **Budgets / spend targets** per category or overall.
- **Editing source or category via the inline detail form.** Both already
  have their own affordances (source is import-defined; category has the
  inline select); folding them into the edit form was deliberately
  skipped.
- **CSV export.**
- **Keyboard shortcuts** for bulk selection (shift-click ranges,
  select-all hotkey) beyond the Escape-to-clear that shipped.
- **Plaid auto-refresh.**
- **Recurring-charge detection.**
- **Debt simplification** (minimum-transaction settlement paths).
- **Multi-currency.**

## Surfaced while building phase 7

- **Backfilled import ordering ties.** The three synthetic imports share
  one imported_at (the migration timestamp), so their relative order in
  the grouped view is arbitrary but stable. Real imports sort above them
  correctly; not worth a tiebreaker until it bothers someone.
- **Category filter selects keep their options mounted while closed**
  (the phase-6 keep-mounted dialog fix applies to selects too), so DOM
  queries for "visible options" must check visibility — relevant to any
  future UI test harness.
- **Insights palette is the phase-3 category palette.** Bar colors reuse
  the eight --cat-* hues for consistency with the tags. Identity is
  always carried by the row label, never color alone; the palette's
  adjacent-hue pairs have not been run through a CVD validator, which a
  future accessibility pass could tighten.
