import { describe, expect, it } from 'vitest';
import { cycleSummary } from './cycle-summary';
import { currentCycle, type StatementRecord } from './statement-cycles';

// Invented days and dates throughout; none is an account's real one.
const st = (closingDate: string, over: Partial<StatementRecord> = {}): StatementRecord => ({
  closingDate,
  periodStart: null,
  nextClosingDate: null,
  startsNewCycle: false,
  ...over,
});
const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const summary = (statements: StatementRecord[], today: string) =>
  cycleSummary({ cycle: currentCycle(statements, today)!, statements, today, formatDay: day });

describe('cycleSummary', () => {
  it('states the day once three statements agree, with the count and the reason', () => {
    const s = summary([st('2026-07-09'), st('2026-08-09'), st('2026-09-09'), st('2026-10-09')], '2026-10-20');
    expect(s).toEqual({
      range: 'Oct 10 – closes Nov 9',
      count: '4 statements',
      left: '20 days left',
      reason: 'Every one of the 4 recorded statements closed on the 9th, so the day is stated.',
      progress: 33,
    });
  });

  it('gives a range when the days have varied, and the days left as a range', () => {
    const s = summary([st('2026-08-13'), st('2026-09-15'), st('2026-10-14')], '2026-10-20');
    expect(s.range).toBe('Oct 15 – closes Nov 13–15');
    expect(s.count).toBe('3 statements');
    expect(s.left).toBe('24–26 days left');
    expect(s.reason).toBe('The 3 recorded statements closed between the 13th and the 15th, so the close is a range.');
  });

  it('inside the closing window, says by when', () => {
    const statements = [st('2026-09-02'), st('2026-10-04')];
    expect(summary(statements, '2026-11-03').left).toBe('closes by Nov 4');
    expect(summary(statements, '2026-11-04').left).toBe('closes today at the latest');
    expect(summary(statements, '2026-11-04').reason).toBe('The two recorded statements closed between the 2nd and the 4th, so the close is a range.');
  });

  it('with fewer than three on one day, says about and why', () => {
    const s = summary([st('2026-09-25'), st('2026-10-25')], '2026-11-01');
    expect(s.range).toBe('Oct 26 – closes about Nov 25');
    expect(s.left).toBe('about 24 days left');
    expect(s.reason).toBe('Only 2 statements are recorded, closing on the 25th; the day is stated once 3 agree.');
  });

  it('counts from a change of closing day, and says so', () => {
    const s = summary(
      [st('2026-05-18'), st('2026-06-18'), st('2026-07-03', { startsNewCycle: true }), st('2026-08-03'), st('2026-09-03'), st('2026-10-03')],
      '2026-10-10',
    );
    expect(s.count).toBe('4 statements');
    expect(s.reason).toBe('Every one of the 4 recorded statements since the closing day changed closed on the 3rd, so the day is stated.');
  });

  it('a printed or recorded close is stated as such', () => {
    expect(summary([st('2026-09-12', { nextClosingDate: '2026-10-13' })], '2026-10-01').reason).toBe(
      'The last statement printed its next closing date, Oct 13.',
    );
    expect(summary([st('2026-09-12'), st('2026-10-12')], '2026-10-01').reason).toBe('The statement closing Oct 12 is recorded.');
  });

  it('says when a closed statement is missing and the start is estimated', () => {
    const s = summary([st('2026-06-07'), st('2026-07-07'), st('2026-08-07')], '2026-10-20');
    expect(s.range).toBe('about Oct 8 – closes Nov 7');
    expect(s.reason).toContain("The statement after the one closing Aug 7 is not recorded, so this cycle's start is estimated.");
  });

  it('keeps progress within 0 to 100', () => {
    // The first day is 0 days in; three days in of 29 is 10%.
    expect(summary([st('2026-07-09'), st('2026-08-09'), st('2026-09-09')], '2026-09-10').progress).toBe(0);
    expect(summary([st('2026-07-09'), st('2026-08-09'), st('2026-09-09')], '2026-09-13').progress).toBe(10);
    expect(summary([st('2026-07-09'), st('2026-08-09'), st('2026-09-09')], '2026-10-09').progress).toBe(100);
  });
});
