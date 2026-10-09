'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { Pencil, Plus, StickyNote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { updateTransactionNote } from '@/app/_actions/transactions';
import { TRANSACTION_NOTE_MAX, type UpdateNoteState } from '@/app/_lib/schema';

const initialState: UpdateNoteState = {};

// The note section of an expanded row: shows the note when set, an inline
// textarea while editing. Saving an empty note clears it. Independent of
// the core-field edit form, so annotating never risks the amount/split.
export function NoteBlock({ transactionId, note }: { transactionId: string; note: string | null }) {
  const [editing, setEditing] = useState(false);
  const [state, formAction, pending] = useActionState(
    updateTransactionNote,
    initialState,
  );

  // Close on a successful save; the revalidated row supplies the new text.
  useEffect(() => {
    if (state.ok) setEditing(false);
  }, [state]);

  if (editing) {
    return (
      <form action={formAction} className="space-y-1.5">
        <input type="hidden" name="id" value={transactionId} />
        <textarea
          name="note"
          defaultValue={note ?? ''}
          maxLength={TRANSACTION_NOTE_MAX}
          rows={3}
          autoFocus
          placeholder="Add a note for this transaction…"
          className="w-full resize-y rounded-md border border-input bg-transparent px-2 py-1.5 text-xs outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        />
        {state.error && <p className="text-xs text-destructive">{state.error}</p>}
        <div className="flex items-center gap-1.5">
          <Button type="submit" size="sm" className="h-6.5 text-xs" disabled={pending}>
            {pending ? 'Saving…' : 'Save note'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6.5 text-xs text-muted-foreground"
            onClick={() => setEditing(false)}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }

  if (!note) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6.5 text-xs"
        onClick={() => setEditing(true)}
      >
        <Plus data-icon="inline-start" />
        Add note
      </Button>
    );
  }

  return (
    <div className="space-y-1.5">
      <p className="whitespace-pre-wrap break-words text-[13px] text-foreground/90">
        {note}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-6.5 text-xs"
        onClick={() => setEditing(true)}
      >
        <Pencil data-icon="inline-start" />
        Edit note
      </Button>
    </div>
  );
}

// Collapsed-row presence indicator, matching the receipt icon's grammar.
export function NoteIndicator() {
  return <StickyNote className="size-3 text-primary/70" aria-label="Has a note" />;
}
