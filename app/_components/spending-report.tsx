import type { CSSProperties } from 'react';
import { addMonths, monthLabel, monthShortLabel, spendingTrend, spendingProfile, type InsightExpense, type SpendingView } from '@/lib/insights';
import { formatUSD, toCents } from '@/lib/money';
import { ExpenseCategories } from './expense-categories';
import { CategoryBarChart, SpendingPace } from './insights-charts';

const money = (amount: number) => formatUSD(toCents(amount));

export function SpendingReport({ rows, month, today, view }: { rows: InsightExpense[]; view?: SpendingView; month: string; today: string }) {
  const report = spendingProfile(rows, month, today);
  if (!report.purchaseCount) return <section className="report-empty">
    <h2>{view === 'share' ? 'No personal share recorded for' : 'No spending recorded for'} {monthLabel(month)}</h2><p>Choose another month to see spending patterns.</p>
  </section>;
  const average = report.total / report.purchaseCount;
  const prior = monthShortLabel(addMonths(month, -1));
  const current = monthShortLabel(month);
  const months = spendingTrend(rows.filter(row => row.date <= today), month, 6);
  const highestMonth = Math.max(...months.map(point => point.totalCents));
  const largest = report.categories[0];
  const largestName = largest?.name ?? 'Uncategorized';
  const peakCount = Math.max(...report.weekdays.map(day => day.count));
  const peakDays = report.weekdays.filter(day => day.count === peakCount).map(day => day.label);
  return <article className="spending-report">
    <header className="report-head">
      <div><span>{view === 'share' ? 'My share' : view === 'paid' ? 'What I paid' : 'Recorded spending'}{month === today.slice(0, 7) && ` through ${current} ${report.days}`}</span>
        <strong>{money(report.total)}</strong></div>
      <div><span>Purchases</span><b>{report.purchaseCount}</b></div>
      <div><span>Average purchase</span><b>{(Number.isInteger(average) ? '' : '≈ ') + money(Math.round(average))}</b></div>
    </header>
    <section className="report-pace">
      <h2>Spending pace</h2>
      <p>{report.difference === null ? 'No purchases recorded in the previous month.' : report.difference === 0
        ? `Recorded spending matched ${prior} through day ${report.cutoff}.`
        : `Through day ${report.cutoff}, you spent ${money(Math.abs(report.difference))} ${report.difference > 0 ? 'more' : 'less'} than in ${prior}.`}</p>
      <div className="pace-key"><span>{current} cumulative</span>{report.difference !== null && <span>{prior} cumulative</span>}</div>
      <SpendingPace points={report.pace} />
      <details><summary>Daily totals</summary>
        <table><thead><tr><th>Day</th><th>{current} to date</th><th>{prior} to date</th></tr></thead>
          <tbody>{report.pace.map(p => <tr key={p.day}><td>{p.day}</td><td>{p.current === null ? '—' : money(p.current)}</td><td>{p.previous === null ? '—' : money(p.previous)}</td></tr>)}</tbody>
        </table>
      </details>
    </section>
    <div className="report-columns">
      <section><h2>Where your money went</h2>
        {largest && <p>{largestName} accounted for {Math.round(100 * largest.totalCents / report.total)}% of recorded spending.</p>}
        {view ? <ExpenseCategories key={month + view} view={view} categories={report.categories} purchases={report.purchases} />
          : <CategoryBarChart slices={report.categories} />}
      </section>
      <section><h2>When you shop</h2>
        <p>{peakDays.length === 7 ? 'All seven days had the same purchase count.' : `${peakDays.join(', ')} had the most purchases${peakDays.length > 1 ? ' (tied)' : ''}.`}</p>
        <ol className="weekday-chart" aria-label="Purchase count by day of week">{report.weekdays.map(day =>
          <li key={day.label}><span>{day.label}</span><i aria-hidden="true" style={{width: (100 * day.count / peakCount) + '%'}} /><b>{day.count}</b></li>)}</ol>
      </section>
    </div>
    <section><h2>Monthly spending</h2><p>Recorded totals for up to six months{month === today.slice(0, 7) ? `, including ${current} through day ${report.days}` : ''}.</p>
      <ol className="monthly-bars">{months.map(point => <li key={point.month}>
        <i aria-hidden="true" style={{ '--month-share': (100 * point.totalCents / highestMonth) + '%' } as CSSProperties} />
        <span>{monthShortLabel(point.month)}</span><b>{money(point.totalCents)}</b>
      </li>)}</ol>
    </section>
    <section><h2>Top merchants</h2><ol className="merchant-ranks">
      {report.merchants.map(m => <li key={m.merchant}><span>{m.merchant || 'Unknown merchant'}</span><b>{money(m.totalCents)}</b></li>)}
    </ol></section>
  </article>;
}
