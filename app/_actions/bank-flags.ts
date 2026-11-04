'use server';

// Resolving what sync flagged on a row (BANK-SYNC.md, slice 3). Re-saving
// and removing the split, and deleting the row, are the existing split and
// transaction actions; these are the two that exist only for flags.
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { clearBankFlag, moveBuiltOnToReplacement } from '@/db/queries';
import { requireUser } from '@/app/_lib/session';
import { attempt } from '@/app/_actions/attempt';
import type { ActionResult } from '@/lib/action-result';

const idSchema = z.string().uuid();
const flagSchema = z.enum(['amount', 'removed']);

// Keep the row as it is and clear the flag. Moves no money. What the flag
// said is recorded (bank_flag_resolutions), so a dismissal can be told apart
// from a row that was never flagged.
export async function dismissBankFlag(id: unknown, flag: unknown): Promise<ActionResult> {
  await requireUser();
  const parsedId = idSchema.safeParse(id);
  const parsedFlag = flagSchema.safeParse(flag);
  if (!parsedId.success || !parsedFlag.success) return { error: 'Invalid request.' };
  return attempt('dismissBankFlag', async () => {
    if (!(await clearBankFlag(parsedId.data, parsedFlag.data))) {
      return { error: 'That mark is already cleared, or the row was deleted. Reload to see it as it is.' };
    }
    revalidatePath('/');
    return {
      ok: true,
      message: parsedFlag.data === 'amount' ? "Kept as it is. The bank's earlier amount is recorded." : 'Kept. The removal is recorded.',
    };
  });
}

// Move a removed row's split (and receipt, note, manual category) onto the
// transaction that replaced it. Shares and payments are untouched.
export async function moveSplitToReplacement(fromId: unknown, toId: unknown): Promise<ActionResult> {
  await requireUser();
  const from = idSchema.safeParse(fromId);
  const to = idSchema.safeParse(toId);
  if (!from.success || !to.success) return { error: 'Invalid request.' };
  return attempt('moveSplitToReplacement', async () => {
    const result = await moveBuiltOnToReplacement(from.data, to.data);
    if ('error' in result) return result;
    revalidatePath('/');
    revalidatePath('/people');
    return { ok: true, message: 'Moved onto the replacement row.' };
  });
}
