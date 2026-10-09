import { Suspense } from 'react';
import {
  getTransactions,
  getCategories,
  getPersons,
  getSplits,
  getReceipts,
  getImports,
  getDeletedImports,
  type ReceiptView,
} from '@/db/queries';
import { TransactionTable } from '@/app/_components/transaction-table';
import { ExpensesToolbar } from '@/app/_components/expense-dialogs';
import { isDemoMode } from '@/lib/demo-mode';
import type { SplitSummary } from '@/app/_components/split-editor';

export default async function Home() {
  const [
    transactions,
    categories,
    persons,
    splits,
    receipts,
    imports,
    deletedImports,
  ] = await Promise.all([
    getTransactions(),
    getCategories(),
    getPersons(),
    getSplits(),
    getReceipts(),
    getImports(),
    getDeletedImports(),
  ]);
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
              : `${transactions.length} transaction${
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
          imports={importGroups}
          undoneImports={undoneImports}
        />
      </Suspense>
    </main>
  );
}
