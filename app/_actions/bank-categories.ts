'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { setBankCategoryMapping } from '@/db/bank-categories';
import { isPlaidCategory, PLAID_CATEGORIES } from '@/lib/bank-sync/bank-categories';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { requireUser } from '@/app/_lib/session';

// Set or remove the owner's category for one of the bank's (BANK-SYNC.md,
// "Bank categories"). Existing rows change only with "Apply to existing".
export async function setBankCategory(plaidCategory: unknown, categoryId: unknown): Promise<ActionResult> {
  await requireUser();
  const key = z.string().refine(isPlaidCategory).safeParse(plaidCategory);
  const id = z.string().uuid().nullable().safeParse(categoryId);
  if (!key.success || !id.success) return { error: 'Invalid request.' };
  return attempt('setBankCategory', async () => {
    const result = await setBankCategoryMapping(key.data as (typeof PLAID_CATEGORIES)[number][0], id.data);
    if ('error' in result) return result;
    revalidatePath('/rules');
    const label = PLAID_CATEGORIES.find(([k]) => k === key.data)![1];
    return {
      ok: true,
      message: result.categoryName
        ? `The bank's "${label}" now maps to ${result.categoryName}. Apply to existing to update rows already synced.`
        : `The bank's "${label}" no longer maps to a category. Apply to existing to clear it from rows already synced.`,
    };
  });
}
