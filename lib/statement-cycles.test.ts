import { describe, expect, it } from 'vitest';
import { closingPattern, currentCycle, parseClosingDates, type StatementRecord } from './statement-cycles';

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
