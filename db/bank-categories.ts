import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from './index';
import { bankCategoryMap, categories } from './schema';
import type { PlaidCategory } from '@/lib/bank-sync/bank-categories';

// The owner's mapping from the bank's categories to theirs (bank_category_map),
// with how many live synced rows carry each bank category.
export async function bankCategoryRows(): Promise<{ plaidCategory: string; categoryId: string | null; syncedRows: number }[]> {
  const mapped = await db.select({ plaidCategory: bankCategoryMap.plaidCategory, categoryId: bankCategoryMap.categoryId }).from(bankCategoryMap);
  const counts = (await db.execute(sql`
    select provider_raw->'personal_finance_category'->>'primary' as plaid_category, count(*)::int as n
    from transactions
    where provider_transaction_id is not null and deleted_at is null
    group by 1`)) as unknown as { plaid_category: string | null; n: number }[];
  const byCategory = new Map(mapped.map((m) => [m.plaidCategory, m.categoryId]));
  const keys = new Set([...byCategory.keys(), ...counts.flatMap((c) => (c.plaid_category ? [c.plaid_category] : []))]);
  return [...keys].map((plaidCategory) => ({
    plaidCategory,
    categoryId: byCategory.get(plaidCategory) ?? null,
    syncedRows: counts.find((c) => c.plaid_category === plaidCategory)?.n ?? 0,
  }));
}

// Map one bank category to one of the owner's, or remove the mapping (null).
// Only a category that counts as spending may be mapped: a transfer to a
// person is TRANSFER_OUT to Plaid, and mapping it to Transfers would take real
// spending out of every total. Changes no transaction: "Apply to existing"
// does that, so the owner sees it happen.
export async function setBankCategoryMapping(
  plaidCategory: PlaidCategory,
  categoryId: string | null,
): Promise<{ ok: true; categoryName: string | null } | { error: string }> {
  return db.transaction(async (tx) => {
    if (categoryId === null) {
      await tx.delete(bankCategoryMap).where(eq(bankCategoryMap.plaidCategory, plaidCategory));
      return { ok: true, categoryName: null };
    }
    const [category] = await tx
      .select({ name: categories.name, countsAsSpending: categories.countsAsSpending })
      .from(categories)
      .where(eq(categories.id, categoryId));
    if (!category) return { error: 'That category no longer exists.' };
    if (!category.countsAsSpending) {
      return { error: `${category.name} does not count as spending, so the bank's categories cannot map to it; leave transfers to your rules.` };
    }
    await tx
      .insert(bankCategoryMap)
      .values({ plaidCategory, categoryId })
      .onConflictDoUpdate({ target: bankCategoryMap.plaidCategory, set: { categoryId } });
    return { ok: true, categoryName: category.name };
  });
}
