import { ChevronDown } from 'lucide-react';
import type { CategorySlice, InsightExpense, SpendingView } from '@/lib/insights';
import { formatUSD, toCents } from '@/lib/money';
import { categoryColorVar } from './category-tag';

const money = (amount: number) => formatUSD(toCents(amount));
const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function ExpenseCategories({ categories, purchases, view }: {
  categories: CategorySlice[];
  purchases: InsightExpense[];
  view: SpendingView;
}) {
  const groups = new Map<string | null, InsightExpense[]>();
  for (const row of purchases) {
    const key = row.categoryId === null ? null : row.categoryName;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const largest = categories[0]?.totalCents ?? 1;
  return <div className="expense-categories">
    {categories.map(({ name, totalCents }) => {
      const expenses = groups.get(name) ?? [];
      expenses.sort((a, b) => b.date.localeCompare(a.date) || a.description.localeCompare(b.description) || a.id.localeCompare(b.id));
      return <details name="insight-category" key={JSON.stringify(name)}>
        <summary>
          <span>{name ?? 'Uncategorized'}</span><b>{money(totalCents)}</b><ChevronDown size={15} aria-hidden />
          <i aria-hidden style={{ width: (100 * totalCents / largest) + '%', background: name ? categoryColorVar(name) : 'var(--muted-foreground)' }} />
        </summary>
        <ul aria-label={`${name ?? 'Uncategorized'} expenses`}>
          {expenses.map(row => <li key={row.id}>
            <div><span>{row.description}</span><small>
              <time dateTime={row.date}>{dateLabel.format(new Date(row.date + 'T00:00:00Z'))}</time>
              {view === 'share' && (row.payerName ? ` · Paid by ${row.payerName}`
                : row.paidCents !== row.amountCents ? ` · You paid ${money(row.paidCents)}` : '')}
            </small></div>
            <b>{money(row.amountCents)}</b>
          </li>)}
        </ul>
      </details>;
    })}
  </div>;
}
