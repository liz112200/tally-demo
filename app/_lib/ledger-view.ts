import 'server-only';
import {
  getTransactions,
  getCategories,
  getPersons,
  getSplits,
  getReceipts,
  getImports,
  getDeletedImports,
  getLinkedAccountGroups,
  getReplacementCandidates,
  getSettlements,
  getImportSkipGroups,
  pointedOut,
  type ReceiptView,
  type ReplacementCandidate,
} from '@/db/queries';
import { getLedgerTabs } from '@/db/statement-cycles';
import { conversionChecks } from '@/db/alongside';
import { latestRaisedReviews, latestStatementReviews } from '@/db/reviews';
import type { SplitSummary } from '@/app/_components/split-editor';

// Everything the transaction table needs, loaded once, for Expenses and for
// an account's page alike: the same rows, splits, receipts and imports, so
// the two can never disagree about a row.
export async function loadLedgerView() {
  const [transactions, categories, persons, splits, receipts, imports, deletedImports, linkedAccounts, ledgers, importSkips] =
    await Promise.all([
      getTransactions(),
      getCategories(),
      getPersons(),
      getSplits(),
      getReceipts(),
      getImports(),
      getDeletedImports(),
      getLinkedAccountGroups(),
      getLedgerTabs(),
      getImportSkipGroups(),
    ]);
  // Each raised row with a split: null when converting it would be accepted,
  // else why not (lib/conversion.ts). Move is offered on the null ones only.
  // What each point-out rule points out (the Zelle rule): rows with no
  // category it matches.
  const pointOut = await pointedOut();
  // The latest review of each statement, keyed `${ledgerId}:${closingDate}`;
  // whether it still applies is decided against the current figures.
  const statementReviews = Object.fromEntries(
    [...(await latestStatementReviews())].map(([key, r]) => [
      key,
      { chargesDiffCents: r.chargesDiffCents, creditsDiffCents: r.creditsDiffCents, note: r.note, reviewedAt: r.reviewedAt.toISOString() },
    ]),
  );
  // Raised rows kept raised, where the review still applies: the row still
  // has the amount it was kept at.
  const amountOf = new Map(transactions.map((t) => [t.id, t.amountCents]));
  const keptRaised: Record<string, { note: string; reviewedAt: string }> = {};
  for (const [id, r] of await latestRaisedReviews()) {
    if (amountOf.get(id) === r.amountCents) keptRaised[id] = { note: r.note, reviewedAt: r.reviewedAt.toISOString() };
  }
  const conversions: Record<string, string | null> = Object.fromEntries(
    [...(await conversionChecks())].map(([id, check]) => [id, 'error' in check ? check.error : null]),
  );

  // The grouping lib works in plain strings; format the upload timestamp
  // to its calendar date here rather than shipping Dates to the client.
  const importGroups = imports.map(({ importedAt, ...imp }) => ({
    ...imp,
    importedAt: importedAt.toISOString().slice(0, 10),
  }));
  // Undone (soft-deleted) batches, for the restore controls. Same timestamp
  // formatting rule: the client works in plain date strings.
  const undoneImports = deletedImports.map(({ importedAt, deletedAt, ...imp }) => ({
    ...imp,
    importedAt: importedAt.toISOString().slice(0, 10),
    deletedOn: deletedAt.toISOString().slice(0, 10),
  }));
  const categoryList = categories.map((c) => ({ id: c.id, name: c.name }));
  const personList = persons.map((p) => ({ id: p.id, name: p.name, isOwner: p.isOwner }));

  // Rows the bank removed that the owner had built on: where their split
  // could move if the purchase came back under a new id.
  const removedIds = transactions.filter((t) => t.removedByBankAt !== null).map((t) => t.id);
  const replacementCandidates: Record<string, ReplacementCandidate[]> = Object.fromEntries(await getReplacementCandidates(removedIds));

  // Incoming credit each person already carries (unallocated payments), so
  // the flag panel can say what re-saving a split would leave them owing.
  const creditByPerson: Record<string, number> = {};
  if (Object.keys(replacementCandidates).length > 0 || transactions.some((t) => t.bankAmountBeforeCents !== null)) {
    for (const s of await getSettlements()) {
      if (s.direction === 'incoming' && s.unallocatedCents > 0) {
        creditByPerson[s.personId] = (creditByPerson[s.personId] ?? 0) + s.unallocatedCents;
      }
    }
  }

  const receiptsByTransaction: Record<string, ReceiptView> = {};
  for (const r of receipts) receiptsByTransaction[r.transactionId] = r;

  const splitsByTransaction: Record<string, SplitSummary> = {};
  for (const s of splits) {
    splitsByTransaction[s.transactionId] = { method: s.method, taxCents: s.taxCents, tipCents: s.tipCents, shares: s.shares };
  }

  // New splits preselect the owner plus whoever was in the most recent
  // split, for quick repeat entry with the usual crew.
  const activeIds = new Set(personList.map((p) => p.id));
  const latest = splits.reduce<(typeof splits)[number] | null>((acc, s) => (acc === null || s.createdAt > acc.createdAt ? s : acc), null);
  const defaultParticipantIds = [
    ...new Set([...personList.filter((p) => p.isOwner).map((p) => p.id), ...(latest?.shares.map((sh) => sh.personId) ?? [])]),
  ].filter((id) => activeIds.has(id));

  return {
    transactions,
    categoryList,
    personList,
    splitsByTransaction,
    receiptsByTransaction,
    replacementCandidates,
    creditByPerson,
    defaultParticipantIds,
    importGroups,
    undoneImports,
    linkedAccounts,
    ledgers,
    importSkips,
    conversions,
    pointOut,
    statementReviews,
    keptRaised,
  };
}
