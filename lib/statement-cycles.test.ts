import { describe, expect, it } from 'vitest';
import { closingPattern, currentCycle, cycleLine, parseClosingDates, type StatementRecord } from './statement-cycles';

// Invented days and dates throughout; none is an account's real one.
const st = (closingDate: string, over: Partial<StatementRecord> = {}): StatementRecord => ({
  closingDate,
  periodStart: null,
  nextClosingDate: null,
  startsNewCycle: false,
  ...over,
});

describe('closingPattern', () => {
  it('states a day only from three statements on it, and counts them', () => {
    expect(closingPattern([st('2026-08-06'), st('2026-09-06')])).toEqual({ kind: 'few', day: 6, count: 2 });
    expect(closingPattern([st('2026-08-06'), st('2026-09-06'), st('2026-10-06')])).toEqual({ kind: 'day', day: 6, count: 3 });
  });

  it('reopens the range on a single later outlier', () => {
    const steady = [st('2026-06-18'), st('2026-07-18'), st('2026-08-18')];
    expect(closingPattern([...steady, st('2026-09-16')])).toEqual({ kind: 'range', minDay: 16, maxDay: 18, count: 4 });
  });

  it('counts only from the latest change of cycle', () => {
    const before = [st('2026-06-18'), st('2026-07-18'), st('2026-08-18')];
    expect(closingPattern([...before, st('2026-09-03', { startsNewCycle: true })])).toEqual({ kind: 'few', day: 3, count: 1 });
  });
});

describe('currentCycle', () => {
  const steady = [st('2026-08-06'), st('2026-09-06'), st('2026-10-06')];

  it('starts exactly after the latest recorded closing and projects only the end', () => {
    expect(currentCycle(steady, '2026-10-20')).toEqual({
      start: '2026-10-07',
      startExact: true,
      missingSince: null,
      end: { from: '2026-11-06', to: '2026-11-06' },
      endFrom: 'projected',
      pattern: { kind: 'day', day: 6, count: 3 },
    });
  });

  it('uses the next closing date the last statement printed', () => {
    const cycle = currentCycle([...steady.slice(0, 2), st('2026-10-06', { nextClosingDate: '2026-11-05' })], '2026-10-20');
    expect(cycle).toMatchObject({ start: '2026-10-07', startExact: true, end: { from: '2026-11-05', to: '2026-11-05' }, endFrom: 'printed' });
  });

  it('projects a range when the days have varied', () => {
    const varied = [st('2026-08-18'), st('2026-09-16'), st('2026-10-18')];
    expect(currentCycle(varied, '2026-10-25')).toMatchObject({ start: '2026-10-19', end: { from: '2026-11-16', to: '2026-11-18' } });
  });

  it('says the start is projected when a statement closed since and is not recorded', () => {
    const cycle = currentCycle(steady, '2026-11-20');
    expect(cycle).toMatchObject({ start: '2026-11-07', startExact: false, missingSince: '2026-10-06', end: { from: '2026-12-06', to: '2026-12-06' } });
  });

  it('ends on a closing recorded today, and is null with nothing recorded', () => {
    expect(currentCycle(steady, '2026-10-06')).toMatchObject({ start: '2026-09-07', startExact: true, end: { from: '2026-10-06', to: '2026-10-06' }, endFrom: 'recorded' });
    expect(currentCycle([], '2026-10-06')).toBeNull();
  });

  it('closes a short month on its last day', () => {
    expect(currentCycle([st('2027-01-31')], '2027-02-10')).toMatchObject({ end: { from: '2027-02-28', to: '2027-02-28' } });
  });
});

describe('cycleLine', () => {
  const base = {
    today: '2026-10-20',
    verified: true,
    chargesCents: 52_000,
    creditsCents: 15_000,
    pendingCents: 0,
    pendingCount: 0,
    formatDay: (iso: string) => iso.slice(5),
    formatMoney: (n: number) => `$${n / 1000}`,
  };
  const steady = [st('2026-08-06'), st('2026-09-06'), st('2026-10-06')];

  it('states a steady day with the count it rests on', () => {
    expect(cycleLine({ ...base, kind: 'card', cycle: currentCycle(steady, '2026-10-20')! })).toBe(
      'This cycle, 10-07 – closes 11-06, in 17 days: the 6th, from 3 statements. So far: $52 in charges, $15 in payments and credits.',
    );
  });

  it('gives a range with its spread and count, and checking its own words', () => {
    const varied = [st('2026-08-18'), st('2026-09-16'), st('2026-10-18')];
    const line = cycleLine({ ...base, kind: 'checking', today: '2026-10-25', cycle: currentCycle(varied, '2026-10-25')! });
    expect(line).toBe(
      'This statement period, 10-19 – expected to close 11-16–11-18, in 22–24 days: between the 16th and the 18th across 3 statements. ' +
        'So far: $52 in withdrawals, $15 in deposits.',
    );
    expect(line).not.toMatch(/credit|charge/);
  });

  it('marks a projected start, a printed close, few statements, pending, and an unverified account', () => {
    const missing = cycleLine({ ...base, kind: 'card', today: '2026-11-20', cycle: currentCycle(steady, '2026-11-20')! });
    expect(missing).toContain('This cycle, about 11-07 –');
    expect(missing).toContain('The statement after the one closing 10-06 is not recorded; record it for an exact start.');
    const printed = currentCycle([st('2026-10-06', { nextClosingDate: '2026-11-05' })], '2026-10-20')!;
    expect(cycleLine({ ...base, kind: 'card', cycle: printed })).toContain('closes 11-05, in 16 days, as the last statement printed');
    const few = currentCycle([st('2026-10-06')], '2026-10-20')!;
    expect(cycleLine({ ...base, kind: 'card', cycle: few, pendingCents: 7_500, pendingCount: 1 })).toBe(
      'This cycle, 10-07 – expected to close around 11-06, in 17 days: from 1 statement. So far: $52 in charges, $15 in payments and credits; ' +
        '$7.5 pending (1), counted once posted.',
    );
    expect(cycleLine({ ...base, kind: 'checking', cycle: few, verified: false })).toMatch(/\. No total until this account is verified\.$/);
  });
});

describe('parseClosingDates', () => {
  const today = '2026-11-03';

  it('reads a bank list without years as each date’s latest occurrence', () => {
    expect(parseClosingDates('Oct 6, Sep 7, Aug 6, Dec 5', today)).toEqual({
      dates: ['2025-12-05', '2026-08-06', '2026-09-07', '2026-10-06'],
      unread: [],
    });
  });

  it('reads one per line, ISO dates, slashes and full month names, and drops repeats', () => {
    expect(parseClosingDates('2026-10-06\n9/7/2026\nAugust 6, 2026\nOct 6', today).dates).toEqual(['2026-08-06', '2026-09-07', '2026-10-06']);
  });

  it('returns what it cannot read instead of guessing', () => {
    expect(parseClosingDates('Oct 6, Sept 31, 13/40, soon', today)).toEqual({ dates: ['2026-10-06'], unread: ['Sept 31', '13/40', 'soon'] });
    expect(parseClosingDates('2026-12-01', today).unread).toEqual(['2026-12-01']);
  });
});
