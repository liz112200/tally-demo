'use client';

import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { formatUSD, toCents } from '@/lib/money';
import {
  UNCATEGORIZED_FILTER,
  hasActiveFilters,
  type CategorySourceKey,
  type DateRangeKey,
  type ExpenseFilters,
  type ReceiptFilterKey,
  type SourceTab,
  type SplitStatusKey,
  type ViewSummary,
} from '@/lib/expense-filters';

type Category = { id: string; name: string };

const SOURCE_TAB_LABELS: Record<SourceTab, string> = {
  all: 'All',
  chase: 'Chase',
  discover: 'Discover',
  amex: 'Amex',
  plaid: 'Linked',
  manual: 'Manual',
};

// Per-account segmented control, same visual grammar as the split editor's
// method picker. Tabs render only for sources present in the data.
export function SourceTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: SourceTab[];
  active: SourceTab;
  onChange: (tab: SourceTab) => void;
}) {
  if (tabs.length <= 1) return null;
  return (
    <div
      role="tablist"
      aria-label="Filter by account"
      className="inline-flex w-fit gap-1 rounded-lg bg-muted p-1 text-[13px]"
    >
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={active === tab}
          onClick={() => onChange(tab)}
          className={cn(
            'rounded-md px-2.5 py-0.5 transition-colors',
            active === tab
              ? 'bg-card font-medium shadow-sm'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {SOURCE_TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}

const RANGE_LABELS: Record<DateRangeKey, string> = {
  all: 'All time',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  custom: 'Custom range',
};

const SPLIT_LABELS: Record<SplitStatusKey, string> = {
  all: 'Any split',
  split: 'Split',
  'not-split': 'Not split',
  'non-splittable': 'Non-splittable',
};

const CATSRC_LABELS: Record<CategorySourceKey, string> = {
  all: 'Any source',
  rule: 'Rule-set',
  manual: 'Manually set',
  uncategorized: 'Uncategorized',
};

const RECEIPT_LABELS: Record<ReceiptFilterKey, string> = {
  all: 'Any receipt',
  has: 'Has receipt',
  none: 'No receipt',
};

// One compact single-choice filter. The trigger reads muted at its default
// value and in plain ink once it narrows the view.
function FilterSelect<K extends string>({
  value,
  defaultValue,
  labels,
  onChange,
  ariaLabel,
}: {
  value: K;
  defaultValue: K;
  labels: Record<K, string>;
  onChange: (value: K) => void;
  ariaLabel: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as K)}>
      <SelectTrigger
        size="sm"
        aria-label={ariaLabel}
        className={cn(
          'h-7 text-xs',
          value === defaultValue
            ? 'text-muted-foreground'
            : 'border-primary/40 text-foreground',
        )}
      >
        {labels[value]}
      </SelectTrigger>
      <SelectContent>
        {(Object.entries(labels) as [K, string][]).map(([key, label]) => (
          <SelectItem key={key} value={key}>
            <span className="text-xs">{label}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Search keeps local state and commits to the URL debounced: Safari rate-
// limits history.replaceState, and per-keystroke URL churn buys nothing.
function SearchInput({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [text, setText] = useState(value);

  // Adopt external changes (back/forward, clear-all) without clobbering
  // in-flight typing: only sync when the committed value moved away from
  // what this input last committed.
  useEffect(() => {
    setText(value);
  }, [value]);

  useEffect(() => {
    if (text === value) return;
    const timer = setTimeout(() => onCommit(text), 250);
    return () => clearTimeout(timer);
  }, [text, value, onCommit]);

  return (
    <div className="relative min-w-40 flex-1">
      <Search
        className="pointer-events-none absolute inset-y-0 left-2 my-auto size-3.5 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Search descriptions"
        aria-label="Search descriptions"
        className="h-7 pl-7 text-xs"
      />
    </div>
  );
}

function CategoryMultiSelect({
  selected,
  categories,
  onChange,
}: {
  selected: string[];
  categories: Category[];
  onChange: (ids: string[]) => void;
}) {
  const label =
    selected.length === 0
      ? 'Any category'
      : selected.length === 1
        ? selected[0] === UNCATEGORIZED_FILTER
          ? 'Uncategorized'
          : (categories.find((c) => c.id === selected[0])?.name ?? '1 category')
        : `${selected.length} categories`;

  return (
    <Select
      multiple
      value={selected}
      onValueChange={(value) => onChange(value as string[])}
    >
      <SelectTrigger
        size="sm"
        aria-label="Filter by category"
        className={cn(
          'h-7 text-xs',
          selected.length === 0
            ? 'text-muted-foreground'
            : 'border-primary/40 text-foreground',
        )}
      >
        {label}
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNCATEGORIZED_FILTER}>
          <span className="text-xs text-muted-foreground">Uncategorized</span>
        </SelectItem>
        {categories.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            <span className="text-xs">{c.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function ExpenseFilterBar({
  filters,
  categories,
  onChange,
}: {
  filters: ExpenseFilters;
  categories: Category[];
  onChange: (next: ExpenseFilters) => void;
}) {
  const set = (patch: Partial<ExpenseFilters>) => onChange({ ...filters, ...patch });

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <SearchInput value={filters.q} onCommit={(q) => set({ q })} />
        <FilterSelect
          value={filters.range}
          defaultValue="all"
          labels={RANGE_LABELS}
          onChange={(range) => set({ range, from: null, to: null })}
          ariaLabel="Filter by date range"
        />
        <CategoryMultiSelect
          selected={filters.categories}
          categories={categories}
          onChange={(ids) => set({ categories: ids })}
        />
        <FilterSelect
          value={filters.split}
          defaultValue="all"
          labels={SPLIT_LABELS}
          onChange={(split) => set({ split })}
          ariaLabel="Filter by split status"
        />
        <FilterSelect
          value={filters.catSource}
          defaultValue="all"
          labels={CATSRC_LABELS}
          onChange={(catSource) => set({ catSource })}
          ariaLabel="Filter by category source"
        />
        <FilterSelect
          value={filters.receipt}
          defaultValue="all"
          labels={RECEIPT_LABELS}
          onChange={(receipt) => set({ receipt })}
          ariaLabel="Filter by receipt"
        />
        {hasActiveFilters(filters) && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-muted-foreground"
            onClick={() =>
              onChange({
                q: '',
                range: 'all',
                from: null,
                to: null,
                categories: [],
                split: 'all',
                catSource: 'all',
                receipt: 'all',
                review: 'all',
              })
            }
          >
            <X data-icon="inline-start" />
            Clear
          </Button>
        )}
      </div>

      {filters.range === 'custom' && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Input
            type="date"
            value={filters.from ?? ''}
            onChange={(e) => set({ from: e.target.value || null })}
            aria-label="From date"
            className="h-7 w-36 font-mono text-xs"
          />
          <span>to</span>
          <Input
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => set({ to: e.target.value || null })}
            aria-label="To date"
            className="h-7 w-36 font-mono text-xs"
          />
        </div>
      )}
    </div>
  );
}

// Figures for the rows currently in view (tab + filters applied). Mono
// figures, muted labels, matching the table's ledger tone.
// "N need review" toggles the review filter: it only appears while bank sync
// has flagged rows, so CSV-only views never see it.
export function SummaryStrip({
  summary,
  reviewActive,
  onToggleReview,
}: {
  summary: ViewSummary;
  reviewActive: boolean;
  onToggleReview: () => void;
}) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 px-1 text-[11px] text-muted-foreground">
      <span>
        <span className="font-mono">{summary.count}</span>{' '}
        {summary.count === 1 ? 'row' : 'rows'}
      </span>
      <span>
        spending{' '}
        <span className="font-mono text-foreground">
          {formatUSD(toCents(summary.spendingCents))}
        </span>
      </span>
      <span>
        credits{' '}
        <span className={cn('font-mono', summary.creditsCents < 0 && 'text-positive')}>
          {formatUSD(toCents(summary.creditsCents))}
        </span>
      </span>
      <span>
        net{' '}
        <span className="font-mono text-foreground">
          {formatUSD(toCents(summary.netCents))}
        </span>
      </span>
      {summary.transferCount > 0 && (
        <span title="Rows in a category that does not count as spending, such as Transfers">
          <span className="font-mono">{summary.transferCount}</span>{' '}
          {summary.transferCount === 1 ? 'transfer' : 'transfers'} not counted
        </span>
      )}
      {summary.pendingCount > 0 && (
        <span title="Pending bank rows are provisional; the posted row is the one that counts">
          <span className="font-mono">{summary.pendingCount}</span> pending not counted
        </span>
      )}
      {summary.unverifiedCount > 0 && (
        <span title="Synced rows from a bank account not yet checked against a statement; they count once it is, on Accounts">
          <span className="font-mono">{summary.unverifiedCount}</span> awaiting verification, not counted
        </span>
      )}
      {(summary.reviewCount > 0 || reviewActive) && (
        <button
          type="button"
          onClick={onToggleReview}
          aria-pressed={reviewActive}
          className={cn(
            'rounded px-1 font-medium text-warning underline-offset-2 hover:underline',
            reviewActive && 'bg-warning/10',
          )}
        >
          {reviewActive ? (
            'Show all rows'
          ) : (
            <>
              <span className="font-mono">{summary.reviewCount}</span>{' '}
              {summary.reviewCount === 1 ? 'needs' : 'need'} review
            </>
          )}
        </button>
      )}
    </p>
  );
}
