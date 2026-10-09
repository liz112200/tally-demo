'use client';

import { useActionState, useEffect, useState } from 'react';
import { Pencil, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatCents, toCents } from '@/lib/money';
import type { TransactionRow } from '@/db/queries';
import {
  updateTransactionDetails,
  type UpdateTransactionDetailsState,
} from '@/app/_actions/transactions';

const initialState: UpdateTransactionDetailsState = {};

// Inline editor for an expanded row's description / amount / date. The
// caller renders the static view; this block is the toggle plus the form.
// Category and source have their own affordances and stay out of here.
export function EditTransactionForm({
  row,
  hasSplit,
  onClose,
}: {
  row: TransactionRow;
  hasSplit: boolean;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    updateTransactionDetails,
    initialState,
  );

  // Close on save; the revalidated row re-renders underneath.
  useEffect(() => {
    if (state.ok) onClose();
  }, [state, onClose]);

  return (
    <form action={formAction} className="max-w-xl space-y-3">
      <input type="hidden" name="id" value={row.id} />
      <div className="grid gap-3 sm:grid-cols-[10rem_8rem]">
        <div className="grid gap-1">
          <Label htmlFor={`edit-date-${row.id}`} className="text-xs">
            Date
          </Label>
          <Input
            id={`edit-date-${row.id}`}
            name="date"
            type="date"
            defaultValue={row.date}
            className="h-7 font-mono text-xs"
          />
          {state.errors?.date && (
            <p className="text-xs text-destructive">{state.errors.date}</p>
          )}
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`edit-amount-${row.id}`} className="text-xs">
            Amount
          </Label>
          <Input
            id={`edit-amount-${row.id}`}
            name="amount"
            inputMode="decimal"
            defaultValue={formatCents(toCents(row.amountCents))}
            className="h-7 font-mono text-xs"
          />
          {state.errors?.amount && (
            <p className="text-xs text-destructive">{state.errors.amount}</p>
          )}
        </div>
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`edit-description-${row.id}`} className="text-xs">
          Description
        </Label>
        <Input
          id={`edit-description-${row.id}`}
          name="description"
          defaultValue={row.descriptionRaw}
          className="h-7 text-xs"
        />
        {state.errors?.description && (
          <p className="text-xs text-destructive">{state.errors.description}</p>
        )}
      </div>
      {hasSplit && (
        <p className="flex items-start gap-1.5 text-xs text-primary">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          Changing this amount may invalidate the split. Review the split
          after saving.
        </p>
      )}
      <div className="flex items-center gap-1.5">
        <Button type="submit" size="sm" className="h-6.5 text-xs" disabled={pending}>
          {pending ? 'Saving…' : 'Save'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6.5 text-xs text-muted-foreground"
          onClick={onClose}
          disabled={pending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function EditDetailsButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6.5 text-xs"
      onClick={onClick}
    >
      <Pencil data-icon="inline-start" />
      Edit details
    </Button>
  );
}
