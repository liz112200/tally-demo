'use server';

import { revalidatePath } from 'next/cache';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { z } from 'zod';
import { parseDollars } from '@/lib/money';
import {
  bulkUpdateTransactionCategory,
  hasLiveTwin,
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
import { requireUser } from '@/app/_lib/session';

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
  message?: string;
};

export async function createTransaction(
  _prev: CreateTransactionState,
  formData: FormData,
): Promise<CreateTransactionState> {
  await requireUser();
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

  const fields = {
    date: parsed.data.date,
    amountCents: parseDollars(parsed.data.amount),
    descriptionRaw: parsed.data.description,
    categoryId: parsed.data.categoryId,
    note: parsed.data.note,
  };
  // A row typed by hand is the owner's say-so. When the dedup index skips it
  // (an identical manual row exists, live or deleted), it goes in exempt,
  // as an approved duplicate does; it used to be dropped while this said
  // "Transaction added." A live twin is named, in case it was a slip.
  let message = 'Transaction added.';
  if (!(await insertTransaction(fields)).inserted) {
    const live = await hasLiveTwin({ source: 'manual', accountLabel: null, ...fields });
    await insertTransaction({ ...fields, dedupExempt: true });
    if (live) {
      message = 'Transaction added. You already had an identical row on that date (same amount and description); delete one if this was a slip.';
    }
  }

  revalidatePath('/');
  return { ok: true, message };
}

// Set or clear a transaction's note from the row detail. Notes never touch
// balances, so only the Expenses view revalidates.
export async function updateTransactionNote(
  _prev: UpdateNoteState,
  formData: FormData,
): Promise<UpdateNoteState> {
  await requireUser();
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

// Inline edit of description / amount / date from the expanded row, for CSV
// and manual rows only (synced rows are the bank's; the query refuses them).
// The dedup_hash stays as imported (trusted post-hoc, see CLAUDE.md); a split
// on the row is NOT reconciled — the form warns instead. Amounts show in
// people's share history, so both views revalidate.
export async function updateTransactionDetails(
  _prev: UpdateTransactionDetailsState,
  formData: FormData,
): Promise<UpdateTransactionDetailsState> {
  await requireUser();
  const parsed = updateTransactionDetailsSchema.safeParse({
    id: formData.get('id'),
    date: formData.get('date'),
    amount: formData.get('amount'),
    description: formData.get('description'),
  });
  if (!parsed.success) {
    return { errors: fieldErrors(parsed.error) };
  }

  const updated = await updateTransactionDetailsById(parsed.data.id, {
    date: parsed.data.date,
    amountCents: parseDollars(parsed.data.amount),
    descriptionRaw: parsed.data.description,
  });
  if (!updated) {
    return {
      errors: { description: 'Synced transactions follow the bank. Their note and category can still be changed.' },
    };
  }

  revalidatePath('/');
  revalidatePath('/people');
  return { ok: true };
}

export async function updateTransactionCategory(
  id: string,
  categoryId: string | null,
): Promise<{ error?: string }> {
  await requireUser();
  const parsed = updateCategorySchema.parse({ id, categoryId });
  const result = await dbUpdateCategory(parsed.id, parsed.categoryId);
  if ('error' in result) return { error: result.error };
  revalidatePath('/');
  return {};
}

// Bulk categorize for the selection action bar. Applying a category marks
// every row 'manual' (rules never overwrite them afterward); clearing sets
// the rows back to NULL, re-opening them to rules.
export async function bulkCategorizeTransactions(
  ids: string[],
  categoryId: string | null,
): Promise<{ error?: string }> {
  await requireUser();
  const parsed = bulkTransactionIdsSchema.parse(ids);
  const parsedCategory = z.string().uuid().nullable().parse(categoryId);
  const result = await bulkUpdateTransactionCategory(parsed, parsedCategory);
  if ('error' in result) return { error: result.error };
  revalidatePath('/');
  return {};
}

// Bulk soft delete for the selection action bar. Same mechanism as the
// single delete: balances change when any selected row carried a split, so
// both views revalidate.
export async function bulkDeleteTransactions(ids: string[]): Promise<ActionResult> {
  await requireUser();
  const parsed = bulkTransactionIdsSchema.safeParse(ids);
  if (!parsed.success) return { error: 'Invalid selection.' };
  return attempt('bulkDeleteTransactions', async () => {
    const asked = parsed.data.length;
    const n = await softDeleteTransactionsByIds(parsed.data);
    if (n === 0) return { error: 'Nothing was deleted; those rows may already be deleted.' };
    revalidatePath('/');
    revalidatePath('/people');
    return n === asked
      ? { ok: true, message: `${n} row${n === 1 ? '' : 's'} deleted.` }
      : { ok: true, warning: `${n} of ${asked} deleted; the rest were already deleted.` };
  });
}

// Soft delete. Balances change too when the transaction carried a split,
// so both views revalidate.
export async function deleteTransaction(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const id = z.string().uuid().safeParse(formData.get('id'));
  if (!id.success) return { error: 'Invalid transaction.' };
  return attempt('deleteTransaction', async () => {
    if (!(await softDeleteTransactionById(id.data))) {
      return { error: 'That transaction was not found, or is already deleted.' };
    }
    revalidatePath('/');
    revalidatePath('/people');
    return { ok: true, message: 'Transaction deleted.' };
  });
}
