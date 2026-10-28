import { describe, it, expect } from 'vitest';
import { usDateToIso } from './dates';

describe('usDateToIso', () => {
  it('converts MM/DD/YYYY to ISO', () => {
    expect(usDateToIso('07/08/2026')).toBe('2026-07-08');
  });

  it('trims surrounding whitespace', () => {
    expect(usDateToIso('  06/24/2026  ')).toBe('2026-06-24');
  });

  it('throws on a non-date string', () => {
    expect(() => usDateToIso('not a date')).toThrow();
  });

  it('throws on an out-of-range month', () => {
    expect(() => usDateToIso('13/01/2026')).toThrow();
  });
});
