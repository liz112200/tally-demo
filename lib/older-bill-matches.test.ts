import { expect, test } from 'vitest';
import { compareBills, composeBill, type PriorBill, type ReviewItem } from './bill-review';
import { matchOlderBill, type ShareHistory } from './older-bill-matches';

test('matches the original balance after payment and holds ambiguous expenses out of publication', () => {
  const line = { date: '2026-10-01', description: 'Dinner', category: null, outstandingCents: 30000, side: 'owed' as const };
  const bill: PriorBill = { id: 'old', date: '2026-10-03', tracked: false, items: [line] };
  const item: ReviewItem = { ...line, shareId: 'a', cash: 10000, allocated: 10000, outstandingCents: 20000 };
  const hist: ShareHistory = { createdAt: '2026-10-01', allocations: [
    { at: '2026-10-04', amount: 10000, cash: true, picked: false, paymentId: 'pay' },
  ] };
  const history = new Map([['a', hist], ['b', hist]]);
  expect(matchOlderBill(bill, [item], history).items[0].source).toMatchObject({ shareId: 'a', cash: 0 });
  const items = [item, { ...item, shareId: 'b' }];
  const ambiguous = matchOlderBill(bill, items, history);
  expect(ambiguous.items[0].candidates).toHaveLength(2);
  const data = { name: 'Test', personId: 'p', bills: [ambiguous], items };
  const review = compareBills(data, 'old');
  expect(review.fresh).toEqual([]);
  expect(composeBill(data, review, new Set(['a','b']), 'classic', false, new Date()).sources).toEqual([]);
  expect(matchOlderBill({ ...bill, items: [{ ...line, skipped: true }] }, items, history).items[0].candidates).toBeUndefined();
  expect(matchOlderBill({ ...bill, items: [line, line] }, [item], history).items.every(i => !i.source)).toBe(true);
});
