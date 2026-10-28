import Link from 'next/link';
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Minus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatUSD, toCents } from '@/lib/money';
import { getInsightRows } from '@/db/queries';
import {
  addMonths,
  categoryBreakdown,
  isMonthKey,
  monthLabel,
  monthShortLabel,
  spendingDelta,
  spendingTrend,
  topMerchants,
} from '@/lib/insights';
import {
  CategoryBarChart,
  SpendTrendSparkline,
} from '@/app/_components/insights-charts';
import { requireUser } from '@/app/_lib/session';

// The month the dashboard anchors on when ?month= is absent: the owner's
// calendar month (America/New_York), not UTC's, which flips early on
// evenings at month boundaries. Transaction dates themselves are plain
// YYYY-MM-DD strings, so this is the only timezone decision on the page.
function currentMonth(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  })
    .format(new Date())
    .slice(0, 7);
}

function Card({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn('rounded-xl border bg-card p-4', className)}>
      <h2 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function NoSpending() {
  return <p className="text-sm text-muted-foreground">No spending recorded</p>;
}

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  await requireUser();
  const params = await searchParams;
  const thisMonth = currentMonth();
  const month =
    params.month && isMonthKey(params.month) ? params.month : thisMonth;

  const rows = await getInsightRows();
  const delta = spendingDelta(rows, month);
  const breakdown = categoryBreakdown(rows, month);
  const merchants = topMerchants(rows, month, 5);
  const trend = spendingTrend(rows, month, 6);
  const hasSpending = delta.currentCents > 0 || breakdown.length > 0;

  const prevMonth = addMonths(month, -1);
  const nextMonth = addMonths(month, 1);

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Insights</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Calendar-month spending by transaction date
          </p>
        </div>
        <nav
          aria-label="Month"
          className="flex items-center gap-1 text-sm"
        >
          <Link
            href={`/insights?month=${prevMonth}`}
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
              href={`/insights?month=${nextMonth}`}
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

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={`${monthLabel(month)} spending`}>
          {hasSpending || delta.previousCents > 0 ? (
            <div className="space-y-2">
              <p className="font-mono text-3xl font-semibold tracking-tight">
                {formatUSD(toCents(delta.currentCents))}
              </p>
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {delta.deltaCents > 0 ? (
                  <ArrowUpRight className="size-3.5" aria-hidden />
                ) : delta.deltaCents < 0 ? (
                  <ArrowDownRight className="size-3.5" aria-hidden />
                ) : (
                  <Minus className="size-3.5" aria-hidden />
                )}
                <span className="font-mono">
                  {delta.deltaCents > 0 ? '+' : ''}
                  {formatUSD(toCents(delta.deltaCents))}
                </span>
                vs {monthLabel(prevMonth)}
              </p>
            </div>
          ) : (
            <NoSpending />
          )}
        </Card>

        <Card title="Spend trend" className="lg:col-span-2">
          {trend.length > 0 ? (
            <div>
              <SpendTrendSparkline points={trend} />
              <div className="flex justify-between px-1 text-[11px] text-muted-foreground">
                <span>{monthShortLabel(trend[0].month)}</span>
                {trend.length > 1 && (
                  <span>{monthShortLabel(trend[trend.length - 1].month)}</span>
                )}
              </div>
            </div>
          ) : (
            <NoSpending />
          )}
        </Card>

        <Card title="Category breakdown" className="lg:col-span-2">
          {breakdown.length > 0 ? (
            <CategoryBarChart slices={breakdown} />
          ) : (
            <NoSpending />
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Splittable spending only; rent and income are counted in the
            month total but not broken down here.
          </p>
        </Card>

        <Card title="Top merchants">
          {merchants.length > 0 ? (
            <ul className="space-y-1.5">
              {merchants.map((m) => (
                <li
                  key={m.merchant}
                  className="flex items-baseline justify-between gap-3 text-xs"
                >
                  <span className="truncate">{m.merchant}</span>
                  <span className="font-mono">
                    {formatUSD(toCents(m.totalCents))}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <NoSpending />
          )}
        </Card>
      </div>
    </main>
  );
}
