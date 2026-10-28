'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import {
  type CellContext,
  type ColumnDef,
  type HeaderContext,
  type Row,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Plus, ReceiptText, Split as SplitIcon, Upload, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { formatUSD, toCents } from '@/lib/money';
import type { TransactionRow } from '@/db/queries';
import type { ReceiptView, ReplacementCandidate } from '@/db/queries';
import {
  nextSort,
  readSort,
  sortPatch,
  sortRows,
  type SortSpec,
  type SortState,
} from '@/lib/table-state';
import {
  applyExpenseFilters,
  availableSourceTabs,
  filterBySource,
  filterPatch,
  hasActiveFilters,
  readFilters,
  readSourceTab,
  sourceTabPatch,
  summarizeView,
  needsReview,
} from '@/lib/expense-filters';
import {
  groupRowsByImport,
  type AccountGroupMeta,
  type ImportGroupMeta,
} from '@/lib/import-groups';
import { useTableState } from '@/app/_lib/use-table-state';
import { SortHeaderButton } from '@/app/_components/sort-controls';
import { ImportGroupHeader } from '@/app/_components/import-group-header';
import { HiddenImportsStrip } from '@/app/_components/hidden-imports-strip';
import {
  UndoneImportsStrip,
  type UndoneImport,
} from '@/app/_components/undone-imports-strip';
import { setImportHidden, showAllImports } from '@/app/_actions/import';
import { BulkActionBar } from '@/app/_components/bulk-action-bar';
import { NoteIndicator } from '@/app/_components/note-block';
import {
  ExpenseFilterBar,
  SourceTabs,
  SummaryStrip,
} from '@/app/_components/expense-filter-bar';
import { CategoryCell } from '@/app/_components/category-cell';
import { TransactionDetailPanel } from '@/app/_components/transaction-detail';
import {
  SplitCell,
  type PersonOption,
  type SplitSummary,
} from '@/app/_components/split-editor';
import {
  AddTransactionDialog,
  ImportDialog,
} from '@/app/_components/expense-dialogs';
import { useAction } from './page-result';

type Category = { id: string; name: string };

const EXPENSES_SORT: SortSpec = {
  columns: ['date', 'descriptionRaw', 'category', 'source', 'split', 'amountCents'],
  defaultSort: 'date',
  defaultDir: 'desc',
  firstDir: { date: 'desc', amountCents: 'desc', split: 'desc' },
};

const HEADER_LABELS: Record<string, string> = {
  date: 'Date',
  descriptionRaw: 'Description',
  category: 'Category',
  source: 'Source',
  split: 'Split',
  amountCents: 'Amount',
};

// Per-column classes, threaded through TanStack's column meta.
type ColMeta = { th?: string; td?: string };

// Page-level data the cells need, threaded through the table's meta option
// rather than closed over in column defs. COLUMNS below is a module-level
// constant with stable cell component identities: rebuilding column defs on
// every data refresh would give each cell a new component type, making
// React remount the whole cell subtree — which silently closed any open
// dialog (split editor, receipt wizard) whenever a Server Action
// revalidated the page.
type TableMeta = {
  categories: Category[];
  persons: PersonOption[];
  splitsByTransaction: Record<string, SplitSummary>;
  defaultParticipantIds: string[];
  receiptsByTransaction: Record<string, ReceiptView>;
  sort: SortState;
  onSort: (columnId: string) => void;
  // Bulk selection (phase 7). Selection lives in React state on the page,
  // scoped to the current view: tab or filter changes clear it.
  selection: {
    has: (id: string) => boolean;
    toggleRow: (id: string) => void;
    allChecked: boolean;
    anyChecked: boolean;
    toggleAll: () => void;
  };
};

function tableMeta(
  ctx: CellContext<TransactionRow, unknown> | HeaderContext<TransactionRow, unknown>,
): TableMeta {
  return ctx.table.options.meta as TableMeta;
}

// Every column header sorts; the sort state lives in table meta so COLUMNS
// stays a module-level constant (see the note above TableMeta).
function SortableHeader(ctx: HeaderContext<TransactionRow, unknown>) {
  const meta = tableMeta(ctx);
  const id = ctx.column.id;
  return (
    <SortHeaderButton
      label={HEADER_LABELS[id] ?? id}
      active={meta.sort.sort === id}
      dir={meta.sort.dir}
      onToggle={() => meta.onSort(id)}
    />
  );
}

