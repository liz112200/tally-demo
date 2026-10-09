import { describe, it, expect } from 'vitest';
import { toCents, type Cents } from './money';
import {
  splitEqual,
  splitByAmount,
  splitByPercent,
  computeShares,
  computeItemShares,
} from './split';

const cents = (n: number) => toCents(n);
const people = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ personId: `p${i + 1}` }));

describe('splitEqual', () => {
  it('splits $10.00 three ways as [334, 333, 333]', () => {
    const shares = splitEqual(cents(1000), 3);
    expect(shares).toEqual([334, 333, 333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('splits evenly when the total divides', () => {
    expect(splitEqual(cents(3000), 3)).toEqual([1000, 1000, 1000]);
  });

  it('handles a single participant', () => {
    expect(splitEqual(cents(999), 1)).toEqual([999]);
  });

  it('rejects zero participants', () => {
    expect(() => splitEqual(cents(1000), 0)).toThrow();
  });
});

describe('splitByAmount', () => {
  it('returns the entered amounts when they sum to the total', () => {
    expect(
      splitByAmount(cents(4295), [cents(2295), cents(1000), cents(1000)]),
    ).toEqual([2295, 1000, 1000]);
  });

  it('allows a zero amount for a participant', () => {
    expect(splitByAmount(cents(500), [cents(0), cents(500)])).toEqual([0, 500]);
  });

  it('errors cleanly on a mismatched sum', () => {
    expect(() =>
      splitByAmount(cents(1000), [cents(300), cents(300)]),
    ).toThrow(/sum to 600 cents but must sum to 1000 cents/);
  });

  it('rejects negative amounts', () => {
    expect(() =>
      splitByAmount(cents(100), [cents(-100) as Cents, cents(200)]),
    ).toThrow(/negative/);
  });

  it('rejects an empty amount list', () => {
    expect(() => splitByAmount(cents(100), [])).toThrow();
  });
});

describe('splitByPercent', () => {
  it('splits 33/33/34 exactly when no remainder is left', () => {
    expect(splitByPercent(cents(1000), [33, 33, 34])).toEqual([330, 330, 340]);
  });

  it('gives remainder cents to the first participants', () => {
    // 101 * 33% floors to 33, 33, 34 → 100; the leftover cent goes first.
    expect(splitByPercent(cents(101), [33, 33, 34])).toEqual([34, 33, 34]);
  });

  it('always sums to the total', () => {
    for (const total of [1, 99, 101, 1000, 33333]) {
      const shares = splitByPercent(cents(total), [17, 33, 50]);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('allows a zero percent', () => {
    expect(splitByPercent(cents(1000), [0, 100])).toEqual([0, 1000]);
  });

  it('rejects percents that do not sum to 100', () => {
    expect(() => splitByPercent(cents(1000), [50, 40])).toThrow(/sum to 90/);
  });

  it('rejects fractional and negative percents', () => {
    expect(() => splitByPercent(cents(1000), [33.5, 33.5, 33])).toThrow();
    expect(() => splitByPercent(cents(1000), [-10, 110])).toThrow();
  });

  it('rejects an empty percent list', () => {
    expect(() => splitByPercent(cents(1000), [])).toThrow();
  });
});

describe('computeShares', () => {
  it('resolves an equal split with no tax or tip', () => {
    expect(computeShares(cents(3584), cents(0), cents(0), 'equal', people(3))).toEqual([
      { personId: 'p1', amountCents: 1195 },
      { personId: 'p2', amountCents: 1195 },
      { personId: 'p3', amountCents: 1194 },
    ]);
  });

  it('divides tax and tip equally on top of the method shares', () => {
    // $110.00 with $5 tax + $5 tip: the $100 base splits 3334/3333/3333 and
    // the $10 tax+tip splits 334/333/333, both first-k.
    const shares = computeShares(cents(11000), cents(500), cents(500), 'equal', people(3));
    expect(shares.map((s) => s.amountCents)).toEqual([3668, 3666, 3666]);
    expect(shares.reduce((a, s) => a + s.amountCents, 0)).toBe(11000);
  });

  it('divides tax and tip equally even when amounts are uneven', () => {
    // By-amount on the $40.00 base; the $6.00 tax+tip is split equally,
    // independent of what each entered.
    const shares = computeShares(
      cents(4600),
      cents(300),
      cents(300),
      'amount',
      people(2),
      [3000, 1000],
    );
    expect(shares.map((s) => s.amountCents)).toEqual([3300, 1300]);
  });

  it('resolves a by-amount split', () => {
    const shares = computeShares(
      cents(4295),
      cents(0),
      cents(0),
      'amount',
      people(3),
      [2295, 1000, 1000],
    );
    expect(shares.map((s) => s.amountCents)).toEqual([2295, 1000, 1000]);
  });

  it('errors cleanly when by-amount inputs miss the total', () => {
    expect(() =>
      computeShares(cents(4295), cents(0), cents(0), 'amount', people(2), [
        2295, 1000,
      ]),
    ).toThrow(/sum to 3295 cents but must sum to 4295 cents/);
  });

  it('resolves a by-percent split with tax and tip', () => {
    // $10.01 base after the $1.00 tax carve-out from $11.01. Base shares
    // floor to 330/330/340 with one leftover cent to p1 → 331/330/340; the
    // 100 tax cents divide 34/33/33.
    const shares = computeShares(
      cents(1101),
      cents(100),
      cents(0),
      'percent',
      people(3),
      [33, 33, 34],
    );
    expect(shares.map((s) => s.amountCents)).toEqual([365, 363, 373]);
    expect(shares.reduce((a, s) => a + s.amountCents, 0)).toBe(1101);
  });

  it('splits the absolute value of a negative total', () => {
    expect(
      computeShares(cents(-1000), cents(0), cents(0), 'equal', people(2)).map(
        (s) => s.amountCents,
      ),
    ).toEqual([500, 500]);
  });

  it('rejects tax and tip exceeding the total', () => {
    expect(() =>
      computeShares(cents(1000), cents(600), cents(500), 'equal', people(2)),
    ).toThrow(/exceed/);
  });

  it('rejects negative tax or tip', () => {
    expect(() =>
      computeShares(cents(1000), cents(-100) as Cents, cents(0), 'equal', people(2)),
    ).toThrow(/negative/);
  });

  it('rejects an empty participant list', () => {
    expect(() =>
      computeShares(cents(1000), cents(0), cents(0), 'equal', []),
    ).toThrow(/participant/);
  });

  it('rejects inputs that do not align with participants', () => {
    expect(() =>
      computeShares(cents(1000), cents(0), cents(0), 'percent', people(3), [50, 50]),
    ).toThrow(/one input per participant/);
  });
});

describe('computeItemShares', () => {
  const order = ['owner', 'alex', 'sam'];
  const base = { ownerId: 'owner', personOrder: order };

  it('splits each item equally among its assignees', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(0),
      tipCents: cents(0),
      items: [
        { amountCents: cents(499), assigneePersonIds: ['owner'] },
        { amountCents: cents(658), assigneePersonIds: ['alex', 'sam'] },
      ],
    });
    expect(shares).toEqual([
      { personId: 'owner', amountCents: 499 },
      { personId: 'alex', amountCents: 329 },
      { personId: 'sam', amountCents: 329 },
    ]);
  });

  it('gives an odd item cent to the earlier-created assignee', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(0),
      tipCents: cents(0),
      items: [{ amountCents: cents(299), assigneePersonIds: ['sam', 'alex'] }],
    });
    // Order comes from personOrder, not the assignment list order.
    expect(shares).toEqual([
      { personId: 'alex', amountCents: 150 },
      { personId: 'sam', amountCents: 149 },
    ]);
  });

  it('assigns unassigned items to the owner', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(0),
      tipCents: cents(0),
      items: [
        { amountCents: cents(500), assigneePersonIds: [] },
        { amountCents: cents(300), assigneePersonIds: ['alex'] },
      ],
    });
    expect(shares).toEqual([
      { personId: 'owner', amountCents: 500 },
      { personId: 'alex', amountCents: 300 },
    ]);
  });

  it('divides tax and tip equally among participants regardless of item value', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(26),
      tipCents: cents(300),
      items: [
        { amountCents: cents(2000), assigneePersonIds: ['owner'] },
        { amountCents: cents(100), assigneePersonIds: ['alex'] },
      ],
    });
    // tax+tip = 326 → 163 each despite the 20:1 item ratio.
    expect(shares).toEqual([
      { personId: 'owner', amountCents: 2163 },
      { personId: 'alex', amountCents: 263 },
    ]);
  });

  it('excludes people with no items from the tax/tip division', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(90),
      tipCents: cents(0),
      items: [{ amountCents: cents(1000), assigneePersonIds: ['alex', 'sam'] }],
    });
    // Owner holds nothing: not a participant, pays no tax.
    expect(shares).toEqual([
      { personId: 'alex', amountCents: 545 },
      { personId: 'sam', amountCents: 545 },
    ]);
  });

  it('sums to items + tax + tip exactly on the fixture-shaped case', () => {
    // Six items, uneven assignment, odd tax — mirrors the sample receipt.
    const shares = computeItemShares({
      ...base,
      taxCents: cents(26),
      tipCents: cents(0),
      items: [
        { amountCents: cents(499), assigneePersonIds: ['owner'] },
        { amountCents: cents(299), assigneePersonIds: ['alex'] },
        { amountCents: cents(299), assigneePersonIds: ['sam'] },
        { amountCents: cents(329), assigneePersonIds: ['owner', 'alex', 'sam'] },
        { amountCents: cents(299), assigneePersonIds: ['alex', 'sam'] },
        { amountCents: cents(329), assigneePersonIds: [] },
      ],
    });
    const sum = shares.reduce((a, s) => a + s.amountCents, 0);
    expect(sum).toBe(499 + 299 + 299 + 329 + 299 + 329 + 26);
    // Spot-check the remainder flow: 329/3 = 110/110/109 owner-first;
    // 299/2 = 150/149 alex-first; tax 26/3 = 9/9/8.
    expect(shares).toEqual([
      { personId: 'owner', amountCents: 499 + 110 + 329 + 9 },
      { personId: 'alex', amountCents: 299 + 110 + 150 + 9 },
      { personId: 'sam', amountCents: 299 + 109 + 149 + 8 },
    ]);
  });

  it('pools items with the same assignees so equal sharing stays equal', () => {
    // Four odd-cent items, same two people — per-item splitting would drift
    // $0.04; pooling the group splits $12.78 as $6.39 / $6.39.
    const shares = computeItemShares({
      ...base,
      taxCents: cents(0),
      tipCents: cents(0),
      items: [
        { amountCents: cents(231), assigneePersonIds: ['alex', 'sam'] },
        { amountCents: cents(299), assigneePersonIds: ['alex', 'sam'] },
        { amountCents: cents(199), assigneePersonIds: ['alex', 'sam'] },
        { amountCents: cents(549), assigneePersonIds: ['alex', 'sam'] },
      ],
    });
    expect(shares).toEqual([
      { personId: 'alex', amountCents: 639 },
      { personId: 'sam', amountCents: 639 },
    ]);
  });

  it('rejects an unknown assignee', () => {
    expect(() =>
      computeItemShares({
        ...base,
        taxCents: cents(0),
        tipCents: cents(0),
        items: [{ amountCents: cents(100), assigneePersonIds: ['ghost'] }],
      }),
    ).toThrow(/Unknown person/);
  });

  it('rejects negative item amounts and negative tax', () => {
    expect(() =>
      computeItemShares({
        ...base,
        taxCents: cents(0),
        tipCents: cents(0),
        items: [{ amountCents: cents(-1) as Cents, assigneePersonIds: ['alex'] }],
      }),
    ).toThrow(/negative/);
    expect(() =>
      computeItemShares({
        ...base,
        taxCents: cents(-1) as Cents,
        tipCents: cents(0),
        items: [{ amountCents: cents(100), assigneePersonIds: ['alex'] }],
      }),
    ).toThrow(/negative/);
  });

  it('rejects an empty item list', () => {
    expect(() =>
      computeItemShares({
        ...base,
        taxCents: cents(0),
        tipCents: cents(0),
        items: [],
      }),
    ).toThrow(/At least one item/);
  });
});
