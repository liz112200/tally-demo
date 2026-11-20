import Link from 'next/link';
import { SpendingReport } from '@/app/_components/spending-report';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { SpendingView } from '@/lib/insights';
import { getInsightRows, getMyShareRows } from '@/db/queries';
import { addMonths, isMonthKey, monthLabel } from '@/lib/insights';
import { requireUser } from '@/app/_lib/session';

// The month the dashboard anchors on when ?month= is absent: the owner's
// calendar month (America/New_York), not UTC's, which flips early on
// evenings at month boundaries. Transaction dates themselves are plain
// YYYY-MM-DD strings, so this is the only timezone decision on the page.
function currentDay(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  })
    .format(new Date());
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; view?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const today = currentDay();
  const thisMonth = today.slice(0, 7);
  const month =
    params.month && isMonthKey(params.month) ? params.month : thisMonth;

  const view: SpendingView = params.view === 'share' ? 'share' : 'paid';
  const rows = view === 'share' ? await getMyShareRows() : await getInsightRows();
  function reportUrl(key: string, mode: SpendingView) {
    return `/insights?month=${key}${mode === 'share' ? '&view=share' : ''}`;
  }
  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Insights</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {view === 'share' ? 'Your portion, including purchases others covered.' : 'Purchases you covered, before splitting.'}
          </p>
        </div>
        <nav
          aria-label="Month"
          className="flex items-center gap-1 text-sm"
        >
          <Link
            href={reportUrl(prevMonth, view)}
            aria-label="Previous month"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
          </Link>
          <span className="min-w-28 text-center font-medium">
            {monthLabel(month)}
          </span>
          {month < thisMonth ? (
            <Link
              href={reportUrl(nextMonth, view)}
              aria-label="Next month"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </Link>
          ) : (
            <span className="p-1 text-muted-foreground/40" aria-hidden>
              <ChevronRight className="size-4" />
            </span>
          )}
        </nav>
      </div>

      <nav aria-label="Spending view" className="spend-switch">
        {(['paid', 'share'] as const).map(mode =>
          <Link key={mode} scroll={false} aria-current={view === mode ? 'page' : undefined} href={reportUrl(month, mode)}>
            {mode === 'paid' ? 'What I paid' : 'My share'}
          </Link>
        )}
      </nav>
      <SpendingReport view={view} rows={rows} month={month} today={today} />
    </main>
  );
}
