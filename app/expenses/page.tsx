import { Suspense } from 'react';
import { loadLedgerView } from '@/app/_lib/ledger-view';
import { TransactionTable } from '@/app/_components/transaction-table';
import { ExpensesToolbar } from '@/app/_components/expense-dialogs';
import { isDemoMode } from '@/lib/demo-mode';
import { requireUser } from '@/app/_lib/session';

// Rendered per request, in the demo too, where the session check reads no
// cookie and the page would otherwise be prerendered with the rows of the
// build.
export const dynamic = 'force-dynamic';

// Expenses (the accounts board, 2026-11-05): one list, by month, with an
// account filter. Statement periods, uploads and rows not imported are on
// each account's page; a hidden import's rows are named above the table.
export default async function ExpensesPage() {
  await requireUser();
  const {
    transactions,
    categoryList,
    personList,
    splitsByTransaction,
    receiptsByTransaction,
    replacementCandidates,
    creditByPerson,
    defaultParticipantIds,
    importGroups,
    ledgers,
    conversions,
    pointOut,
    keptRaised,
  } = await loadLedgerView();
  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Expenses</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {transactions.length === 0 ? 'Nothing recorded yet' : `${transactions.length} row${transactions.length === 1 ? '' : 's'}`}
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
          ledgers={ledgers}
          conversions={conversions}
          pointOut={pointOut}
          keptRaised={keptRaised}
        />
      </Suspense>
    </main>
  );
}
