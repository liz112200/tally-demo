'use client';

import {
  useActionState,
  useEffect,
  useRef,
  useState,
  startTransition,
} from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { formatUSD } from '@/lib/money';
import type { Cents } from '@/lib/money';
import { previewImport, confirmImport } from '@/app/_actions/import';
import type { PreviewState, ConfirmState } from '@/app/_lib/schema';

const initialPreview: PreviewState = {};
const initialConfirm: ConfirmState = {};

export function ImportForm({ initialFile }: { initialFile?: File } = {}) {
  // The selected File is held in React state, not read from the form on submit.
  // React 19 resets an uncontrolled <form> after a form action runs, which would
  // clear the file input between the preview and confirm submits; keeping the
  // File here makes the same upload available to both actions. A preselected
  // file (the demo's sample statement) starts here and previews immediately.
  const [file, setFile] = useState<File | null>(initialFile ?? null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [previewState, dispatchPreview, previewPending] = useActionState(
    previewImport,
    initialPreview,
  );
  const [confirmState, dispatchConfirm, confirmPending] = useActionState(
    confirmImport,
    initialConfirm,
  );

  const preview = previewState.preview;
  const confirmed = confirmState.result;

  // Duplicate rows the user has ticked "include anyway", keyed by the row's
  // stable file index. Opt-in: every preview starts with none approved.
  const [approved, setApproved] = useState<Set<number>>(() => new Set());
  useEffect(() => {
    setApproved(new Set());
  }, [preview]);

  const duplicateRows = preview?.rows.filter((r) => r.duplicate !== null) ?? [];
  const allDuplicatesApproved =
    duplicateRows.length > 0 && duplicateRows.every((r) => approved.has(r.index));

  function toggleApproved(index: number) {
    setApproved((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleAllDuplicates() {
    setApproved(
      allDuplicatesApproved
        ? new Set()
        : new Set(duplicateRows.map((r) => r.index)),
    );
  }

  function buildFormData(): FormData {
    const fd = new FormData();
    if (file) fd.set('file', file);
    return fd;
  }

  function onPreview() {
    startTransition(() => dispatchPreview(buildFormData()));
  }

  function onConfirm() {
    const fd = buildFormData();
    if (approved.size > 0) {
      fd.set('approveDuplicates', [...approved].join(','));
    }
    startTransition(() => dispatchConfirm(fd));
  }

  useEffect(() => {
    if (initialFile) onPreview();
    // Once, on open: the preselected file is fixed for this form's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New rows always import; approved duplicates add to that count.
  const willImport = preview
    ? preview.newCount + [...approved].length
    : 0;

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="file">CSV file</Label>
        {initialFile && file === initialFile && (
          <p className="text-xs text-muted-foreground">
            Selected: <span className="font-mono">{initialFile.name}</span>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id="file"
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="max-w-sm"
          />
          <Button
            type="button"
            variant="outline"
            onClick={onPreview}
            disabled={!file || previewPending}
          >
            {previewPending ? 'Reading…' : 'Preview'}
          </Button>
        </div>
        {previewState.error && (
          <p className="text-sm text-destructive">{previewState.error}</p>
        )}
      </div>

      {preview && (
        <div className="grid gap-3">
          <div className="flex flex-wrap gap-x-5 gap-y-1 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
            <span>
              Bank{' '}
              <strong className="font-medium text-foreground uppercase">
                {preview.bank}
              </strong>
            </span>
            <span>
              Rows{' '}
              <strong className="font-mono font-medium text-foreground">
                {preview.rowCount}
              </strong>
            </span>
            {preview.dateRange && (
              <span>
                Dates{' '}
                <strong className="font-mono font-medium text-foreground">
                  {preview.dateRange.from} – {preview.dateRange.to}
                </strong>
              </span>
            )}
            <span>
              Auto-categorized{' '}
              <strong className="font-mono font-medium text-foreground">
                {preview.autoCategorized}
              </strong>
              , uncategorized{' '}
              <strong className="font-mono font-medium text-foreground">
                {preview.uncategorized}
              </strong>
            </span>
            <span>
              New{' '}
              <strong className="font-mono font-medium text-foreground">
                {preview.newCount}
              </strong>
              {preview.duplicateCount > 0 && (
                <>
                  , duplicates{' '}
                  <strong className="font-mono font-medium text-amber-600 dark:text-amber-500">
                    {preview.duplicateCount}
                  </strong>
                </>
              )}
            </span>
          </div>

          {preview.coveredCount > 0 && preview.coveredFrom && (
            <p className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
              <strong className="font-medium text-foreground">
                {preview.coveredCount} row{preview.coveredCount === 1 ? '' : 's'}
              </strong>{' '}
              dated {preview.coveredFrom} or later {preview.coveredCount === 1 ? 'is' : 'are'} already synced from the bank for
              this account, so {preview.coveredCount === 1 ? 'it is' : 'they are'} not imported: {preview.coveredCount === 1 ? 'it' : 'they'} would
              count twice.
            </p>
          )}

          {preview.duplicateCount > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
              <p className="text-muted-foreground">
                <strong className="font-medium text-foreground">
                  {preview.duplicateCount} duplicate
                  {preview.duplicateCount === 1 ? '' : 's'}
                </strong>{' '}
                already {preview.duplicateCount === 1 ? 'exists' : 'exist'} — a
                repeat of a live or deleted transaction. They are skipped
                unless you include them.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 text-xs"
                onClick={toggleAllDuplicates}
              >
                {allDuplicatesApproved ? 'Clear all' : 'Include all'}
              </Button>
            </div>
          )}

          <div className="max-h-72 overflow-y-auto overflow-x-auto rounded-lg border">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="sticky top-0 bg-card text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                  <th className="w-8 px-2 py-2 font-medium" aria-label="Include" />
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Description</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Account</th>
                  <th className="px-3 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => {
                  const isDuplicate = row.duplicate !== null;
                  const included = approved.has(row.index);
                  // A duplicate reads as excluded until ticked; a new row is
                  // always in and never dimmed.
                  const dimmed = isDuplicate && !included;
                  return (
                    <tr
                      key={row.index}
                      className={cn('border-t', dimmed && 'opacity-45')}
                    >
                      <td className="px-2 py-1.5 align-middle">
                        {isDuplicate && (
                          <Checkbox
                            checked={included}
                            onCheckedChange={() => toggleApproved(row.index)}
                            aria-label={`Include duplicate ${row.descriptionRaw}`}
                          />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 font-mono text-xs text-muted-foreground">
                        {row.date}
                      </td>
                      <td className="px-3 py-1.5">
                        <span>{row.descriptionRaw}</span>
                        {isDuplicate && (
                          <span
                            className="ml-2 whitespace-nowrap rounded border border-amber-500/50 px-1 py-px text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-500"
                            title={
                              row.duplicate === 'deleted'
                                ? 'Matches a transaction you deleted'
                                : 'Matches an existing transaction'
                            }
                          >
                            dup{row.duplicate === 'deleted' ? ' · deleted' : ''}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        {row.category ? (
                          row.category
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        {row.accountLabel ?? '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono">
                        {formatUSD(row.amountCents as Cents)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {preview.rowCount > preview.rows.length && (
            <p className="text-xs text-muted-foreground">
              Showing first {preview.rows.length} of {preview.rowCount} rows.
              Duplicates beyond this preview can&rsquo;t be selected and are
              skipped.
            </p>
          )}

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={onConfirm}
              disabled={confirmPending || willImport === 0}
            >
              {confirmPending ? 'Importing…' : `Confirm import (${willImport})`}
            </Button>
            {confirmState.error && (
              <p className="text-sm text-destructive">{confirmState.error}</p>
            )}
            {confirmed && (
              <p className="text-sm text-muted-foreground">
                Inserted {confirmed.inserted}
                {confirmed.forced > 0 &&
                  `, included ${confirmed.forced} duplicate${
                    confirmed.forced === 1 ? '' : 's'
                  }`}
                , skipped {confirmed.skipped} duplicate
                {confirmed.skipped === 1 ? '' : 's'}
                {confirmed.covered > 0 &&
                  `, left out ${confirmed.covered} already synced from the bank`}
                .
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
