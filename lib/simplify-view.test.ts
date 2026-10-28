import { describe, it, expect } from 'vitest';
import { buildSimplifyView } from './simplify-view';

const share = (counterpartyId: string, outstandingCents: number) => ({
  counterpartyId,
  outstandingCents,
});

describe('buildSimplifyView', () => {
  it('is empty when nobody owes anything', () => {
    expect(
      buildSimplifyView({ ownerId: 'me', people: [{ personId: 'a', netCents: 0 }], shares: [] }),
    ).toEqual({ outstandingDebts: 0, peopleInvolved: 0, perPersonPayments: [], transfers: [] });
  });

  it('counts open shares, people, per-person payments, and simplified transfers', () => {
    const view = buildSimplifyView({
      ownerId: 'me',
      people: [
        { personId: 'alex', netCents: 180_000 },
        { personId: 'jordan', netCents: 240_000 },
        { personId: 'sam', netCents: -180_000 },
        { personId: 'priya', netCents: -240_000 },
        { personId: 'casey', netCents: 0 },
      ],
      shares: [
        share('alex', 100_000), share('alex', 80_000),
        share('jordan', 240_000),
        share('sam', 180_000),
        share('priya', 200_000), share('priya', 40_000),
        share('casey', 0), // fully settled: not an open debt
      ],
    });
    expect(view.outstandingDebts).toBe(6);
    expect(view.peopleInvolved).toBe(5); // four counterparties plus the owner
    expect(view.perPersonPayments).toEqual([
      { fromPersonId: 'alex', toPersonId: 'me', amountCents: 180_000 },
      { fromPersonId: 'jordan', toPersonId: 'me', amountCents: 240_000 },
      { fromPersonId: 'me', toPersonId: 'sam', amountCents: 180_000 },
      { fromPersonId: 'me', toPersonId: 'priya', amountCents: 240_000 },
    ]);
    // The owner is even, so both debtors pay the creditors directly.
    expect(view.transfers).toEqual([
      { fromPersonId: 'alex', toPersonId: 'sam', amountCents: 180_000 },
      { fromPersonId: 'jordan', toPersonId: 'priya', amountCents: 240_000 },
    ]);
  });

  it('matches per-person payments when everyone owes the owner', () => {
    // A pure star with no creditors: nothing to route around the owner.
    const view = buildSimplifyView({
      ownerId: 'me',
      people: [
        { personId: 'a', netCents: 500 },
        { personId: 'b', netCents: 700 },
      ],
      shares: [share('a', 500), share('b', 700)],
    });
    expect(view.transfers).toHaveLength(view.perPersonPayments.length);
    expect(view.transfers.every((t) => t.toPersonId === 'me')).toBe(true);
  });

  it('counts a person owed both ways but netting to zero as no payment', () => {
    const view = buildSimplifyView({
      ownerId: 'me',
      people: [{ personId: 'morgan', netCents: 0 }],
      shares: [share('morgan', 3_000), share('morgan', 3_000)],
    });
    expect(view.outstandingDebts).toBe(2);
    expect(view.perPersonPayments).toEqual([]);
    expect(view.transfers).toEqual([]);
  });
});
