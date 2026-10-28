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
    const shares = splitEqual(cents(10000), 3);
    expect(shares).toEqual([3340, 3330, 3330]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('splits evenly when the total divides', () => {
    expect(splitEqual(cents(30000), 3)).toEqual([10000, 10000, 10000]);
  });

  it('handles a single participant', () => {
    expect(splitEqual(cents(9990), 1)).toEqual([9990]);
  });

  it('rejects zero participants', () => {
    expect(() => splitEqual(cents(10000), 0)).toThrow();
  });
});

describe('splitByAmount', () => {
  it('returns the entered amounts when they sum to the total', () => {
    expect(
      splitByAmount(cents(43950), [cents(23950), cents(10000), cents(10000)]),
    ).toEqual([23950, 10000, 10000]);
  });

  it('allows a zero amount for a participant', () => {
    expect(splitByAmount(cents(5000), [cents(0), cents(5000)])).toEqual([0, 5000]);
  });

  it('errors cleanly on a mismatched sum', () => {
    expect(() =>
      splitByAmount(cents(10000), [cents(3000), cents(3000)]),
    ).toThrow(/sum to 6000 cents but must sum to 10000 cents/);
  });

  it('rejects negative amounts', () => {
    expect(() =>
      splitByAmount(cents(1000), [cents(-1000) as Cents, cents(2000)]),
    ).toThrow(/negative/);
  });

  it('rejects an empty amount list', () => {
    expect(() => splitByAmount(cents(1000), [])).toThrow();
  });
});

