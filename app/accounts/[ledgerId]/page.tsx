import { Suspense } from 'react';
import { notFound } from 'next/navigation';
import { requireUser } from '@/app/_lib/session';
import { loadLedgerView } from '@/app/_lib/ledger-view';
import { boundaryReview, ledgerStateFor } from '@/db/ledger';
import { currentCycle } from '@/lib/statement-cycles';
import { cycleSummary } from '@/lib/cycle-summary';
import { filterByTab } from '@/lib/expense-filters';
import { groupByPeriod, statementComparison } from '@/lib/statement-periods';
import { explainDifference } from '@/lib/difference-explain';
import { formatUSD, toCents } from '@/lib/money';
import { differenceFacts } from '@/db/reviews';
import { AccountClosed } from '@/app/_components/account-closed';
import type { PeriodNote } from '@/app/_components/period-header';
import { TransactionTable } from '@/app/_components/transaction-table';
import { StatementsControl } from '@/app/_components/ledger-controls';
import { BoundaryReviewBlock } from '@/app/_components/boundary-review';
import { AccountImports } from '@/app/_components/account-imports';
import { ImportSkips } from '@/app/_components/import-skips';
import { RelativeTime } from '@/app/_components/relative-time';

// Sync and statement actions run from this page.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const shortDay = (iso: string, today: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(iso.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }),
    timeZone: 'UTC',
  });