function CategoryColumnCell(ctx: CellContext<TransactionRow, unknown>) {
  const { row } = ctx;
  return (
    <CategoryCell
      transactionId={row.original.id}
      categoryId={row.original.categoryId}
      categorySource={row.original.categorySource}
      categories={tableMeta(ctx).categories}
    />
  );
}

function SplitColumnCell(ctx: CellContext<TransactionRow, unknown>) {
  const { row } = ctx;
  const meta = tableMeta(ctx);
  const receipt = meta.receiptsByTransaction[row.original.id] ?? null;
  return (
    <span className="inline-flex items-center gap-1">
      <SplitCell
        transactionId={row.original.id}
        description={row.original.descriptionRaw}
        date={row.original.date}
        amountCents={row.original.amountCents}
        isSplittable={row.original.isSplittable}
        persons={meta.persons}
        existing={meta.splitsByTransaction[row.original.id] ?? null}
        defaultParticipantIds={meta.defaultParticipantIds}
        receipt={receipt}
      />
      {row.original.note && <NoteIndicator />}
      {/* Presence indicator only — attach/view moved into the expanded
          row's receipt block (phase 6 consolidation). */}
      {receipt && (
        <ReceiptText
          className="size-3 text-primary/70"
          aria-label="Receipt attached"
        />
      )}
    </span>
  );
}

// The description, with what bank sync says about the row: pending (not yet
// final, not counted), or flagged for the owner's review.
function DescriptionColumnCell(ctx: CellContext<TransactionRow, unknown>) {
  const row = ctx.row.original;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate">{row.descriptionRaw}</span>
      {row.pending && (
        <span
          className="shrink-0 rounded border border-dashed px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          title="Pending at the bank: not counted, and split or receipt wait until it posts"
        >
          pending
        </span>
      )}
      {needsReview(row) && (
        <span
          className="shrink-0 rounded border border-warning/40 bg-warning/10 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-warning"
          title={
            row.bankAmountBeforeCents !== null
              ? 'The bank changed the amount of this split row'
              : 'The bank removed this row'
          }
        >
          review
        </span>
      )}
    </div>
  );
}

function SelectHeaderCell(ctx: HeaderContext<TransactionRow, unknown>) {
  const { selection } = tableMeta(ctx);
  return (
    <Checkbox
      aria-label="Select all in view"
      checked={selection.allChecked}
      indeterminate={selection.anyChecked && !selection.allChecked}
      onCheckedChange={() => selection.toggleAll()}
    />
  );
}

function SelectRowCell(ctx: CellContext<TransactionRow, unknown>) {
  const { selection } = tableMeta(ctx);
  const id = ctx.row.original.id;
  return (
    <Checkbox
      aria-label={`Select ${ctx.row.original.descriptionRaw}`}
      checked={selection.has(id)}
      onCheckedChange={() => selection.toggleRow(id)}
    />
  );
}

const COLUMNS: ColumnDef<TransactionRow>[] = [
  {
    id: 'select',
    header: SelectHeaderCell,
    cell: SelectRowCell,
    meta: { th: 'w-9', td: 'w-9' } satisfies ColMeta,
  },
  {
    accessorKey: 'date',
    header: SortableHeader,
    meta: {
      th: 'w-28',
      td: 'whitespace-nowrap font-mono text-xs text-muted-foreground',
    } satisfies ColMeta,
  },
  {
    accessorKey: 'descriptionRaw',
    header: SortableHeader,
    // No width in meta: under table-fixed this column takes whatever the
    // sized columns leave, and truncates to it.
    cell: DescriptionColumnCell,
  },
  {
    id: 'category',
    accessorFn: (row) => row.categoryName,
    header: SortableHeader,
    meta: { th: 'w-44', td: 'whitespace-nowrap' } satisfies ColMeta,
    cell: CategoryColumnCell,
  },
  {
    accessorKey: 'source',
    header: SortableHeader,
    meta: { th: 'w-24', td: 'whitespace-nowrap' } satisfies ColMeta,
    cell: ({ getValue }) => (
      <span className="rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {getValue<string>()}
      </span>
    ),
  },
  {
    id: 'split',
    header: SortableHeader,
    meta: { th: 'w-24', td: 'whitespace-nowrap' } satisfies ColMeta,
    cell: SplitColumnCell,
  },
  {
    accessorKey: 'amountCents',
    header: SortableHeader,
    meta: {
      th: 'w-28 text-right',
      td: 'whitespace-nowrap text-right font-mono',
    } satisfies ColMeta,
    cell: ({ getValue }) => {
      const cents = getValue<number>();
      return (
        // Spending stays in plain ink; credits and refunds (negative) go
        // quietly green.
        <span className={cn(cents < 0 && 'text-positive')}>
          {formatUSD(toCents(cents))}
        </span>
      );
    },
  },
];

