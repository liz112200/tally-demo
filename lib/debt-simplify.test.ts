import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { simplifyDebts, type NetBalance } from './debt-simplify';
import { toCents } from './money';

const b = (personId: string, net: number): NetBalance => ({
  personId,
  netCents: toCents(net),
});

// Apply transfers to the starting balances: a payer's debt shrinks, a
// payee's credit shrinks. Settled means everyone lands on zero.
function applyTransfers(
  balances: readonly NetBalance[],
  transfers: ReturnType<typeof simplifyDebts>,
): Map<string, number> {
  const left = new Map(balances.map((x) => [x.personId, x.netCents as number]));
  for (const t of transfers) {
    left.set(t.fromPersonId, left.get(t.fromPersonId)! - t.amountCents);
    left.set(t.toPersonId, left.get(t.toPersonId)! + t.amountCents);
  }
  return left;
}

describe('simplifyDebts', () => {
  it('returns nothing for an empty or already-settled group', () => {
    expect(simplifyDebts([])).toEqual([]);
    expect(simplifyDebts([b('a', 0), b('b', 0)])).toEqual([]);
  });

  it('cancels a cycle entirely: A owes B, B owes C, C owes A, all $30', () => {
    // Each person both owes and is owed $30, so every net is zero.
    expect(simplifyDebts([b('a', 30_000 - 30_000), b('b', 30_000 - 30_000), b('c', 30_000 - 30_000)])).toEqual([]);
  });

  it('routes debtors straight to creditors when the hub is even', () => {
    // The owner-centric star: Alex and Jordan owe the owner, the owner owes
    // Sam and Priya the same amounts. Four payments through the owner
    // collapse to two direct ones and the owner drops out.
    const transfers = simplifyDebts([
      b('owner', 0),
      b('alex', 180_000),
      b('jordan', 240_000),
      b('sam', -180_000),
      b('priya', -240_000),
    ]);
    expect(transfers).toEqual([
      { fromPersonId: 'alex', toPersonId: 'sam', amountCents: 180_000 },
      { fromPersonId: 'jordan', toPersonId: 'priya', amountCents: 240_000 },
    ]);
  });

  it('matches largest to largest when no amounts line up', () => {
    const transfers = simplifyDebts([
      b('owner', -40_000),
      b('alex', 180_000),
      b('jordan', 260_000),
      b('sam', -200_000),
      b('priya', -200_000),
    ]);
    expect(transfers).toEqual([
      { fromPersonId: 'jordan', toPersonId: 'sam', amountCents: 200_000 },
      { fromPersonId: 'alex', toPersonId: 'priya', amountCents: 180_000 },
      { fromPersonId: 'jordan', toPersonId: 'owner', amountCents: 40_000 },
      { fromPersonId: 'jordan', toPersonId: 'priya', amountCents: 20_000 },
    ]);
  });

  it('takes an exact match before the largest-first pass', () => {
    // Largest-first alone would send 4 to the 6-creditor and need four
    // transfers; pairing the two 4s first leaves 3 + 3 -> 6, three total.
    const transfers = simplifyDebts([
      b('d1', 4), b('d2', 3), b('d3', 3), b('c1', -6), b('c2', -4),
    ]);
    expect(transfers).toHaveLength(3);
    expect(transfers[0]).toEqual({ fromPersonId: 'd1', toPersonId: 'c2', amountCents: 4 });
  });

  it('rejects balances that do not sum to zero', () => {
    expect(() => simplifyDebts([b('a', 10), b('b', -9)])).toThrow(/sum to zero/);
  });

  it('rejects a person listed twice', () => {
    expect(() => simplifyDebts([b('a', 10), b('a', -10)])).toThrow(/Duplicate/);
  });
});

// Random groups whose balances sum to zero: n-1 free balances plus a last
// person absorbing the difference. Small magnitudes are mixed in so ties,
// zeros, and exact matches come up often.
const zeroSumBalances = fc
  .array(
    fc.oneof(
      fc.integer({ min: -5, max: 5 }),
      fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
    ),
    { minLength: 0, maxLength: 12 },
  )
  .map((nets) => {
    const last = 0 - nets.reduce((acc, n) => acc + n, 0);
    return [...nets, last].map((n, i) => b(`p${i}`, n));
  });

describe('simplifyDebts properties', () => {
  it('settles every balance to exactly zero', () => {
    fc.assert(
      fc.property(zeroSumBalances, (balances) => {
        const left = applyTransfers(balances, simplifyDebts(balances));
        for (const v of left.values()) expect(v).toBe(0);
      }),
    );
  });

  it('uses at most (nonzero people - 1) transfers', () => {
    fc.assert(
      fc.property(zeroSumBalances, (balances) => {
        const nonzero = balances.filter((x) => x.netCents !== 0).length;
        expect(simplifyDebts(balances).length).toBeLessThanOrEqual(
          Math.max(0, nonzero - 1),
        );
      }),
    );
  });

  it('only moves positive amounts from debtors to creditors', () => {
    fc.assert(
      fc.property(zeroSumBalances, (balances) => {
        const net = new Map(balances.map((x) => [x.personId, x.netCents]));
        for (const t of simplifyDebts(balances)) {
          expect(t.amountCents).toBeGreaterThan(0);
          expect(t.fromPersonId).not.toBe(t.toPersonId);
          expect(net.get(t.fromPersonId)!).toBeGreaterThan(0);
          expect(net.get(t.toPersonId)!).toBeLessThan(0);
        }
      }),
    );
  });

  it('moves exactly the total owed, in and out', () => {
    fc.assert(
      fc.property(zeroSumBalances, (balances) => {
        const owed = balances.reduce((acc, x) => acc + Math.max(0, x.netCents), 0);
        const moved = simplifyDebts(balances).reduce((acc, t) => acc + t.amountCents, 0);
        expect(moved).toBe(owed);
      }),
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(zeroSumBalances, (balances) => {
        expect(simplifyDebts(balances)).toEqual(simplifyDebts(balances));
      }),
    );
  });

  it('rejects any nonzero sum', () => {
    fc.assert(
      fc.property(
        zeroSumBalances,
        fc.integer({ min: 1, max: 1_000 }),
        (balances, drift) => {
          const skewed = [...balances, b('extra', drift)];
          expect(() => simplifyDebts(skewed)).toThrow(/sum to zero/);
        },
      ),
    );
  });
});
