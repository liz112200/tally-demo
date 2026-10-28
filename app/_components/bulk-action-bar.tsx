'use client';

import { useEffect, useState, useTransition } from 'react';
import { Tag, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { UNCATEGORIZED } from '@/app/_lib/schema';
import { categoryColorVar } from '@/app/_components/category-tag';
import { ConfirmDialog } from '@/app/_components/confirm-dialog';
import {
  bulkCategorizeTransactions,
  bulkDeleteTransactions,
} from '@/app/_actions/transactions';

type Category = { id: string; name: string };

// Floating bar that appears while rows are selected: count, actions, and
// dismissal (the Clear button or Escape). Rendered only when the selection
// is non-empty, so it never needs a hidden state of its own.
export function BulkActionBar({
  selectedIds,
  categories,
  onClear,
}: {
  selectedIds: string[];
  categories: Category[];
  onClear: () => void;
}) {
  const [pending, startTransition] = useTransition();
  // The categorize Select acts as a one-shot menu (fork 2): picking a
  // category applies it to the whole selection immediately, and the value
  // snaps back to the placeholder.
  const [pickedCategory, setPickedCategory] = useState<string | null>(null);
  // A refusal from the server, shown in the bar until the next action.
  const [error, setError] = useState<string | null>(null);
  const count = selectedIds.length;
  const plural = count === 1 ? '' : 's';

  // Escape dismisses the selection — unless something above (an open
  // dialog, a select popup) already handled the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClear]);

  // The dialog stays up with its pending label until the delete settles;
  // selection clears only once it succeeded (onDone).
  const onDelete = () => bulkDeleteTransactions(selectedIds);

  const onCategorize = (value: string | null) => {
    if (value === null) return;
    setPickedCategory(value);
    const categoryId = value === UNCATEGORIZED ? null : value;
    startTransition(async () => {
      const result = await bulkCategorizeTransactions(selectedIds, categoryId);
      setError(result.error ?? null);
      setPickedCategory(null);
    });
  };

  return (
    <div className="fixed bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-xl border bg-card px-3 py-1.5 shadow-lg animate-in fade-in-0 slide-in-from-bottom-2">
      {error && (
        <p
          role="alert"
          className="absolute bottom-full left-1/2 mb-2 w-max max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-md border bg-card px-2.5 py-1.5 text-xs text-destructive shadow-sm"
        >
          {error}
        </p>
      )}
      <span className="pr-1 text-xs text-muted-foreground">
        <span className="font-mono font-medium text-foreground">{count}</span>{' '}
        selected
      </span>
      <Select value={pickedCategory} onValueChange={onCategorize} disabled={pending}>
        <SelectTrigger
          size="sm"
          aria-label="Categorize selected rows"
          className="h-7 text-xs"
        >
          <span className="flex items-center gap-1.5">
            <Tag className="size-3" aria-hidden />
            Categorize as…
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNCATEGORIZED}>
            <span className="text-xs text-muted-foreground">Uncategorized</span>
          </SelectItem>
          {categories.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              <span className="flex items-center gap-2 text-xs">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: categoryColorVar(c.name) }}
                />
                {c.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ConfirmDialog
        trigger={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            disabled={pending}
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </Button>
        }
        title={`Delete ${count} row${plural}?`}
        description="Splits on them stop counting toward balances. Dedup entries stay, so a re-import will not bring them back."
        confirmLabel={`Delete ${count} row${plural}`}
        pendingLabel="Deleting…"
        onConfirm={onDelete}
        onDone={onClear}
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground"
        onClick={onClear}
      >
        <X data-icon="inline-start" />
        Clear
      </Button>
    </div>
  );
}
