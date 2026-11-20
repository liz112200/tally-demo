import { formatUSD, toCents } from '@/lib/money';
import type { BoundaryRow } from '@/db/ledger';
import { FinishReviewButton, HeldRowAnswer } from '@/app/_components/ledger-controls';

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// The boundary review of one bank account (REAL-ACCOUNTS.md): the CSV rows
// before its cutover beside the bank rows set aside or held, each held row
// with its answer. Shown on the account's page; while open, or while a held
// row is unanswered, it stays on screen.
export function BoundaryReviewBlock({
  accountId,
  review,
  reviewedAt,
}: {
  accountId: string;
  review: { cutover: string; rows: BoundaryRow[] };
  reviewedAt: Date | null;
}) {
  const needsAnswer = (row: BoundaryRow) => row.kind === 'possible_duplicate' && !row.resolution;
  const pending = review.rows.filter(needsAnswer);
  const history = review.rows.filter((row) => !needsAnswer(row));
  return (
    <div className="rounded-lg border bg-card px-4 py-3 text-sm sm:px-5">
      <p className="font-medium">{pending.length ? `${pending.length} possible duplicate${pending.length === 1 ? '' : 's'}` : 'No duplicates to answer'}</p>
      {pending.length > 0 && <ul className="mt-1 divide-y">
        {pending.map((row) => <ReviewRow key={row.providerTransactionId} accountId={accountId} row={row} />)}
      </ul>}
      <details className="mt-2 border-t pt-2 text-xs">
        <summary className="cursor-pointer py-1.5 text-muted-foreground">Import history · {review.cutover}</summary>
        <p className="max-w-prose py-2 text-muted-foreground">This account switches from CSV imports to bank records on {review.cutover}. Add any missing purchases that were pending when you exported the CSV.</p>
        {reviewedAt && <p className="text-muted-foreground">Last reviewed {formatDay(reviewedAt)}</p>}
        {history.length > 0 && <ul className="divide-y">
          {history.map((row, i) => <ReviewRow key={row.providerTransactionId ?? i} accountId={accountId} row={row} />)}
        </ul>}
      </details>
      {!reviewedAt && pending.length === 0 && <div className="mt-3"><FinishReviewButton accountId={accountId} /></div>}
    </div>
  );
}

function ReviewRow({ accountId, row }: { accountId: string; row: BoundaryRow }) {
  const amount = (mills: number) => formatUSD(toCents(mills));
  const source = row.kind === 'csv' ? 'CSV' : 'Bank';
  let status = '';
  if (row.kind === 'before_cutover') status = 'Before cutoff · skipped';
  if (row.resolution === 'same') status = 'Duplicate kept out';
  if (row.resolution === 'released') status = 'Added as a separate purchase';
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 py-3">
      <div className="min-w-0">
        <p className="break-words font-medium">{row.description}</p>
        <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
          <span>{source} · {row.date} · {amount(row.amountCents)}</span>
          {row.twinDate && <span>Possible CSV match · {row.twinDate} · {amount(row.differsFrom?.amountCents ?? row.amountCents)}</span>}
          {status && <span>{status}{row.resolvedAt && ` · ${formatDay(row.resolvedAt)}`}</span>}
        </p>
      </div>
      {row.kind === 'possible_duplicate' && row.resolution !== 'released' && row.providerTransactionId && (
        <HeldRowAnswer accountId={accountId} providerTransactionId={row.providerTransactionId} answered={row.resolution} />
      )}
    </li>
  );
}
