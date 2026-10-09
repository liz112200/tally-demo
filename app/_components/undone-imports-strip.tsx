'use client';

import { useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { restoreImport } from '@/app/_actions/import';
import { importGroupLabel, type ImportGroupMeta } from '@/lib/import-groups';

// An undone import, as the strip needs it. Undo is a soft delete, so the
// batch and its rows are still in the database — this is what makes them
// recoverable rather than requiring a re-import (which would insert
// dedup-exempt copies carrying none of the original splits).
export type UndoneImport = ImportGroupMeta & {
  // Date the batch was undone (YYYY-MM-DD).
  deletedOn: string;
  // Rows this restore would bring back — those the undo itself deleted, not
  // ones already deleted individually beforehand.
  restorableCount: number;
};

// The restore surface below the table, mirroring HiddenImportsStrip:
// collapsed it is a single "N undone import(s)" button, expanded it lists
// each with a Restore button. Only rendered when a batch has been undone.
export function UndoneImportsStrip({ undone }: { undone: UndoneImport[] }) {
  const [open, setOpen] = useState(false);
  const count = undone.length;

  return (
    <div className="rounded-xl border border-dashed bg-muted/20 px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <History className="size-3.5" aria-hidden />
        {open
          ? 'Undone imports'
          : `${count} undone import${count === 1 ? '' : 's'} — restore`}
      </button>
      {open && (
        <ul className="mt-2 flex flex-col gap-1.5 border-t border-dashed pt-2">
          {undone.map((imp) => (
            <li key={imp.id} className="flex items-center gap-2 text-xs">
              <span className="font-medium text-foreground">
                {importGroupLabel(imp)}
              </span>
              <span className="rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {imp.source}
              </span>
              <span className="text-muted-foreground">
                {imp.restorableCount} row{imp.restorableCount === 1 ? '' : 's'} ·
                undone {imp.deletedOn}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-6 shrink-0 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => restoreImport(imp.id)}
              >
                <RotateCcw data-icon="inline-start" />
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
