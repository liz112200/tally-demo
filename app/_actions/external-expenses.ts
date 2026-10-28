'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { formatUSD, parseDollars, toCents } from '@/lib/money';
import {
  deleteExternalSplit,
  getPersons,
  insertExternalExpense,
} from '@/db/queries';
import {
  externalExpenseSchema,
  type ExternalExpenseFormState,
} from '@/app/_lib/schema';
import { requireUser } from '@/app/_lib/session';

// Log an expense someone else paid that the owner owes a share of. Creates an
// external split (no bank transaction) with the payer set to that person and a
// single owner share; any outgoing credit the owner already holds toward them
// auto-applies. External splits live only on /people (fork 3), so only that
// page revalidates.
export async function createExternalExpense(
  _prev: ExternalExpenseFormState,
  formData: FormData,
): Promise<ExternalExpenseFormState> {
  await requireUser();
  const parsed = externalExpenseSchema.safeParse({
    payerPersonId: formData.get('payerPersonId'),
    amount: formData.get('amount'),
    date: formData.get('date'),
    description: formData.get('description'),
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !(key in errors)) errors[key] = issue.message;
    }
    return { errors };
  }

  const persons = await getPersons();
  const owner = persons.find((p) => p.isOwner);
  if (!owner) return { errors: { payerPersonId: 'Owner person missing' } };
  const payer = persons.find((p) => p.id === parsed.data.payerPersonId);
  if (!payer) return { errors: { payerPersonId: 'That person no longer exists' } };
  // Fork 10: the owner can never be the external payer — that is just a normal
  // owner-paid split, entered from the Expenses table.
  if (payer.isOwner) {
    return {
      errors: {
        payerPersonId:
          'Pick someone else — an expense you paid yourself is a normal split on Expenses.',
      },
    };
  }

  const amountCents = parseDollars(parsed.data.amount);
  await insertExternalExpense({
    payerPersonId: payer.id,
    ownerId: owner.id,
    amountCents,
    date: parsed.data.date,
    description: parsed.data.description,
  });

  revalidatePath('/people');
  return { ok: true, message: `Expense saved: ${payer.name} paid ${formatUSD(toCents(amountCents))} for you.` };
}

// Hard-delete an external split (no bank transaction to soft-delete through).
// Its share and any settlement allocations against it cascade; the deleted
// amount returns to the settlement's unallocated credit pool.
export async function deleteExternalExpense(splitId: string): Promise<ActionResult> {
  await requireUser();
  const parsed = z.string().uuid().safeParse(splitId);
  if (!parsed.success) return { error: 'Invalid expense.' };
  return attempt('deleteExternalExpense', async () => {
    if (!(await deleteExternalSplit(parsed.data))) {
      return { error: 'That expense was not found; it may already be deleted.' };
    }
    revalidatePath('/people');
    return { ok: true, message: 'Expense deleted. Any payment applied to it is credit again.' };
  });
}
