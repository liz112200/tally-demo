'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { HandCoins } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { createExternalExpense } from '@/app/_actions/external-expenses';
import type { ExternalExpenseFormState } from '@/app/_lib/schema';

const initialState: ExternalExpenseFormState = {};

// "Log expense you paid": records an expense a person paid that the owner owes
// a share of, creating an external split (no bank transaction). Reused by the
// /people expanded view. `personName` is only for labeling; the payer is bound
// by the hidden personId field.
export function ExternalExpenseDialog({
  personId,
  personName,
  today,
  trigger,
}: {
  personId: string;
  personName: string;
  today: string;
  trigger: React.ReactElement<Record<string, unknown>>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Log an expense you paid</DialogTitle>
          <DialogDescription>
            Record something {personName} paid for that you owe them a share of.
            It shows up here under what you owe them, not on Expenses.
          </DialogDescription>
        </DialogHeader>
        {open && (
          <ExternalExpenseForm
            personId={personId}
            personName={personName}
            today={today}
            onSaved={() => setOpen(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ExternalExpenseForm({
  personId,
  personName,
  today,
  onSaved,
}: {
  personId: string;
  personName: string;
  today: string;
  onSaved: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    createExternalExpense,
    initialState,
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.ok) onSaved();
  }, [state, onSaved]);

  return (
    <form ref={formRef} action={formAction} className="grid gap-3">
      <input type="hidden" name="payerPersonId" value={personId} />
      <div className="grid gap-1.5">
        <Label htmlFor={`ext-amount-${personId}`} className="text-xs text-muted-foreground">
          Amount you owe {personName}
        </Label>
        <div className="relative">
          <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-muted-foreground">
            $
          </span>
          <Input
            id={`ext-amount-${personId}`}
            name="amount"
            placeholder="0.00"
            autoFocus
            className="pl-6 text-right font-mono"
          />
        </div>
        {state.errors?.amount && (
          <p className="text-xs text-destructive">{state.errors.amount}</p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`ext-desc-${personId}`} className="text-xs text-muted-foreground">
          Description
        </Label>
        <Input
          id={`ext-desc-${personId}`}
          name="description"
          placeholder="e.g. Dinner at Nopa"
        />
        {state.errors?.description && (
          <p className="text-xs text-destructive">{state.errors.description}</p>
        )}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`ext-date-${personId}`} className="text-xs text-muted-foreground">
          Date
        </Label>
        <Input
          id={`ext-date-${personId}`}
          name="date"
          type="date"
          defaultValue={today}
          className="font-mono"
        />
        {state.errors?.date && (
          <p className="text-xs text-destructive">{state.errors.date}</p>
        )}
      </div>
      {state.errors?.payerPersonId && (
        <p className="text-xs text-destructive">{state.errors.payerPersonId}</p>
      )}
      <Button type="submit" disabled={pending} className="justify-self-end">
        <HandCoins data-icon="inline-start" />
        {pending ? 'Saving…' : 'Log expense'}
      </Button>
    </form>
  );
}
