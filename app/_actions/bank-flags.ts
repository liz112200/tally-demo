'use server';

// Resolving what sync flagged on a row (BANK-SYNC.md, slice 3). Re-saving
// and removing the split, and deleting the row, are the existing split and
// transaction actions; these are the two that exist only for flags.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { clearBankFlag, moveBuiltOnToReplacement } from '@/db/queries';
import { requireUser } from '@/app/_lib/session';

export type FlagActionState = { ok: true } | { error: string };

const idSchema = z.string().uuid();
const flagSchema = z.enum(['amount', 'removed']);

// Keep the row as it is and clear the flag. Moves no money.
export async function dismissBankFlag(id: unknown, flag: unknown): Promise<FlagActionState> {
  await requireUser();
  const parsedId = idSchema.safeParse(id);
  const parsedFlag = flagSchema.safeParse(flag);
  if (!parsedId.success || !parsedFlag.success) return { error: 'Invalid request.' };
  await clearBankFlag(parsedId.data, parsedFlag.data);
  revalidatePath('/');
  return { ok: true };
}

// Move a removed row's split (and receipt, note, manual category) onto the
// transaction that replaced it. Shares and payments are untouched.
export async function moveSplitToReplacement(fromId: unknown, toId: unknown): Promise<FlagActionState> {
  await requireUser();
  const from = idSchema.safeParse(fromId);
  const to = idSchema.safeParse(toId);
  if (!from.success || !to.success) return { error: 'Invalid request.' };
  const result = await moveBuiltOnToReplacement(from.data, to.data);
  if ('error' in result) return result;
  revalidatePath('/');
  revalidatePath('/people');
  return { ok: true };
}
