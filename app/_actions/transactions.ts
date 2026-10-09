'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { parseDollars } from '@/lib/money';
import {
  bulkUpdateTransactionCategory,
  insertTransaction,
  softDeleteTransactionById,
  softDeleteTransactionsByIds,
  updateTransactionCategory as dbUpdateCategory,
  updateTransactionDetailsById,
  updateTransactionNoteById,
} from '@/db/queries';
import {
  bulkTransactionIdsSchema,
  createTransactionSchema,
  sentinelToCategoryId,
  updateCategorySchema,
  updateTransactionDetailsSchema,
  updateTransactionNoteSchema,
  type UpdateNoteState,
} from '@/app/_lib/schema';

// First message per field, for useActionState error display.
function fieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && !(key in errors)) {
      errors[key] = issue.message;
    }
  }
  return errors;
}

export type CreateTransactionState = {
  errors?: Record<string, string>;
  ok?: boolean;
};

export async function createTransaction(
  _prev: CreateTransactionState,
  formData: FormData,
): Promise<CreateTransactionState> {
  const parsed = createTransactionSchema.safeParse({
    date: formData.get('date'),
    amount: formData.get('amount'),
    description: formData.get('description'),
    categoryId: sentinelToCategoryId(formData.get('categoryId') as string | null),
    note: formData.get('note') ?? '',
  });

  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  await insertTransaction({
    date: parsed.data.date,
    amountCents: parseDollars(parsed.data.amount),
    descriptionRaw: parsed.data.description,
    categoryId: parsed.data.categoryId,
    note: parsed.data.note,
  });

  revalidatePath('/');
  return { ok: true };
}

// Set or clear a transaction's note from the row detail. Notes never touch
// balances, so only the Expenses view revalidates.
export async function updateTransactionNote(
  _prev: UpdateNoteState,
  formData: FormData,
): Promise<UpdateNoteState> {
  const parsed = updateTransactionNoteSchema.safeParse({
    id: formData.get('id'),
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid note' };
  }
  await updateTransactionNoteById(parsed.data.id, parsed.data.note);
  revalidatePath('/');
  return { ok: true };
}

export type UpdateTransactionDetailsState = {
  errors?: Record<string, string>;
  ok?: boolean;
};

// Inline edit of description / amount / date from the expanded row. The
// dedup_hash stays as imported (trusted post-hoc, see CLAUDE.md); a split
// on the row is NOT reconciled — the form warns instead. Amounts show in
// people's share history, so both views revalidate.
export async function updateTransactionDetails(
  _prev: UpdateTransactionDetailsState,
  formData: FormData,
): Promise<UpdateTransactionDetailsState> {
  const parsed = updateTransactionDetailsSchema.safeParse({
    id: formData.get('id'),
    date: formData.get('date'),
    amount: formData.get('amount'),
    description: formData.get('description'),
  });
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  await updateTransactionDetailsById(parsed.data.id, {
    date: parsed.data.date,
    amountCents: parseDollars(parsed.data.amount),
    descriptionRaw: parsed.data.description,
  });

  revalidatePath('/');
  revalidatePath('/people');
  return { ok: true };
}

export async function updateTransactionCategory(
  id: string,
  categoryId: string | null,
): Promise<void> {
  const parsed = updateCategorySchema.parse({ id, categoryId });
  await dbUpdateCategory(parsed.id, parsed.categoryId);
  revalidatePath('/');
}

// Bulk categorize for the selection action bar. Applying a category marks
// every row 'manual' (rules never overwrite them afterward); clearing sets
// the rows back to NULL, re-opening them to rules.
export async function bulkCategorizeTransactions(
  ids: string[],
  categoryId: string | null,
): Promise<void> {
  const parsed = bulkTransactionIdsSchema.parse(ids);
  const parsedCategory = z.string().uuid().nullable().parse(categoryId);
  await bulkUpdateTransactionCategory(parsed, parsedCategory);
  revalidatePath('/');
}

// Bulk soft delete for the selection action bar. Same mechanism as the
// single delete: balances change when any selected row carried a split, so
// both views revalidate.
export async function bulkDeleteTransactions(ids: string[]): Promise<void> {
  const parsed = bulkTransactionIdsSchema.parse(ids);
  await softDeleteTransactionsByIds(parsed);
  revalidatePath('/');
  revalidatePath('/people');
}

// Soft delete. Balances change too when the transaction carried a split,
// so both views revalidate.
export async function deleteTransaction(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string' || id.length === 0) return;
  await softDeleteTransactionById(id);
  revalidatePath('/');
  revalidatePath('/people');
}
