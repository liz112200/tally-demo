'use server';

import { revalidatePath } from 'next/cache';
import { parseDollars } from '@/lib/money';
import {
  deleteExternalSplit,
  getPersons,
  insertExternalExpense,
} from '@/db/queries';
import {
  externalExpenseSchema,
  type ExternalExpenseFormState,
} from '@/app/_lib/schema';

// Log an expense someone else paid that the owner owes a share of. Creates an
// external split (no bank transaction) with the payer set to that person and a
// single owner share; any outgoing credit the owner already holds toward them
// auto-applies. External splits live only on /people (fork 3), so only that
// page revalidates.
export async function createExternalExpense(
  _prev: ExternalExpenseFormState,
  formData: FormData,
): Promise<ExternalExpenseFormState> {
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

  await insertExternalExpense({
    payerPersonId: payer.id,
    ownerId: owner.id,
    amountCents: parseDollars(parsed.data.amount),
    date: parsed.data.date,
    description: parsed.data.description,
  });

  revalidatePath('/people');
  return { ok: true };
}

// Hard-delete an external split (no bank transaction to soft-delete through).
// Its share and any settlement allocations against it cascade; the deleted
// amount returns to the settlement's unallocated credit pool.
export async function deleteExternalExpense(splitId: string): Promise<void> {
  if (typeof splitId !== 'string' || splitId.length === 0) return;
  await deleteExternalSplit(splitId);
  revalidatePath('/people');
}
