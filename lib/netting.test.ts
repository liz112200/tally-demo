import { describe, it, expect } from 'vitest';
import { planNetting, splitAllocations } from './netting';

const a = (shareId: string, amountCents: number) => ({ shareId, amountCents });

describe('splitAllocations', () => {
  it('cuts the list at an amount, splitting one share across the boundary', () => {
    expect(splitAllocations([a('x', 300), a('y', 500), a('z', 200)], 600)).toEqual([
      [a('x', 300), a('y', 300)],
      [a('y', 200), a('z', 200)],
    ]);
  });
  it('puts everything in the tail at zero and the head past the total', () => {
    const list = [a('x', 300), a('y', 500)];
    expect(splitAllocations(list, 0)).toEqual([[], list]);
    expect(splitAllocations(list, 9_999)).toEqual([list, []]);
  });
});

describe('planNetting', () => {
  // The motivating case: they owe 1,662.952, the owner owes 762.575, and the
  // net 900.377 is what actually changed hands.
  const incoming = [a('i1', 1_000_000), a('i2', 662_952)];
  const outgoing = [a('o1', 429_670), a('o2', 332_905)];

  it('records the net as cash and the overlap as an offset pair', () => {
    const r = planNetting(incoming, outgoing, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { plan } = r;
    expect(plan.netCents).toBe(900_377);
    expect(plan.cash).toEqual({
      direction: 'incoming',
      amountCents: 900_377,
      allocations: [a('i1', 900_377)],
    });
    expect(plan.offset).toEqual({
      amountCents: 762_575,
      incoming: [a('i1', 99_623), a('i2', 662_952)],
      outgoing,
    });
    expect(plan.creditCents).toBe(0);
  });

  it('keeps both offset halves equal', () => {
    const r = planNetting(incoming, outgoing, null);
    if (!r.ok) throw new Error();
    const total = (l: { amountCents: number }[]) => l.reduce((s, x) => s + x.amountCents, 0);
    expect(total(r.plan.offset!.incoming)).toBe(total(r.plan.offset!.outgoing));
  });

  it('sends cash outgoing when the owner owes more', () => {
    const r = planNetting([a('i1', 200)], [a('o1', 500)], null);
    if (!r.ok) throw new Error();
    expect(r.plan.cash).toEqual({ direction: 'outgoing', amountCents: 300, allocations: [a('o1', 300)] });
    expect(r.plan.offset).toEqual({ amountCents: 200, incoming: [a('i1', 200)], outgoing: [a('o1', 200)] });
  });

  it('records only an offset when both sides cancel exactly', () => {
    const r = planNetting([a('i1', 400)], [a('o1', 150), a('o2', 250)], null);
    if (!r.ok) throw new Error();
    expect(r.plan.cash).toBeNull();
    expect(r.plan.offset?.amountCents).toBe(400);
  });

  it('is a plain one-sided payment when only one side is selected', () => {
    const r = planNetting([a('i1', 400)], [], null);
    if (!r.ok) throw new Error();
    expect(r.plan.offset).toBeNull();
    expect(r.plan.cash).toEqual({ direction: 'incoming', amountCents: 400, allocations: [a('i1', 400)] });
  });

  it('turns typed cash above the net into credit', () => {
    const r = planNetting(incoming, outgoing, 1_500_000);
    if (!r.ok) throw new Error();
    expect(r.plan.cashCents).toBe(1_500_000);
    expect(r.plan.creditCents).toBe(599_623);
    expect(r.plan.offset?.amountCents).toBe(762_575);
  });

  it('blocks typed cash below the net', () => {
    expect(planNetting(incoming, outgoing, 900_000)).toEqual({
      ok: false,
      reason: 'over',
      overByCents: 377,
      netCents: 900_377,
    });
  });

  it('places typed cash on the fallback side when the sides cancel', () => {
    const r = planNetting([a('i1', 100)], [a('o1', 100)], 50, 'outgoing');
    if (!r.ok) throw new Error();
    expect(r.plan.cash).toEqual({ direction: 'outgoing', amountCents: 50, allocations: [] });
    expect(r.plan.creditCents).toBe(50);
  });

  it('refuses an empty plan', () => {
    expect(planNetting([], [], null)).toEqual({ ok: false, reason: 'empty' });
  });
});
