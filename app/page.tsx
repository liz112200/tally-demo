import { Suspense } from 'react';
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
  type ReceiptView,
  type ReplacementCandidate,
} from '@/db/queries';
import { TransactionTable } from '@/app/_components/transaction-table';
import { ExpensesToolbar } from '@/app/_components/expense-dialogs';
import { isDemoMode } from '@/lib/demo-mode';
import { notSyncingReason } from '@/lib/bank-sync/accounts-view';
import type { SplitSummary } from '@/app/_components/split-editor';
import { requireUser } from '@/app/_lib/session';

export default async function Home() {
  await requireUser();
  const [
    transactions,
    categories,
    persons,
    splits,
    receipts,
    imports,
    deletedImports,
    linkedAccounts,
  ] = await Promise.all([
    getTransactions(),
    getCategories(),
    getPersons(),
    getSplits(),
    getReceipts(),
    getImports(),
    getDeletedImports(),
    getLinkedAccountGroups(),
  ]);
  // Synced rows group by the linked account they came from. Plain strings
  // for the client, as with imports.
  // A synced account's group is named after its ledger account, the account
  // as the owner knows it (REAL-ACCOUNTS.md); one not yet verified against a
  // statement says its rows are not counted.
  const accountGroups = linkedAccounts.map((a) => ({
    id: a.id,
    label:
      a.ledgerName ??
      [a.institutionName, a.mask ? `${a.name} ••${a.mask}` : a.name].filter(Boolean).join(' · '),
    lastSyncedAt: a.lastSyncedAt ? a.lastSyncedAt.toISOString() : null,
    notSyncing:
      notSyncingReason(a, a) ??
      (a.verifiedAt === null ? { text: 'awaiting verification; rows not counted', needsOwner: true } : null),
  }));
  // The grouping lib works in plain strings; format the upload timestamp
  // to its calendar date here rather than shipping Dates to the client.
  const importGroups = imports.map(({ importedAt, ...imp }) => ({
    ...imp,
    importedAt: importedAt.toISOString().slice(0, 10),
  }));
  // Undone (soft-deleted) batches, for the restore strip. Same timestamp
  // formatting rule: the client works in plain date strings.
  const undoneImports = deletedImports.map(
    ({ importedAt, deletedAt, ...imp }) => ({
      ...imp,
      importedAt: importedAt.toISOString().slice(0, 10),
      deletedOn: deletedAt.toISOString().slice(0, 10),
    }),
  );
  const categoryList = categories.map((c) => ({ id: c.id, name: c.name }));
  const personList = persons.map((p) => ({
    id: p.id,
    name: p.name,
    isOwner: p.isOwner,
  }));

  // Rows the bank removed that the owner had built on: where their split
  // could move if the purchase came back under a new id.
  const removedIds = transactions.filter((t) => t.removedByBankAt !== null).map((t) => t.id);
  const replacementCandidates: Record<string, ReplacementCandidate[]> = Object.fromEntries(
    await getReplacementCandidates(removedIds),
  );

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
  for (const r of receipts) {
    receiptsByTransaction[r.transactionId] = r;
  }

  const splitsByTransaction: Record<string, SplitSummary> = {};
  for (const s of splits) {
    splitsByTransaction[s.transactionId] = {
      method: s.method,
      taxCents: s.taxCents,
      tipCents: s.tipCents,
      shares: s.shares,
    };
  }

  // New splits preselect the owner plus whoever was in the most recent
  // split, for quick repeat entry with the usual crew.
  const activeIds = new Set(personList.map((p) => p.id));
  const latest = splits.reduce<(typeof splits)[number] | null>(
    (acc, s) => (acc === null || s.createdAt > acc.createdAt ? s : acc),
    null,
  );
  const defaultParticipantIds = [
    ...new Set([
      ...personList.filter((p) => p.isOwner).map((p) => p.id),
      ...(latest?.shares.map((sh) => sh.personId) ?? []),
    ]),
  ].filter((id) => activeIds.has(id));

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Expenses</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {transactions.length === 0
              ? 'Nothing recorded yet'
              : `${transactions.length} row${
                  transactions.length === 1 ? '' : 's'
                }`}
          </p>
        </div>
        <ExpensesToolbar categories={categoryList} demo={isDemoMode()} />
      </div>
      {/* useTableState reads useSearchParams, which needs a Suspense
          boundary to prerender; params resolve client-side on hydration. */}
      <Suspense>
        <TransactionTable
          data={transactions}
          categories={categoryList}
          persons={personList}
          splitsByTransaction={splitsByTransaction}
          defaultParticipantIds={defaultParticipantIds}
          receiptsByTransaction={receiptsByTransaction}
          replacementCandidates={replacementCandidates}
          creditByPerson={creditByPerson}
          imports={importGroups}
          accounts={accountGroups}
          undoneImports={undoneImports}
        />
      </Suspense>
    </main>
  );
}
