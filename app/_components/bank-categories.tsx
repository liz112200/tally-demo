'use client';

import { Landmark } from 'lucide-react';
import { cn } from '@/lib/utils';
import { setBankCategory } from '@/app/_actions/bank-categories';
import { PLAID_CATEGORIES } from '@/lib/bank-sync/bank-categories';
import { useAction } from './page-result';

// The owner's mapping from the bank's own categories to theirs (BANK-SYNC.md,
// "Bank categories"). A synced row no rule matches takes the mapped category,
// shown on the row as the bank's. Only categories that count as spending are
// offered; transfers stay with the rules.
const selectClass = cn(
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm',
  'outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
  'dark:bg-input/30',
);

export function BankCategories({
  rows,
  categories,
}: {
  rows: { plaidCategory: string; categoryId: string | null; syncedRows: number }[];
  // Categories that count as spending.
  categories: { id: string; name: string }[];
}) {
  const { run, pending } = useAction();
  const byKey = new Map(rows.map((r) => [r.plaidCategory, r]));
  return (
    <div className="space-y-1.5">
      <h2 className="flex items-center gap-1.5 px-1 text-[13px] font-medium">
        <Landmark className="size-3.5" aria-hidden />
        The bank&apos;s categories
      </h2>
      <p className="px-1 text-xs text-muted-foreground">
        A synced row your rules leave uncategorized takes the category you choose here, marked on the row as the
        bank&apos;s. Rules always win, and nothing you or a rule set is changed. Transfers stay with your rules: the bank
        files a payment to a person as a transfer.
      </p>
      <ul className="divide-y rounded-lg border">
        {PLAID_CATEGORIES.map(([key, label]) => {
          const row = byKey.get(key);
          return (
            <li key={key} className="flex items-center justify-between gap-4 px-3 py-1.5 text-sm">
              <span>
                {label}
                {row && row.syncedRows > 0 && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {row.syncedRows} synced row{row.syncedRows === 1 ? '' : 's'}
                  </span>
                )}
              </span>
              <select
                aria-label={`Category for the bank's ${label}`}
                className={cn(selectClass, 'max-w-48')}
                value={row?.categoryId ?? ''}
                disabled={pending}
                onChange={(e) => run(() => setBankCategory(key, e.target.value || null))}
              >
                <option value="">Not mapped</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
