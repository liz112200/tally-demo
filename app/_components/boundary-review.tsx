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
  heldCount,
}: {
  accountId: string;
  review: { cutover: string; rows: BoundaryRow[] };
  reviewedAt: Date | null;
  heldCount: number;
}) {
  return (
    <details open className="mt-1 rounded-lg border px-3 py-2">
      <summary className="cursor-pointer text-foreground">
        Boundary review: the days around {review.cutover}
        {reviewedAt && (
          <span className="text-amber-700 dark:text-amber-400">
            {' '}
            · {heldCount === 1 ? 'one held row' : `${heldCount} held rows`} not answered
          </span>
        )}
      </summary>
      {reviewedAt && (
        <p className="mt-1 text-amber-700 dark:text-amber-400">
          This review was closed on {formatDay(reviewedAt)} without an answer for{' '}
          {heldCount === 1 ? 'one held row' : `${heldCount} held rows`}. Unanswered, a held row stays out, but
          nothing records that you decided it. Answer each below.
        </p>
      )}
      <p className="mt-1 text-muted-foreground">
        CSV rows from the last week before the cutover, beside bank rows that were not added: those before it, and those
        held because they match a CSV row. A purchase pending when you exported the CSV is in neither; add it by hand if
        it is missing.
      </p>
      {review.rows.length === 0 && (
        <p className="mt-2 text-foreground">
          Nothing to compare: no CSV row from the last week before the cutover, and no bank row from that week
          set aside or held.
        </p>
      )}
      <ul className="mt-2 space-y-1">
        {review.rows.map((r, i) => (
          <li key={`${r.kind}-${r.providerTransactionId ?? i}`} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="font-mono">{r.date}</span> · {formatUSD(toCents(r.amountCents))} · {r.description}{' '}
              <span className="text-muted-foreground">
                {r.kind === 'csv'
                  ? '(CSV)'
                  : r.kind === 'before_cutover'
                    ? '(bank, before the cutover: not added)'
                    : r.resolution === 'same'
                      ? `(bank: kept out as the same purchase, answered ${formatDay(r.resolvedAt!)})`
                      : r.resolution === 'released'
                        ? `(bank: added as its own purchase, answered ${formatDay(r.resolvedAt!)})`
                        : '(bank: held, may be the CSV row: not answered)'}
              </span>
              {r.differsFrom && (
                <span className="block text-amber-700 dark:text-amber-400">
                  Same merchant as the CSV row of {r.differsFrom.date}; the amounts differ: CSV{' '}
                  {formatUSD(toCents(r.differsFrom.amountCents))}, bank {formatUSD(toCents(r.amountCents))}.
                </span>
              )}
            </span>
            {r.kind === 'possible_duplicate' && r.resolution !== 'released' && r.providerTransactionId && (
              <HeldRowAnswer accountId={accountId} providerTransactionId={r.providerTransactionId} answered={r.resolution === 'same' ? 'same' : null} />
            )}
          </li>
        ))}
      </ul>
      {!reviewedAt && (
        <div className="mt-2">
          <FinishReviewButton accountId={accountId} />
        </div>
      )}
    </details>
  );
}
