'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { importGroupLabel, type ImportGroupMeta } from '@/lib/import-groups';

// The unhide surface below the table. Collapsed, it is a single "Show N
// hidden imports" button; expanded, it lists each hidden import with a
// checkbox that unhides it (bringing its header and rows back). Only
// rendered when at least one import is hidden.
export function HiddenImportsStrip({
  hidden,
  onUnhide,
  onShowAll,
}: {
  hidden: ImportGroupMeta[];
  onUnhide: (id: string) => void;
  onShowAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = hidden.length;

  return (
    <div className="rounded-xl border border-dashed bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <EyeOff className="size-3.5" aria-hidden />
          {open ? 'Hidden imports' : `Show ${count} hidden import${count === 1 ? '' : 's'}`}
        </button>
        {open && count > 1 && (
          <button
            type="button"
            onClick={onShowAll}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Show all
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-dashed pt-2">
          {hidden.map((imp) => (
            <li key={imp.id}>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                {/* Ticking a hidden import shows it again. */}
                <Checkbox
                  checked={false}
                  onCheckedChange={() => onUnhide(imp.id)}
                  aria-label={`Show ${importGroupLabel(imp)}`}
                />
                <span className="font-medium text-foreground">
                  {importGroupLabel(imp)}
                </span>
                <span className="rounded border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {imp.source}
                </span>
                <Eye className="ml-auto size-3 text-muted-foreground/60" aria-hidden />
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
