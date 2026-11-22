import { expect, test } from 'vitest';
import { compareBills, composeBill, type BillReview, type ReviewItem } from './bill-review';

const item = (shareId: string, outstandingCents: number, side: ReviewItem['side'] = 'owed'): ReviewItem =>
  ({ shareId, outstandingCents, side, cash: 0, allocated: 0, date: '2026-01-01', category: null, description: 'Dinner' });
test('tracks prior shares across bills, partial payments, credits and duplicate descriptions', () => {
  const hotel = { ...item('hotel', 200000), cash: 100000, allocated: 100000 };
  const old = item('hotel', 300000);
  const dinner = item('dinner', 40000);
  const credit = item('credit', 20000, 'owing');
  const data: BillReview = { name: 'Alex', personId: 'a', items: [hotel, dinner, credit], bills: [
    { id: 'b2', date: '2026-01-20', tracked: true, items: [{...credit, source: credit}] },
    { id: 'b1', date: '2026-01-10', tracked: true, items: [{...old, source: old}] },
  ] };
  const view = compareBills(data, 'b2');
  expect(view.fresh).toEqual([dinner]);
  const bill = composeBill(data, view, new Set(['hotel','dinner','credit']), 'classic', false, new Date());
  expect(bill.snapshot.netCents).toBe(220000);
  expect(bill.snapshot.owed[0].carried).toEqual({ previous: 300000, cash: 100000, adjustment: 0, date: '2026-01-10' });
  expect(JSON.stringify(bill.snapshot)).not.toContain('shareId');
  hotel.outstandingCents = 180000; hotel.allocated += 20000;
  expect(composeBill(data, view, new Set(['hotel']), 'classic', false, new Date()).snapshot.owed[0].carried?.adjustment).toBe(-20000);
  expect(composeBill(data, view, new Set(['dinner']), 'classic', false, new Date()).snapshot.netCents).toBe(40000);
  const legacy = compareBills({...data, bills:[{id:'legacy', date:'2026-01-10', tracked:false, items:[old]}]}, 'legacy');
  expect(legacy.fresh).toHaveLength(3);
});

test('automatic payments reconcile the whole earlier balance, including fully cleared shares', () => {
  const first = item('first', 80000);
  const second = item('second', 220000);
  const data: BillReview = { personId: 'a', name: 'Alex', items: [
    { ...first, outstandingCents: 0, cash: 80000, allocated: 80000 },
    { ...second, outstandingCents: 200000, cash: 20000, allocated: 20000 }, item('new',40000),
  ], bills: [{ id:'prior', token:'publicToken', date:'2026-11-01', tracked:true,
    items:[{...first, source:first},{...second, source:second}] }] };
  const draft = () => composeBill(data, compareBills(data, 'prior'), new Set(['second','new']), 'classic', false, new Date());
  const group = () => draft().snapshot.previousBalances![0];
  expect(draft().snapshot.netCents).toBe(240000);
  expect(group()).toMatchObject({ previous:300000, payments:100000, included:200000, assigned:[], token:'publicToken' });
  data.items[1].pickedCash = 20000;
  expect(group().assigned).toEqual([{description:'Dinner', date:second.date, paid:20000, remaining:200000}]);
  data.items[1].pickedCash = 5000;
  expect(group().assigned[0]).toMatchObject({paid:5000, remaining:undefined});
  data.items[0].pickedCash = 80000;
  expect(group().assigned[0]).toMatchObject({paid:80000, remaining:0});
  data.items[0].outstandingCents = 10000;
  data.items[0].cash = 70000;
  data.items[0].pickedCash = 70000;
  expect(group()).toMatchObject({previous:300000, payments:90000, omitted:10000, included:200000});
  expect(group().assigned).toHaveLength(1);
});