function EmptyState({ categories }: { categories: Category[] }) {
  return (
    <div className="flex flex-col items-center gap-5 rounded-xl border bg-card px-6 py-24 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <ReceiptText className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">No transactions yet</p>
        <p className="text-sm text-muted-foreground">
          Import a bank CSV or add your first expense by hand.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <AddTransactionDialog
          categories={categories}
          trigger={
            <Button size="sm">
              <Plus data-icon="inline-start" />
              Add transaction
            </Button>
          }
        />
        <ImportDialog
          trigger={
            <Button variant="outline" size="sm">
              <Upload data-icon="inline-start" />
              Import CSV
            </Button>
          }
        />
      </div>
    </div>
  );
}

export function TransactionTable({
  data,
  categories,
  persons,
  splitsByTransaction,
  defaultParticipantIds,
  receiptsByTransaction,
  replacementCandidates,
  creditByPerson,
  imports,
  accounts,
  undoneImports,
}: {
  data: TransactionRow[];
  categories: Category[];
  persons: PersonOption[];
  splitsByTransaction: Record<string, SplitSummary>;
  defaultParticipantIds: string[];
  receiptsByTransaction: Record<string, ReceiptView>;
  replacementCandidates: Record<string, ReplacementCandidate[]>;
  creditByPerson: Record<string, number>;
  imports: ImportGroupMeta[];
  accounts: AccountGroupMeta[];
  undoneImports: UndoneImport[];
}) {
  const { params, apply } = useTableState();
  const sort = readSort(params, EXPENSES_SORT);
  const filters = readFilters(params);
  const sourceTab = readSourceTab(params);
  const sourceTabs = useMemo(() => availableSourceTabs(data), [data]);

  // Hidden imports are persisted on the imports row (server-side), so the URL
  // stays clean and the choice survives reloads and deployments. Hiding drops
  // a batch's header and rows from the view entirely; the strip below the
  // table unhides them. Mutations go through Server Actions + revalidatePath,
  // like every other write here (no URL state, no client optimism).
  const hidden = useMemo(
    () => new Set(imports.filter((imp) => imp.hidden).map((imp) => imp.id)),
    [imports],
  );
  // Hiding moves the group, which is its own confirmation; a failure still
  // shows, on the page result line.
  const { run } = useAction();
  const hideImport = (id: string) => run(() => setImportHidden(id, true));
  const unhideImport = (id: string) => run(() => setImportHidden(id, false));

  // Local calendar date for the relative ranges; computed once per mount.
  const [today] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  });

  // Filtering and sorting happen here, outside TanStack, so the URL stays
  // the single source of truth and column defs never need rebuilding.
  const visible = useMemo(() => {
    const filtered = applyExpenseFilters(filterBySource(data, sourceTab), filters, {
      today,
      hasSplit: (id) => id in splitsByTransaction,
      hasReceipt: (id) => id in receiptsByTransaction,
    })
      // Rows of a hidden import drop out of the view (and thus the summary
      // and selection), not just its group header.
      .filter((row) => !(row.importId && hidden.has(row.importId)));
    const accessors: Record<string, (row: TransactionRow) => unknown> = {
      date: (row) => row.date,
      descriptionRaw: (row) => row.descriptionRaw,
      category: (row) => row.categoryName,
      source: (row) => row.source,
      split: (row) => splitsByTransaction[row.id]?.shares.length ?? 0,
      amountCents: (row) => row.amountCents,
    };
    return sortRows(filtered, accessors[sort.sort] ?? accessors.date, sort.dir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    data,
    splitsByTransaction,
    receiptsByTransaction,
    sort.sort,
    sort.dir,
    today,
    params,
    hidden,
  ]);

  const summary = useMemo(() => summarizeView(visible), [visible]);

  // Upload-batch grouping (null = flat view: the Manual tab, or no imports).
  // Batch stats come from the unfiltered data so headers keep reading as
  // the statement period while filters narrow the rows.
  const shownImports = useMemo(
    () => imports.filter((imp) => !hidden.has(imp.id)),
    [imports, hidden],
  );
  const groups = useMemo(
    () => groupRowsByImport({ all: data, visible, imports: shownImports, accounts, tab: sourceTab }),
    [data, visible, shownImports, accounts, sourceTab],
  );
  // Hidden imports relevant to the current tab (bank tab filters by source;
  // the All tab shows every hidden import). Drives the unhide strip.
  const hiddenImports = useMemo(
    () =>
      imports.filter(
        (imp) =>
          hidden.has(imp.id) &&
          (sourceTab === 'all' || sourceTab === imp.source),
      ),
    [imports, hidden, sourceTab],
  );

  // Collapsed batches, keyed by group key. Default expanded.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleGroup = (key: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // Bulk selection (fork 1): React state, not the URL. Tab or filter
  // changes clear it because the visible set changes; sorting and
  // scrolling do not. selectedIds is derived against the visible rows so
  // a server refresh (e.g. after a bulk delete) can never leave stale ids
  // acting on rows that are no longer in view.
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const viewKey = JSON.stringify([sourceTab, filters]);
  useEffect(() => {
    setSelected(new Set());
  }, [viewKey]);
  const selectedIds = useMemo(
    () => visible.filter((row) => selected.has(row.id)).map((row) => row.id),
    [visible, selected],
  );
  const clearSelection = () => setSelected(new Set());
  const toggleRow = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // "Select all in view" toggles exactly the filtered/tabbed rows.
  const toggleAll = () =>
    setSelected(
      selectedIds.length === visible.length
        ? new Set()
        : new Set(visible.map((row) => row.id)),
    );

  // One row expands at a time; clicking it again (or another row) collapses.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Deep link (?tx=<id>, e.g. from a share on /people): expand the row and
  // bring it into view. Manual toggles clear the param so a later reload
  // reflects what is actually open.
  const txParam = params.get('tx');
  useEffect(() => {
    if (!txParam) return;
    setExpandedId(txParam);
    requestAnimationFrame(() => {
      document
        .getElementById(`tx-${txParam}`)
        ?.scrollIntoView({ block: 'center' });
    });
  }, [txParam]);

  const toggleExpanded = (id: string) => {
    setExpandedId((current) => (current === id ? null : id));
    if (txParam) apply({ tx: null });
  };

  const table = useReactTable({
    data: visible,
    columns: COLUMNS,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
    meta: {
      categories,
      persons,
      splitsByTransaction,
      defaultParticipantIds,
      receiptsByTransaction,
      sort,
      onSort: (columnId) =>
        apply(sortPatch(nextSort(sort, columnId, EXPENSES_SORT), EXPENSES_SORT)),
      selection: {
        has: (id) => selected.has(id),
        toggleRow,
        allChecked: visible.length > 0 && selectedIds.length === visible.length,
        anyChecked: selectedIds.length > 0,
        toggleAll,
      },
    } satisfies TableMeta,
  });

  // Grouped rendering pulls rows out of flat order, so look them up by id.
  const rowById = new Map(table.getRowModel().rows.map((row) => [row.id, row]));

  const renderRow = (row: Row<TransactionRow>) => {
    const expanded = expandedId === row.id;
    const toggle = () => toggleExpanded(row.original.id);
    return (
      <Fragment key={row.id}>
        <tr
          id={`tx-${row.original.id}`}
          tabIndex={0}
          aria-expanded={expanded}
          onClick={(e) => {
            // The row is the expansion affordance, but embedded
            // controls (category select, split badge) and text
            // selection must keep their own behavior.
            const target = e.target as HTMLElement;
            // [role="checkbox"] covers the Base UI Checkbox, which renders
            // a span, not a button.
            if (
              target.closest(
                'button, a, input, select, textarea, label, [role="checkbox"]',
              )
            ) {
              return;
            }
            if (window.getSelection()?.toString()) return;
            toggle();
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              toggle();
            }
          }}
          className={cn(
            'group/row cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/40',
            expanded && 'border-0 bg-muted/40',
            // Non-splittable rows (refunds/credits, Rent, Income) read
            // as ledger context, not splittable spending.
            !row.original.isSplittable && 'opacity-55 hover:opacity-100',
          )}
        >
          {row.getVisibleCells().map((cell) => (
            <td
              key={cell.id}
              className={cn(
                'px-3 py-1.5 align-middle',
                (cell.column.columnDef.meta as ColMeta | undefined)?.td,
              )}
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </td>
          ))}
        </tr>
        {expanded && (
          <tr className="border-b last:border-0">
            <td colSpan={COLUMNS.length} className="p-0">
              <TransactionDetailPanel
                row={row.original}
                split={splitsByTransaction[row.original.id] ?? null}
                receipt={receiptsByTransaction[row.original.id] ?? null}
                persons={persons}
                defaultParticipantIds={defaultParticipantIds}
                replacementCandidates={replacementCandidates[row.original.id] ?? []}
                creditByPerson={creditByPerson}
              />
            </td>
          </tr>
        )}
      </Fragment>
    );
  };

  if (data.length === 0) {
    return <EmptyState categories={categories} />;
  }

  return (
    <div className="space-y-2">
      <SourceTabs
        tabs={sourceTabs}
        active={sourceTab}
        onChange={(tab) => apply(sourceTabPatch(tab))}
      />
      <ExpenseFilterBar
        filters={filters}
        categories={categories}
        onChange={(next) => apply(filterPatch(next))}
      />
      <SummaryStrip
        summary={summary}
        reviewActive={filters.review === 'flagged'}
        onToggleReview={() =>
          apply(filterPatch({ ...filters, review: filters.review === 'flagged' ? 'all' : 'flagged' }))
        }
      />
      <div className="rounded-xl border bg-card">
        {/* table-fixed so the sized columns keep their widths and the
            description column absorbs only the remaining space (truncating
            instead of pushing the amount column past the card's right edge). */}
        <table className="w-full table-fixed text-[13px]">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    aria-sort={
                      sort.sort === header.column.id
                        ? sort.dir === 'asc'
                          ? 'ascending'
                          : 'descending'
                        : undefined
                    }
                    className={cn(
                      // Sticky under the h-12 site header; bg-card keeps rows
                      // from showing through while scrolled.
                      'sticky top-12 z-10 border-b bg-card px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-muted-foreground first:rounded-tl-xl last:rounded-tr-xl',
                      (header.column.columnDef.meta as ColMeta | undefined)?.th,
                    )}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {visible.length === 0 && groups === null && (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="px-3 py-12 text-center text-sm text-muted-foreground"
                >
                  {hasActiveFilters(filters)
                    ? 'No rows match the current filters.'
                    : sourceTab === 'all'
                      ? 'No rows in this view.'
                      : `No ${sourceTab} rows yet.`}
                </td>
              </tr>
            )}
            {groups === null
              ? table.getRowModel().rows.map(renderRow)
              : groups.map((group) => (
                  <Fragment key={group.key}>
                    <ImportGroupHeader
                      group={group}
                      collapsed={collapsedGroups.has(group.key)}
                      onToggle={() => toggleGroup(group.key)}
                      onHide={group.imp ? () => hideImport(group.imp!.id) : undefined}
                      colSpan={COLUMNS.length}
                    />
                    {!collapsedGroups.has(group.key) &&
                      group.rows.length === 0 && (
                        <tr className="border-b last:border-0">
                          <td
                            colSpan={COLUMNS.length}
                            className="px-8 py-3 text-xs text-muted-foreground"
                          >
                            {hasActiveFilters(filters)
                              ? `No rows in this ${group.account ? 'account' : 'import'} match the current filters.`
                              : group.account
                                ? 'Nothing synced from this account yet.'
                                : 'All rows in this import have been deleted.'}
                          </td>
                        </tr>
                      )}
                    {!collapsedGroups.has(group.key) &&
                      group.rows.map((dataRow) => {
                        const row = rowById.get(dataRow.id);
                        return row ? renderRow(row) : null;
                      })}
                  </Fragment>
                ))}
          </tbody>
        </table>
      </div>
      {hiddenImports.length > 0 && (
        <HiddenImportsStrip
          hidden={hiddenImports}
          onUnhide={unhideImport}
          onShowAll={() => run(showAllImports)}
        />
      )}
      {undoneImports.length > 0 && <UndoneImportsStrip undone={undoneImports} />}
      {selectedIds.length > 0 && (
        <BulkActionBar
          selectedIds={selectedIds}
          categories={categories}
          onClear={clearSelection}
        />
      )}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-xs text-muted-foreground">
        <span>click a row for details</span>
        <span className="flex items-center gap-1">
          <Zap className="size-3" aria-hidden />
          tag — set by a rule
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-muted-foreground" aria-hidden />
          dot — set manually
        </span>
        <span className="flex items-center gap-1">
          <SplitIcon className="size-3" aria-hidden />
          badge — split, with participant count
        </span>
        <span className="flex items-center gap-1">
          <ReceiptText className="size-3" aria-hidden />
          icon — receipt attached
        </span>
        <span>dimmed — not splittable (credits, rent, income)</span>
      </p>
    </div>
  );
}