// One ledger account (the accounts board, 2026-11-05): where it is in its
// cycle and how that is known, the questions it holds, its statement periods
// with their rows, the statements recorded for it, and the uploads that fed
// it. The reasoning sentence under the cycle is the page's anchor: it says how
// sure the close is, in one line.
export default async function AccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ ledgerId: string }>;
  // ?statement=<closing date>: open that statement for editing (the band's
  // "Add totals").
  // ?record=statement: open the form to record one ("Record it", "Record one").
  searchParams: Promise<{ statement?: string | string[]; record?: string | string[] }>;
}) {
  await requireUser();
  const { ledgerId } = await params;
  const { statement: editParam, record: recordParam } = await searchParams;
  const view = await loadLedgerView();
  const ledger = view.ledgers.find((l) => l.id === ledgerId);
  if (!ledger) notFound();

  const today = new Date().toISOString().slice(0, 10);
  const day = (iso: string) => shortDay(iso, today);
  const banks = view.linkedAccounts.filter((a) => a.ledgerAccountId === ledgerId);
  const states = await ledgerStateFor(banks.map((b) => b.id));
  const reviews = new Map(
    await Promise.all(
      banks
        .filter((b) => {
          const s = states.get(b.id);
          return b.lastSyncedAt !== null && s?.cutoverDate && (!s.boundaryReviewedAt || s.heldCount > 0);
        })
        .map(async (b) => [b.id, await boundaryReview(b.id)] as const),
    ),
  );

  // A closed account expects nothing more: no cycle.
  const cycle = ledger.closedOn ? null : currentCycle(ledger.statements, today);
  // For each statement that differs from its rows: the facts that account
  // for it, and its latest review (PeriodHeader shows both).
  const ledgerRows = filterByTab(view.transactions, { kind: 'ledger', id: ledgerId });
  const groups = groupByPeriod({ all: ledgerRows, visible: ledgerRows, statements: ledger.statements, purchaseDatedCsv: ledger.purchaseDatedCsv });
  const differing = groups.filter((g) => {
    const c = statementComparison(g);
    return c !== null && (c.chargesDiff !== 0 || c.creditsDiff !== 0);
  });
  const facts = differing.length > 0 ? await differenceFacts(ledgerId) : { held: [], raised: [] };
  const periodNotes: Record<string, PeriodNote> = {};
  for (const g of differing) {
    const c = statementComparison(g)!;
    const e = explainDifference({
      from: g.from!,
      to: g.to!,
      chargesDiff: c.chargesDiff,
      creditsDiff: c.creditsDiff,
      held: facts.held,
      raised: facts.raised,
      day,
      money: (n) => formatUSD(toCents(n)),
    });
    periodNotes[g.statement!.closingDate] = { ...e, review: view.statementReviews[`${ledgerId}:${g.statement!.closingDate}`] ?? null };
  }
  const summary = cycle ? cycleSummary({ cycle, statements: ledger.statements, today, formatDay: day }) : null;
  const rows = view.transactions.filter((t) => t.ledgerAccountId === ledgerId);
  const hasCsvRows = rows.some((t) => t.source !== 'plaid' && t.source !== 'manual');
  const imports = view.importGroups.filter((i) => i.ledgerAccountId === ledgerId);
  const undone = view.undoneImports.filter((i) => i.ledgerAccountId === ledgerId);
  const skips = view.importSkips.filter((g) => g.ledgerAccountId === ledgerId);
  const lastSynced = banks
    .map((b) => b.lastSyncedAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const lastImport = imports.map((i) => i.importedAt).sort().reverse()[0];
  const kindWord = ledger.kind === 'card' ? 'Card' : 'Checking';

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 sm:py-8">
      <a href="/" className="inline-flex min-h-9 items-center text-sm text-blue-700 hover:underline dark:text-blue-400">
        ← All accounts
      </a>

      <section className="space-y-2.5 rounded-xl border bg-card p-4 sm:p-5">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{ledger.label}</h1>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
            <span>
              {kindWord} · {banks.length > 0 ? 'linked' : 'CSV only'}
            </span>
            {lastSynced ? (
              <RelativeTime iso={lastSynced.toISOString()} prefix="synced " />
            ) : lastImport ? (
              <span>last CSV import {day(lastImport)}</span>
            ) : null}
          </div>
        </div>
        {ledger.closedOn ? (
          <p className="text-sm">
            <span className="font-semibold">Closed on {day(ledger.closedOn)}.</span>{' '}
            <span className="text-muted-foreground">No statement is expected after it.</span>
          </p>
        ) : summary ? (
          <>
            <div aria-hidden className="h-2 max-w-xl overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground" style={{ width: `${summary.progress}%` }} />
            </div>
            <p className="text-sm">
              <span className="font-semibold">{summary.range}</span>{' '}
              <span className="whitespace-nowrap text-muted-foreground">· {summary.count}</span>{' '}
              <span className="whitespace-nowrap text-muted-foreground">· {summary.left}</span>
            </p>
            <p className="text-sm text-muted-foreground">{summary.reason}</p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No statement recorded, so its rows have no cycle to sit in. Record one below.
          </p>
        )}
        {ledger.purchaseDatedCsv && hasCsvRows && (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            This card&apos;s CSV records the purchase date, not the posting date: a CSV row bought near a closing day may
            sit beside the statement that counts it.
          </p>
        )}
        {banks.map((b) => {
          const s = states.get(b.id);
          if (!s) return null;
          const name = b.mask ? `${b.name} ••${b.mask}` : b.name;
          return s.verifiedAt ? (
            <p key={b.id} className="text-sm text-muted-foreground">
              {banks.length > 1 && <span className="font-medium text-foreground">{name}: </span>}
              Verified against a statement on {s.verifiedAt.toISOString().slice(0, 10)}; its rows count.
            </p>
          ) : (
            <p key={b.id} className="text-sm text-amber-800 dark:text-amber-300">
              {banks.length > 1 && <span className="font-medium">{name}: </span>}
              Not checked against a statement yet, so its synced rows count in no total.{' '}
              <a href={`/accounts/verify/${b.id}`} className="underline underline-offset-2">
                Check against a statement
              </a>
            </p>
          );
        })}
      </section>

      {reviews.size > 0 && (
        <section id="review" className="scroll-mt-16 space-y-2 text-xs">
          <h2 className="text-base font-semibold">Rows to answer</h2>
          {[...reviews].map(([bankId, review]) => {
            const s = states.get(bankId)!;
            return review ? (
              <BoundaryReviewBlock key={bankId} accountId={bankId} review={review} reviewedAt={s.boundaryReviewedAt} heldCount={s.heldCount} />
            ) : null;
          })}
        </section>
      )}

      <section id="periods" className="scroll-mt-16 space-y-2">
        <h2 className="text-base font-semibold">Statement periods</h2>
        {/* useTableState reads useSearchParams, which needs a Suspense
            boundary to prerender. */}
        <Suspense>
          <TransactionTable
            data={view.transactions}
            categories={view.categoryList}
            persons={view.personList}
            splitsByTransaction={view.splitsByTransaction}
            defaultParticipantIds={view.defaultParticipantIds}
            receiptsByTransaction={view.receiptsByTransaction}
            replacementCandidates={view.replacementCandidates}
            creditByPerson={view.creditByPerson}
            imports={view.importGroups}
            ledgers={[ledger]}
            conversions={view.conversions}
            keptRaised={view.keptRaised}
            periodNotes={periodNotes}
            account={ledgerId}
          />
        </Suspense>
      </section>

      <section id="statements" className="scroll-mt-16 space-y-2 text-xs">
        <h2 className="text-base font-semibold">Statements</h2>
        <StatementsControl
          ledgerAccountId={ledgerId}
          statements={ledger.statements}
          today={today}
          kind={ledger.kind}
          editDate={typeof editParam === 'string' ? editParam : null}
          recordOpen={recordParam === 'statement'}
        />
        <AccountClosed ledgerAccountId={ledgerId} closedOn={ledger.closedOn} today={today} />
      </section>

      <section id="imports" className="scroll-mt-16 space-y-2">
        <h2 className="text-base font-semibold">Imports</h2>
        <AccountImports live={imports} undone={undone} />
        <ImportSkips groups={skips} />
      </section>
    </main>
  );
}
