import { describe, expect, it } from 'vitest';
import { cycleContaining, cycleLine } from './statement-cycles';

const day = (closingDay: number, effectiveFrom = '2000-01-01') => ({ closingDay, effectiveFrom });

describe('cycleContaining', () => {
  it('runs from the day after the last closing to the next closing, inclusive', () => {
    expect(cycleContaining([day(18)], '2026-11-03')).toEqual({ start: '2026-10-19', end: '2026-11-18' });
    // On the closing day itself, the cycle is the one closing that day.
    expect(cycleContaining([day(18)], '2026-11-18')).toEqual({ start: '2026-10-19', end: '2026-11-18' });
    expect(cycleContaining([day(18)], '2026-11-19')).toEqual({ start: '2026-11-19', end: '2026-12-18' });
  });

  it('closes a short month on its last day', () => {
    expect(cycleContaining([day(31)], '2027-02-10')).toEqual({ start: '2027-02-01', end: '2027-02-28' });
    expect(cycleContaining([day(31)], '2028-02-29')).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(cycleContaining([day(30)], '2027-03-05')).toEqual({ start: '2027-03-01', end: '2027-03-30' });
  });

  it('crosses a year', () => {
    expect(cycleContaining([day(6)], '2026-12-29')).toEqual({ start: '2026-12-07', end: '2027-01-06' });
  });

  it('starts a changed cycle with the first statement closing on or after the change', () => {
    // Closed on the 27th; from 2026-10-20 the issuer closes on the 3rd.
    const entries = [day(27), day(3, '2026-10-20')];
    // October still closed on the 27th: the 3rd of October was before the change.
    expect(cycleContaining(entries, '2026-10-21')).toEqual({ start: '2026-09-28', end: '2026-10-27' });
    // The first statement on the new day closes November 3, right after the last old one.
    expect(cycleContaining(entries, '2026-10-29')).toEqual({ start: '2026-10-28', end: '2026-11-03' });
    expect(cycleContaining(entries, '2026-11-20')).toEqual({ start: '2026-11-04', end: '2026-12-03' });
  });

  it('starts at the first entry when no closing precedes it, and is null with no entry', () => {
    expect(cycleContaining([day(18, '2026-11-01')], '2026-11-03')).toEqual({ start: '2026-11-01', end: '2026-11-18' });
    expect(cycleContaining([], '2026-11-03')).toBeNull();
  });
});

describe('cycleLine', () => {
  const base = {
    start: '2026-10-07',
    end: '2026-11-06',
    today: '2026-11-03',
    verified: true,
    chargesCents: 52_000,
    creditsCents: 15_000,
    pendingCents: 0,
    pendingCount: 0,
    formatDay: (iso: string) => iso.slice(5),
    formatMoney: (n: number) => `$${n / 1000}`,
  };

  it('speaks of charges and credits on a card, with its closing date stated', () => {
    expect(cycleLine({ ...base, kind: 'card' })).toBe('This cycle, 10-07 – 11-06, closes in 3 days: $52 in charges, $15 in payments and credits.');
  });

  it('speaks of withdrawals and deposits on checking, never credits, with an approximate close', () => {
    const line = cycleLine({ ...base, kind: 'checking' });
    expect(line).toBe(
      'This statement period, about 10-07 – 11-06, expected to close in 3 days on the day you set ' +
        '(checking statements often close on a nearby business day instead): $52 in withdrawals, $15 in deposits.',
    );
    expect(line).not.toMatch(/credit|charge/);
  });

  it('adds pending apart, closes today or tomorrow, and shows no total before verification', () => {
    expect(cycleLine({ ...base, kind: 'card', pendingCents: 7_500, pendingCount: 1, today: '2026-11-06' })).toBe(
      'This cycle, 10-07 – 11-06, closes today: $52 in charges, $15 in payments and credits; $7.5 pending (1), counted once posted.',
    );
    expect(cycleLine({ ...base, kind: 'card', today: '2026-11-05' })).toContain('closes tomorrow');
    expect(cycleLine({ ...base, kind: 'checking', verified: false })).toMatch(/: no total until this account is verified\.$/);
  });
});
