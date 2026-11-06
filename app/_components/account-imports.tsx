'use client';

import { useActionState, useEffect, useState } from 'react';
import { Eye, EyeOff, Pencil, RotateCcw, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/app/_components/confirm-dialog';
import { renameImport, restoreImport, setImportHidden, undoImport } from '@/app/_actions/import';
import { IMPORT_NAME_MAX, type RenameImportState } from '@/app/_lib/schema';
import { importGroupLabel, type ImportGroupMeta, type UndoneImport } from '@/lib/import-groups';
import { useAction } from './page-result';

const initialRenameState: RenameImportState = {};

// Click-to-rename the import's display label, inline in its row (same
// pattern as the phase-7 editable transaction fields).
function ImportNameEditor({ importId, label }: { importId: string; label: string }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState(
    renameImport,
    initialRenameState,
  );

  useEffect(() => {
    if (state.ok) setEditing(false);
  }, [state]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="group/name flex items-center gap-1 rounded px-1 py-0.5 font-medium text-foreground hover:bg-muted/70"
        title="Rename import"
      >
        {label}
        <Pencil className="size-2.5 opacity-0 transition-opacity group-hover/name:opacity-60" aria-hidden />
      </button>
    );
  }

  return (
    <form action={formAction} className="flex items-center gap-1">
      <input type="hidden" name="importId" value={importId} />
      <input
        name="displayName"
        defaultValue={label}
        autoFocus
        maxLength={IMPORT_NAME_MAX}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
        aria-label="Import name"
        className="h-6 w-52 rounded border border-input bg-background px-1.5 text-[11px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 dark:bg-input/30"
      />
      <Button type="submit" size="sm" className="h-6 px-1.5 text-[11px]" disabled={pending}>
        {pending ? 'Saving…' : 'Save'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-[11px] text-muted-foreground"
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
      {state.error && <span className="text-destructive">{state.error}</span>}
    </form>
  );
}

// Confirmation before the soft-delete cascade: the batch and every
// transaction in it stop counting everywhere, including balances. Reversible
// with Restore in the same Imports section (restoreImport), which is the
// recovery path; re-importing the same file is not, since it inserts
// dedup-exempt copies with none of the original splits attached.
function UndoImportDialog({
  importId,
  label,
  batchSize,
  restoreFrom,
}: {
  importId: string;
  label: string;
  batchSize: number;
  // Where this page offers Restore, so the dialog names the real place.
  restoreFrom: string;
}) {
  const plural = batchSize === 1 ? '' : 's';
  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 px-2 text-xs hover:text-destructive"
        >
          <Undo2 data-icon="inline-start" />
          Undo import
        </Button>
      }
      title={`Delete all ${batchSize} row${plural} from this import?`}
      description={
        <>
          Everything imported from{' '}
          <span className="font-medium text-foreground">{label}</span> stops
          counting everywhere, including splits toward balances. You can
          restore it from {restoreFrom}.
        </>
      }
      confirmLabel={`Delete ${batchSize} row${plural}`}
      pendingLabel="Deleting…"
      onConfirm={async () => {
        const fd = new FormData();
        fd.set('importId', importId);
        return undoImport(fd);
      }}
    />
  );
}

// The uploads that fed one ledger account, on its page (the accounts board,
// 2026-11-05): batch management lives with the account, reading lives in
// Expenses. Live uploads can be renamed, hidden or undone; hidden ones shown
// again; undone ones restored. Nothing here changes a row's content: Hide is
// a view preference, Undo a reversible soft delete.
export function AccountImports({ live, undone }: { live: ImportGroupMeta[]; undone: UndoneImport[] }) {
  const { run, pending } = useAction();
  if (live.length === 0 && undone.length === 0) {
    return <p className="px-1 text-sm text-muted-foreground">No CSV uploads for this account.</p>;
  }
  const small = 'h-8 px-2 text-xs';
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {live.map((imp) => (
        <li key={imp.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1 basis-56">
            {imp.backfilled ? (
              <span className="font-medium">{importGroupLabel(imp)}</span>
            ) : (
              <ImportNameEditor importId={imp.id} label={importGroupLabel(imp)} />
            )}
            <span className="ml-1 text-xs text-muted-foreground">
              {imp.rowCount} {imp.rowCount === 1 ? 'row' : 'rows'} · imported {imp.importedAt}
            </span>
          </span>
          {imp.hidden && (
            <span className="rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">hidden from Expenses</span>
          )}
          <span className="flex gap-1">
            {imp.hidden ? (
              <Button type="button" variant="outline" size="sm" className={small} disabled={pending} onClick={() => run(() => setImportHidden(imp.id, false))}>
                <Eye data-icon="inline-start" />
                Show
              </Button>
            ) : (
              <Button type="button" variant="outline" size="sm" className={small} disabled={pending} onClick={() => run(() => setImportHidden(imp.id, true))}>
                <EyeOff data-icon="inline-start" />
                Hide
              </Button>
            )}
            {!imp.backfilled && (
              <UndoImportDialog importId={imp.id} label={importGroupLabel(imp)} batchSize={imp.rowCount} restoreFrom="this account's Imports section" />
            )}
          </span>
        </li>
      ))}
      {undone.map((imp) => (
        <li key={imp.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm text-muted-foreground">
          <span className="min-w-0 flex-1 basis-56">
            <span className="font-medium text-foreground">{importGroupLabel(imp)}</span>
            <span className="ml-1 text-xs">
              {imp.restorableCount} {imp.restorableCount === 1 ? 'row' : 'rows'} to restore · undone {imp.deletedOn}
            </span>
          </span>
          <span className="rounded-full border bg-muted px-2 py-0.5 text-[11px] font-medium">undone</span>
          <Button type="button" variant="outline" size="sm" className={small} disabled={pending} onClick={() => run(() => restoreImport(imp.id))}>
            <RotateCcw data-icon="inline-start" />
            Restore
          </Button>
        </li>
      ))}
    </ul>
  );
}