describe('splitByPercent', () => {
  it('splits 33/33/34 exactly when no remainder is left', () => {
    expect(splitByPercent(cents(10000), [33, 33, 34])).toEqual([3300, 3300, 3400]);
  });

  it('gives remainder cents to the first participants', () => {
    // 101 * 33% floors to 33, 33, 34 → 100; the leftover cent goes first.
    expect(splitByPercent(cents(1010), [33, 33, 34])).toEqual([340, 330, 340]);
  });

  it('always sums to the total', () => {
    for (const total of [1, 99, 101, 1000, 33333]) {
      const shares = splitByPercent(cents(total), [17, 33, 50]);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('floors to whole cents and puts a sub-cent total\'s fraction on the first share', () => {
    expect(splitByPercent(cents(10010), [33, 33, 34])).toEqual([3310, 3300, 3400]);
    expect(splitByPercent(cents(10013), [33, 33, 34])).toEqual([3313, 3300, 3400]);
  });

  it('allows a zero percent', () => {
    expect(splitByPercent(cents(10000), [0, 100])).toEqual([0, 10000]);
  });

  it('rejects percents that do not sum to 100', () => {
    expect(() => splitByPercent(cents(10000), [50, 40])).toThrow(/sum to 90/);
  });

  it('rejects fractional and negative percents', () => {
    expect(() => splitByPercent(cents(10000), [33.5, 33.5, 33])).toThrow();
    expect(() => splitByPercent(cents(10000), [-10, 110])).toThrow();
  });

  it('rejects an empty percent list', () => {
    expect(() => splitByPercent(cents(10000), [])).toThrow();
  });
});

describe('computeShares', () => {
  it('resolves an equal split with no tax or tip', () => {
    expect(computeShares(cents(36470), cents(0), cents(0), 'equal', people(3))).toEqual([
      { personId: 'p1', amountCents: 12160 },
      { personId: 'p2', amountCents: 12160 },
      { personId: 'p3', amountCents: 12150 },
    ]);
  });

  it('divides tax and tip equally on top of the method shares', () => {
    // $110.00 with $5 tax + $5 tip: the $100 base splits 3334/3333/3333 and
    // the $10 tax+tip splits 334/333/333, both first-k.
    const shares = computeShares(cents(110000), cents(5000), cents(5000), 'equal', people(3));
    expect(shares.map((s) => s.amountCents)).toEqual([36680, 36660, 36660]);
    expect(shares.reduce((a, s) => a + s.amountCents, 0)).toBe(110000);
  });

  it('divides tax and tip equally even when amounts are uneven', () => {
    // By-amount on the $40.00 base; the $6.00 tax+tip is split equally,
    // independent of what each entered.
    const shares = computeShares(
      cents(46000),
      cents(3000),
      cents(3000),
      'amount',
      people(2),
      [30000, 10000],
    );
    expect(shares.map((s) => s.amountCents)).toEqual([33000, 13000]);
  });

  it('resolves a by-amount split', () => {
    const shares = computeShares(
      cents(43950),
      cents(0),
      cents(0),
      'amount',
      people(3),
      [23950, 10000, 10000],
    );
    expect(shares.map((s) => s.amountCents)).toEqual([23950, 10000, 10000]);
  });

  it('errors cleanly when by-amount inputs miss the total', () => {
    expect(() =>
      computeShares(cents(43950), cents(0), cents(0), 'amount', people(2), [
        23950, 10000,
      ]),
    ).toThrow(/sum to 33950 cents but must sum to 43950 cents/);
  });

  it('resolves a by-percent split with tax and tip', () => {
    // $10.01 base after the $1.00 tax carve-out from $11.01. Base shares
    // floor to 330/330/340 with one leftover cent to p1 → 331/330/340; the
    // 100 tax cents divide 34/33/33.
    const shares = computeShares(
      cents(11010),
      cents(1000),
      cents(0),
      'percent',
      people(3),
      [33, 33, 34],
    );
    expect(shares.map((s) => s.amountCents)).toEqual([3650, 3630, 3730]);
    expect(shares.reduce((a, s) => a + s.amountCents, 0)).toBe(11010);
  });

  it('gives whole-cent shares for a whole-cent total, tax and tip included', () => {
    // The amount the wording was reviewed on: $54.07 three ways.
    expect(
      computeShares(cents(54070), cents(0), cents(0), 'equal', people(3)).map((s) => s.amountCents),
    ).toEqual([18030, 18020, 18020]);
    const shares = computeShares(cents(100010), cents(8870), cents(15000), 'percent', people(3), [17, 33, 50]);
    for (const s of shares) expect(s.amountCents % 10).toBe(0);
    expect(shares.reduce((a, s) => a + s.amountCents, 0)).toBe(100010);
  });

  it('splits the absolute value of a negative total', () => {
    expect(
      computeShares(cents(-10000), cents(0), cents(0), 'equal', people(2)).map(
        (s) => s.amountCents,
      ),
    ).toEqual([5000, 5000]);
  });

  it('rejects tax and tip exceeding the total', () => {
    expect(() =>
      computeShares(cents(10000), cents(6000), cents(5000), 'equal', people(2)),
    ).toThrow(/exceed/);
  });

  it('rejects negative tax or tip', () => {
    expect(() =>
      computeShares(cents(10000), cents(-1000) as Cents, cents(0), 'equal', people(2)),
    ).toThrow(/negative/);
  });

  it('rejects an empty participant list', () => {
    expect(() =>
      computeShares(cents(10000), cents(0), cents(0), 'equal', []),
    ).toThrow(/participant/);
  });

  it('rejects inputs that do not align with participants', () => {
    expect(() =>
      computeShares(cents(10000), cents(0), cents(0), 'percent', people(3), [50, 50]),
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
        { amountCents: cents(4990), assigneePersonIds: ['owner'] },
        { amountCents: cents(6580), assigneePersonIds: ['alex', 'sam'] },
      ],
    });
    expect(shares).toEqual([
      { personId: 'owner', amountCents: 4990 },
      { personId: 'alex', amountCents: 3290 },
      { personId: 'sam', amountCents: 3290 },
    ]);
  });

  it('gives an odd item cent to the earlier-created assignee', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(0),
      tipCents: cents(0),
      items: [{ amountCents: cents(2990), assigneePersonIds: ['sam', 'alex'] }],
    });
    // Order comes from personOrder, not the assignment list order.
    expect(shares).toEqual([
      { personId: 'alex', amountCents: 1500 },
      { personId: 'sam', amountCents: 1490 },
    ]);
  });

  it('assigns unassigned items to the owner', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(0),
      tipCents: cents(0),
      items: [
        { amountCents: cents(5000), assigneePersonIds: [] },
        { amountCents: cents(3000), assigneePersonIds: ['alex'] },
      ],
    });
    expect(shares).toEqual([
      { personId: 'owner', amountCents: 5000 },
      { personId: 'alex', amountCents: 3000 },
    ]);
  });

  it('divides tax and tip equally among participants regardless of item value', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(260),
      tipCents: cents(3000),
      items: [
        { amountCents: cents(20000), assigneePersonIds: ['owner'] },
        { amountCents: cents(1000), assigneePersonIds: ['alex'] },
      ],
    });
    // tax+tip = 326 → 163 each despite the 20:1 item ratio.
    expect(shares).toEqual([
      { personId: 'owner', amountCents: 21630 },
      { personId: 'alex', amountCents: 2630 },
    ]);
  });

  it('excludes people with no items from the tax/tip division', () => {
    const shares = computeItemShares({
      ...base,
      taxCents: cents(900),
      tipCents: cents(0),
      items: [{ amountCents: cents(10000), assigneePersonIds: ['alex', 'sam'] }],
    });
    // Owner holds nothing: not a participant, pays no tax.
    expect(shares).toEqual([
      { personId: 'alex', amountCents: 5450 },
      { personId: 'sam', amountCents: 5450 },
    ]);
  });

  it('sums to items + tax + tip exactly on the fixture-shaped case', () => {
    // Six items, uneven assignment, odd tax — mirrors the sample receipt.
    const shares = computeItemShares({
      ...base,
      taxCents: cents(260),
      tipCents: cents(0),
      items: [
        { amountCents: cents(4990), assigneePersonIds: ['owner'] },
        { amountCents: cents(2990), assigneePersonIds: ['alex'] },
        { amountCents: cents(2990), assigneePersonIds: ['sam'] },
        { amountCents: cents(3290), assigneePersonIds: ['owner', 'alex', 'sam'] },
        { amountCents: cents(2990), assigneePersonIds: ['alex', 'sam'] },
        { amountCents: cents(3290), assigneePersonIds: [] },
      ],
    });
    const sum = shares.reduce((a, s) => a + s.amountCents, 0);
    expect(sum).toBe(4990 + 2990 + 2990 + 3290 + 2990 + 3290 + 260);
    // Spot-check the remainder flow: 329/3 = 110/110/109 owner-first;
    // 299/2 = 150/149 alex-first; tax 26/3 = 9/9/8.
    expect(shares).toEqual([
      { personId: 'owner', amountCents: 4990 + 1100 + 3290 + 90 },
      { personId: 'alex', amountCents: 2990 + 1100 + 1500 + 90 },
      { personId: 'sam', amountCents: 2990 + 1090 + 1490 + 80 },
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
        { amountCents: cents(2310), assigneePersonIds: ['alex', 'sam'] },
        { amountCents: cents(2990), assigneePersonIds: ['alex', 'sam'] },
        { amountCents: cents(1990), assigneePersonIds: ['alex', 'sam'] },
        { amountCents: cents(5490), assigneePersonIds: ['alex', 'sam'] },
      ],
    });
    expect(shares).toEqual([
      { personId: 'alex', amountCents: 6390 },
      { personId: 'sam', amountCents: 6390 },
    ]);
  });

  it('rejects an unknown assignee', () => {
    expect(() =>
      computeItemShares({
        ...base,
        taxCents: cents(0),
        tipCents: cents(0),
        items: [{ amountCents: cents(1000), assigneePersonIds: ['ghost'] }],
      }),
    ).toThrow(/Unknown person/);
  });

  it('rejects negative item amounts and negative tax', () => {
    expect(() =>
      computeItemShares({
        ...base,
        taxCents: cents(0),
        tipCents: cents(0),
        items: [{ amountCents: cents(-10) as Cents, assigneePersonIds: ['alex'] }],
      }),
    ).toThrow(/negative/);
    expect(() =>
      computeItemShares({
        ...base,
        taxCents: cents(-10) as Cents,
        tipCents: cents(0),
        items: [{ amountCents: cents(1000), assigneePersonIds: ['alex'] }],
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
