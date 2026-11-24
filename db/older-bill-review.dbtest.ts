import { expect, it, vi } from 'vitest';
import { confirmOlderBillItem } from '@/app/people/[personId]/bill/actions';
import { loadBillReview } from './bill-review';
import { insertExternalExpense, insertShareLink } from './queries';
import { owner, person } from './test/fixtures';

it('reviews personal bills from before tracking, including undo and saved changes', async () => {
  vi.stubEnv('DEMO_MODE', '0');
  try {
    const name = 'Earlier bill review';
    const personId = await person(name);
    const date = '2026-09-08';
    const { shareId } = await insertExternalExpense({
      payerPersonId: personId, ownerId: await owner(), date, description: 'Lunch', amountCents: 2000,
    });
    const { token } = await insertShareLink({
      personName: name, groupedByCategory: false, owed: [],
      owing: [{ date, description: 'Card purchase', outstandingCents: 2000, category: null }],
    });
    const initial = (await loadBillReview(personId))!;
    const [bill] = initial.data.bills;
    expect(bill.items[0].candidates?.map(c => c.shareId)).toEqual([shareId]);
    expect(bill.token).toBeUndefined();
    const decide = async (version: string, choice: string | null) => {
      const result = await confirmOlderBillItem({ personId, billId: bill.id, line: 0, shareId: choice, version });
      expect(result.review).toBeDefined();
      return result.review!;
    };
    const matched = await decide(initial.version, shareId);
    expect(matched.data.bills[0].token).toBe(token);
    const undone = await decide(matched.version, 'reopen');
    expect(undone.data.bills[0].items[0].candidates?.[0].shareId).toBe(shareId);
    await decide(undone.version, null);
    const saved = (await loadBillReview(personId))!;
    expect(saved.data.bills[0].items[0].skipped).toBe(true);
    const corrected = await decide(saved.version, shareId);
    expect(corrected.data.bills[0].items[0].source?.shareId).toBe(shareId);
    const dismissed = await decide(corrected.version, null);
    expect(dismissed.data.bills[0].items[0].skipped).toBe(true);
  } finally {
    vi.unstubAllEnvs();
  }
});
