// Property tests over the split engine: whatever the inputs, shares sum to
// the total exactly and never go negative. The example-based cases live in
// split.test.ts; these sweep the input space for the invariant itself.
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeShares, computeItemShares } from './split';
import { toCents, type Cents } from './money';

const sum = (xs: readonly { amountCents: Cents }[]) =>
  xs.reduce((acc, x) => acc + x.amountCents, 0);

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ personId: `p${i}` }));

// A total plus a tax + tip carve-out that fits inside it.
const totalWithTaxTip = fc
  .integer({ min: 0, max: 1_000_000_000 })
  .chain((total) =>
    fc.integer({ min: 0, max: total }).chain((taxTip) =>
      fc.integer({ min: 0, max: taxTip }).map((tax) => ({
        total,
        tax,
        tip: taxTip - tax,
      })),
    ),
  );

// Cut `whole` into `parts` non-negative integers that sum to it.
const partition = (whole: number, parts: number) =>
  fc
    .array(fc.integer({ min: 0, max: whole }), {
      minLength: parts - 1,
      maxLength: parts - 1,
    })
    .map((cuts) => {
      const points = [0, ...cuts.sort((a, b) => a - b), whole];
      return points.slice(1).map((p, i) => p - points[i]);
    });

describe('computeShares properties', () => {
  it('equal: shares sum to abs(total), including negative totals', () => {
    fc.assert(
      fc.property(
        totalWithTaxTip,
        fc.boolean(),
        fc.integer({ min: 1, max: 12 }),
        ({ total, tax, tip }, negate, n) => {
          const shares = computeShares(
            toCents(negate ? -total : total),
            toCents(tax),
            toCents(tip),
            'equal',
            people(n),
          );
          expect(sum(shares)).toBe(total);
          for (const s of shares) expect(s.amountCents).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('percent: whole percents summing to 100 resolve exactly', () => {
    fc.assert(
      fc.property(
        totalWithTaxTip,
        fc.integer({ min: 1, max: 12 }).chain((n) => partition(100, n)),
        ({ total, tax, tip }, percents) => {
          const shares = computeShares(
            toCents(total),
            toCents(tax),
            toCents(tip),
            'percent',
            people(percents.length),
            percents,
          );
          expect(sum(shares)).toBe(total);
          for (const s of shares) expect(s.amountCents).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('amount: entered amounts that cover the base resolve exactly', () => {
    fc.assert(
      fc.property(
        totalWithTaxTip.chain((t) =>
          fc
            .integer({ min: 1, max: 12 })
            .chain((n) => partition(t.total - t.tax - t.tip, n))
            .map((amounts) => ({ ...t, amounts })),
        ),
        ({ total, tax, tip, amounts }) => {
          const shares = computeShares(
            toCents(total),
            toCents(tax),
            toCents(tip),
            'amount',
            people(amounts.length),
            amounts,
          );
          expect(sum(shares)).toBe(total);
        },
      ),
    );
  });
});

describe('computeItemShares properties', () => {
  it('shares sum to items + tax + tip for any assignment', () => {
    const persons = ['owner', 'p1', 'p2', 'p3', 'p4'];
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amountCents: fc.integer({ min: 0, max: 50_000_000 }),
            assigneePersonIds: fc.subarray(persons),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (items, tax, tip) => {
          const shares = computeItemShares({
            ownerId: 'owner',
            taxCents: toCents(tax),
            tipCents: toCents(tip),
            items: items.map((i) => ({ ...i, amountCents: toCents(i.amountCents) })),
            personOrder: persons,
          });
          const itemsTotal = items.reduce((acc, i) => acc + i.amountCents, 0);
          expect(sum(shares)).toBe(itemsTotal + tax + tip);
          for (const s of shares) expect(s.amountCents).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
