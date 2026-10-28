// Bank categories (BANK-SYNC.md, "Bank categories"): the owner's mapping from
// the bank's own categories, applied to synced rows no rule matches, visibly
// the bank's; rules win, and nothing the owner or a rule set is overwritten.
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from './index';
import { bankCategoryMap, categories, categorizationRules, transactions } from './schema';
import { applyRulesToExisting } from './queries';
import { setBankCategoryMapping } from './bank-categories';
import { account, ptxn, row, sync } from './test/fixtures';
import { setBankCategory } from '@/app/_actions/bank-categories';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const made: { categories: string[]; rules: string[] } = { categories: [], rules: [] };
afterEach(async () => {
  await db.delete(bankCategoryMap);
  if (made.rules.length) await db.delete(categorizationRules).where(inArray(categorizationRules.id, made.rules));
  made.rules = [];
});

async function category(name: string, countsAsSpending = true) {
  const [c] = await db
    .insert(categories)
    .values({ name: `${name} ${randomUUID().slice(0, 6)}`, countsAsSpending, isSplittable: countsAsSpending })
    .returning({ id: categories.id, name: categories.name });
  made.categories.push(c.id);
  return c;
}

const food = (acc: Parameters<typeof ptxn>[0], over: Parameters<typeof ptxn>[1] = {}) =>
  ptxn(acc, { bankCategory: 'FOOD_AND_DRINK', raw: { personal_finance_category: { primary: 'FOOD_AND_DRINK' } }, ...over });

describe('the mapping', () => {
  it('refuses a category that does not count as spending, so a transfer to a person never leaves the totals', async () => {
    const transfers = await category('Transfers', false);
    expect(await setBankCategoryMapping('TRANSFER_OUT', transfers.id)).toEqual({
      error: `${transfers.name} does not count as spending, so the bank's categories cannot map to it; leave transfers to your rules.`,
    });
    expect(await db.select().from(bankCategoryMap)).toEqual([]);
  });

  it('maps, remaps and removes through the action, saying that existing rows change only with Apply', async () => {
    const dining = await category('Dining');
    expect(await setBankCategory('FOOD_AND_DRINK', dining.id)).toEqual({
      ok: true,
      message: `The bank's "Food and drink" now maps to ${dining.name}. Apply to existing to update rows already synced.`,
    });
    expect(await setBankCategory('FOOD_AND_DRINK', null)).toMatchObject({ ok: true });
    expect(await db.select().from(bankCategoryMap)).toEqual([]);
    expect(await setBankCategory('NOT_A_CATEGORY', dining.id)).toEqual({ error: 'Invalid request.' });
  });
});

describe('synced rows', () => {
  it('a new row no rule matches takes the mapped category as the bank\'s; an unmapped one stays uncategorized', async () => {
    const dining = await category('Dining');
    await setBankCategoryMapping('FOOD_AND_DRINK', dining.id);
    const acc = await account();
    const meal = food(acc);
    const pay = ptxn(acc, { bankCategory: 'TRANSFER_OUT' });
    await sync(acc, { added: [meal, pay] });
    expect(await row(acc, meal.providerTransactionId)).toMatchObject({ categoryId: dining.id, categorySource: 'bank' });
    expect(await row(acc, pay.providerTransactionId)).toMatchObject({ categoryId: null, categorySource: null });
  });

  it('Apply fills uncategorized rows, lets a rule win over the bank, and never touches a manual category', async () => {
    const dining = await category('Dining');
    const groceries = await category('Groceries');
    const travel = await category('Travel');
    const acc = await account();
    const tag = `NOODLE${randomUUID().slice(0, 6).toUpperCase()}`;
    const plain = food(acc);
    const ruled = food(acc, { descriptionRaw: `${tag} MARKET` });
    const mine = food(acc);
    await sync(acc, { added: [plain, ruled, mine] });
    const mineRow = (await row(acc, mine.providerTransactionId))!;
    await db.update(transactions).set({ categoryId: travel.id, categorySource: 'manual' }).where(eq(transactions.id, mineRow.id));

    // Mapped after the rows synced: they change only when the owner applies.
    await setBankCategoryMapping('FOOD_AND_DRINK', dining.id);
    expect(await row(acc, plain.providerTransactionId)).toMatchObject({ categoryId: null });
    const [rule] = await db
      .insert(categorizationRules)
      .values({ matchPattern: tag, matchType: 'substring', categoryId: groceries.id, priority: 1 })
      .returning({ id: categorizationRules.id });
    made.rules.push(rule.id);

    const result = await applyRulesToExisting();
    expect(result.bank).toBeGreaterThanOrEqual(1);
    expect(await row(acc, plain.providerTransactionId)).toMatchObject({ categoryId: dining.id, categorySource: 'bank' });
    expect(await row(acc, ruled.providerTransactionId)).toMatchObject({ categoryId: groceries.id, categorySource: 'rule' });
    expect(await row(acc, mine.providerTransactionId)).toMatchObject({ categoryId: travel.id, categorySource: 'manual' });

    // Unmapped again: the bank's category is cleared; the rule and the manual one stay.
    await setBankCategoryMapping('FOOD_AND_DRINK', null);
    await applyRulesToExisting();
    expect(await row(acc, plain.providerTransactionId)).toMatchObject({ categoryId: null, categorySource: null });
    expect(await row(acc, ruled.providerTransactionId)).toMatchObject({ categorySource: 'rule' });
    expect(await row(acc, mine.providerTransactionId)).toMatchObject({ categorySource: 'manual' });
  });
});
