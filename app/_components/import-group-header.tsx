'use client';

import { useActionState, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, EyeOff, Pencil, Undo2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/app/_components/confirm-dialog';
import { renameImport, undoImport } from '@/app/_actions/import';
import { IMPORT_NAME_MAX, type RenameImportState } from '@/app/_lib/schema';
import { importGroupLabel, type RowGroup } from '@/lib/import-groups';

const initialRenameState: RenameImportState = {};

// Click-to-rename the import's display label, inline in the header (same
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
// from the undone-imports strip (restoreImport), which is the recovery path —
// re-importing the same file is not, since it inserts dedup-exempt copies
// with none of the original splits attached.
function UndoImportDialog({
  importId,
  label,
  batchSize,
}: {
  importId: string;
  label: string;
  batchSize: number;
}) {
  const plural = batchSize === 1 ? '' : 's';
  return (
    <ConfirmDialog
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-destructive"
        >
          <Undo2 data-icon="inline-start" />
          Undo import
        </Button>
      }
      title={`Delete all ${batchSize} transaction${plural} from this import?`}
      description={
        <>
          Everything imported from{' '}
          <span className="font-medium text-foreground">{label}</span> stops
          counting everywhere, including splits toward balances. You can
          restore it from the undone-imports strip below the table.
        </>
      }
      confirmLabel={`Delete ${batchSize} transaction${plural}`}
      pendingLabel="Deleting…"
      onConfirm={async () => {
        const fd = new FormData();
        fd.set('importId', importId);
        await undoImport(fd);
      }}
    />
  );
}

// A batch's header row inside the transaction table: collapse toggle,
// label, batch facts, and the undo affordance. The ungrouped section
// (manual entries) gets the same chrome minus the import-specific bits.
export function ImportGroupHeader<T>({
  group,
  collapsed,
  onToggle,
  onHide,
  colSpan,
}: {
  group: RowGroup<T>;
  collapsed: boolean;
  onToggle: () => void;
  // Absent for the ungrouped (manual) section, which cannot be hidden.
  onHide?: () => void;
  colSpan: number;
}) {
  const imp = group.imp;
  const label = imp ? importGroupLabel(imp) : 'Ungrouped';
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <tr className="border-b bg-muted/25">
      <td colSpan={colSpan} className="px-2 py-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand import' : 'Collapse import'}
            className="flex items-center rounded p-0.5 hover:bg-muted/70"
          >
            <Chevron className="size-3.5 text-muted-foreground" aria-hidden />
          </button>
          {imp ? (
            <ImportNameEditor importId={imp.id} label={label} />
          ) : (
            <span className="px-1 font-medium text-foreground">{label}</span>
          )}
          {imp?.backfilled && (
            <span className="rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide">
              backfilled
            </span>
          )}
          {imp && (
            <span className="rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide">
              {imp.source}
            </span>
          )}
          {!imp && <span>manual entries</span>}
          {group.batchDates && (
            <span className="font-mono">
              {group.batchDates.from} – {group.batchDates.to}
            </span>
          )}
          <span>
            <span className="font-mono">{group.batchSize}</span>{' '}
            {group.batchSize === 1 ? 'row' : 'rows'}
            {group.rows.length !== group.batchSize && (
              <span>
                {' '}
                (<span className="font-mono">{group.rows.length}</span> shown)
              </span>
            )}
          </span>
          {imp && (
            <span className={cn(imp.backfilled && 'italic')}>
              uploaded <span className="font-mono">{imp.importedAt}</span>
            </span>
          )}
          {imp && (
            <span className="ml-auto flex items-center gap-0.5">
              {onHide && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onHide}
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  title="Hide this import from the list"
                >
                  <EyeOff data-icon="inline-start" />
                  Hide
                </Button>
              )}
              <UndoImportDialog
                importId={imp.id}
                label={label}
                batchSize={group.batchSize}
              />
            </span>
          )}
        </div>
      </td>
    </tr>
  );
}
