'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  createTransaction,
  type CreateTransactionState,
} from '@/app/_actions/transactions';
import { UNCATEGORIZED } from '@/app/_lib/schema';

type Category = { id: string; name: string };

const initialState: CreateTransactionState = {};

export function AddTransactionForm({
  categories,
  onSuccess,
}: {
  categories: Category[];
  onSuccess?: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    createTransaction,
    initialState,
  );
  const [categoryId, setCategoryId] = useState(UNCATEGORIZED);
  const formRef = useRef<HTMLFormElement>(null);
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      setCategoryId(UNCATEGORIZED);
      onSuccess?.();
    }
  }, [state, onSuccess]);

  const categoryItems: Record<string, string> = {
    [UNCATEGORIZED]: 'Uncategorized',
    ...Object.fromEntries(categories.map((c) => [c.id, c.name])),
  };

  return (
    <form ref={formRef} action={formAction} className="grid gap-4 sm:grid-cols-2">
      <div className="grid gap-1.5">
        <Label htmlFor="date">Date</Label>
        <Input id="date" name="date" type="date" defaultValue={today} />
        {state.errors?.date && (
          <p className="text-xs text-destructive">{state.errors.date}</p>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="amount">Amount</Label>
        <Input
          id="amount"
          name="amount"
          inputMode="decimal"
          placeholder="12.34"
          className="font-mono"
        />
        {state.errors?.amount && (
          <p className="text-xs text-destructive">{state.errors.amount}</p>
        )}
      </div>

      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor="description">Description</Label>
        <Input
          id="description"
          name="description"
          placeholder="Merchant or note"
        />
        {state.errors?.description && (
          <p className="text-xs text-destructive">{state.errors.description}</p>
        )}
      </div>

      <div className="grid gap-1.5 sm:col-span-2">
        <Label htmlFor="note">Note (optional)</Label>
        <Input id="note" name="note" placeholder="A reminder for later" />
        {state.errors?.note && (
          <p className="text-xs text-destructive">{state.errors.note}</p>
        )}
      </div>

      <div className="grid gap-1.5">
        <Label>Category</Label>
        <input type="hidden" name="categoryId" value={categoryId} />
        <Select
          items={categoryItems}
          value={categoryId}
          onValueChange={(v) => setCategoryId(v ?? UNCATEGORIZED)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={UNCATEGORIZED}>Uncategorized</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-end justify-end">
        <Button type="submit" disabled={pending}>
          {pending ? 'Adding…' : 'Add transaction'}
        </Button>
      </div>
    </form>
  );
}
