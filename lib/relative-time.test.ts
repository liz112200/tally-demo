import { describe, expect, it } from 'vitest';
import { exactTime, relativeTime } from './relative-time';

// Invented times.
const now = new Date('2026-08-20T15:00:00Z');
const before = (ms: number) => new Date(now.getTime() - ms);
const MIN = 60_000;

describe('relativeTime', () => {
  it('reads as minutes, hours, yesterday, days, then a date', () => {
    expect(relativeTime(before(20_000), now)).toBe('just now');
    expect(relativeTime(before(7 * MIN), now)).toBe('7 min ago');
    expect(relativeTime(before(5 * 60 * MIN + 59 * MIN), now)).toBe('5h ago');
    expect(relativeTime(before(30 * 60 * MIN), now)).toBe('yesterday');
    expect(relativeTime(before(3 * 24 * 60 * MIN), now)).toBe('3 days ago');
    expect(relativeTime(new Date('2026-08-02T09:00:00Z'), now)).toBe('Aug 2');
    expect(relativeTime(new Date('2025-12-30T09:00:00Z'), now)).toBe('Dec 30, 2025');
  });
});

describe('exactTime', () => {
  it('is the UTC time to the minute', () => {
    expect(exactTime(new Date('2026-08-20T09:05:41Z'))).toBe('Aug 20, 2026, 09:05 UTC');
  });
});
