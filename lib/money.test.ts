import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  toCents,
  parseDollars,
  tryParseDollars,
  formatCents,
  formatUSD,
  roundHalfEvenToCents,
  sumCents,
  distributeRemainder,
} from './money';

describe('toCents', () => {
  it('accepts finite integers', () => {
    expect(toCents(0)).toBe(0);
    expect(toCents(1234)).toBe(1234);
    expect(toCents(-500)).toBe(-500);
  });

  it('rejects non-integers and non-finite values', () => {
    expect(() => toCents(12.5)).toThrow();
    expect(() => toCents(NaN)).toThrow();
    expect(() => toCents(Infinity)).toThrow();
  });
});

describe('parseDollars', () => {
  it('parses valid amounts to minor units (thousandths)', () => {
    expect(parseDollars('12.34')).toBe(12340);
    expect(parseDollars('0.09')).toBe(90);
    expect(parseDollars('12.3')).toBe(12300);
    expect(parseDollars('12')).toBe(12000);
    expect(parseDollars('1,234.56')).toBe(1234560);
    expect(parseDollars('1,234')).toBe(1234000);
    expect(parseDollars('$1,234.56')).toBe(1234560);
    expect(parseDollars('-12.34')).toBe(-12340);
    expect(parseDollars('-$1,234.56')).toBe(-1234560);
    expect(parseDollars(' 12.34 ')).toBe(12340);
  });

  it('accepts a third decimal (sub-cent precision)', () => {
    expect(parseDollars('80.765')).toBe(80765);
    expect(parseDollars('0.001')).toBe(1);
    expect(parseDollars('0.005')).toBe(5);
    expect(parseDollars('12.345')).toBe(12345);
    expect(parseDollars('-0.005')).toBe(-5);
  });

  it('throws on invalid input', () => {
    expect(() => parseDollars('')).toThrow();
    expect(() => parseDollars('abc')).toThrow();
    expect(() => parseDollars('12.3456')).toThrow();
    expect(() => parseDollars('12.3.4')).toThrow();
  });
});

describe('formatCents', () => {
  it('formats minor units as a bare decimal string', () => {
    expect(formatCents(toCents(12340))).toBe('12.34');
    expect(formatCents(toCents(90))).toBe('0.09');
    expect(formatCents(toCents(0))).toBe('0.00');
    expect(formatCents(toCents(1234560))).toBe('1,234.56');
    expect(formatCents(toCents(-12340))).toBe('-12.34');
    expect(formatCents(toCents(-1234560))).toBe('-1,234.56');
    expect(formatCents(toCents(1000000000))).toBe('1,000,000.00');
  });

  it('shows the third decimal only for sub-cent amounts', () => {
    expect(formatCents(toCents(80765))).toBe('80.765');
    expect(formatCents(toCents(1))).toBe('0.001');
    expect(formatCents(toCents(5))).toBe('0.005');
    expect(formatCents(toCents(12345))).toBe('12.345');
    // Trailing zero in the third place drops back to two decimals.
    expect(formatCents(toCents(80700))).toBe('80.70');
    expect(formatCents(toCents(900))).toBe('0.90');
  });
});

describe('formatUSD', () => {
  it('wraps the bare format with the sign outside the symbol', () => {
    expect(formatUSD(toCents(12340))).toBe('$12.34');
    expect(formatUSD(toCents(-12340))).toBe('-$12.34');
    expect(formatUSD(toCents(-1234560))).toBe('-$1,234.56');
    expect(formatUSD(toCents(0))).toBe('$0.00');
  });
});

describe('formatUSD display rounding (half to even)', () => {
  const usd = (minor: number) => formatUSD(toCents(minor));

  it('rounds exact half-cent ties to the even cent', () => {
    expect(usd(5)).toBe('$0.00'); // 0.005
    expect(usd(15)).toBe('$0.02'); // 0.015
    expect(usd(25)).toBe('$0.02'); // 0.025
    expect(usd(35)).toBe('$0.04'); // 0.035
    expect(usd(80_765)).toBe('$80.76');
    expect(usd(80_775)).toBe('$80.78');
    expect(usd(1_234_565)).toBe('$1,234.56');
  });

  it('rounds non-ties to the nearest cent', () => {
    expect(usd(4)).toBe('$0.00');
    expect(usd(6)).toBe('$0.01');
    expect(usd(167_597)).toBe('$167.60');
    expect(usd(43_034)).toBe('$43.03');
  });

  it('mirrors ties for negatives and never shows -$0.00', () => {
    expect(usd(-5)).toBe('$0.00');
    expect(usd(-15)).toBe('-$0.02');
    expect(usd(-25)).toBe('-$0.02');
    expect(usd(-80_765)).toBe('-$80.76');
  });

  it('always prints exactly two decimals', () => {
    for (const minor of [0, 10, 1_000, 999_999, 123_456_789]) {
      expect(usd(minor)).toMatch(/^-?\$[\d,]+\.\d{2}$/);
    }
  });

  it('never moves an amount by more than half a cent', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }), (minor) => {
        const cents = roundHalfEvenToCents(toCents(minor));
        expect(Math.abs(cents * 10 - minor)).toBeLessThanOrEqual(5);
      }),
    );
  });
});

describe('round-trip', () => {
  const samples = [0, 1, 5, 90, 900, 12340, 12345, 80765, -12340, -80765,
    1234560, -1234560, 1000000000].map(toCents);

  it('parseDollars reverses formatCents', () => {
    for (const x of samples) {
      expect(parseDollars(formatCents(x))).toBe(x);
    }
  });

  it('parseDollars reverses formatUSD up to display rounding', () => {
    for (const x of samples) {
      expect(parseDollars(formatUSD(x))).toBe(roundHalfEvenToCents(x) * 10);
    }
  });
});

describe('tryParseDollars', () => {
  it('returns minor units for valid amounts', () => {
    expect(tryParseDollars('12.34')).toBe(12340);
    expect(tryParseDollars('80.765')).toBe(80765);
    expect(tryParseDollars('-$1,234.56')).toBe(-1234560);
  });

  it('returns null on the inputs parseDollars rejects', () => {
    expect(tryParseDollars('')).toBeNull();
    expect(tryParseDollars('abc')).toBeNull();
    expect(tryParseDollars('12.3456')).toBeNull();
    expect(tryParseDollars('12.3.4')).toBeNull();
  });
});

describe('sumCents', () => {
  it('sums a list of cents', () => {
    expect(sumCents([toCents(100), toCents(250), toCents(-50)])).toBe(300);
  });

  it('sums an empty list to zero', () => {
    expect(sumCents([])).toBe(0);
  });
});

describe('distributeRemainder', () => {
  it('gives the first k shares one extra cent', () => {
    expect(distributeRemainder(toCents(10000), 3)).toEqual([3340, 3330, 3330]);
    expect(distributeRemainder(toCents(10010), 3)).toEqual([3340, 3340, 3330]);
  });

  it('divides evenly when there is no remainder', () => {
    expect(distributeRemainder(toCents(10000), 4)).toEqual([2500, 2500, 2500, 2500]);
  });

  it('handles a single share and a zero total', () => {
    expect(distributeRemainder(toCents(9990), 1)).toEqual([9990]);
    expect(distributeRemainder(toCents(0), 3)).toEqual([0, 0, 0]);
  });

  it('divides in whole cents, never mills, when the total is whole cents', () => {
    // $54.07 three ways: $18.03 + $18.02 + $18.02, not 18.024 + 18.023 + 18.023,
    // so the parts display as they sum and a typed payment clears each.
    expect(distributeRemainder(toCents(54070), 3)).toEqual([18030, 18020, 18020]);
    for (let total = 0; total <= 5000; total += 10) {
      for (const count of [1, 2, 3, 7]) {
        for (const share of distributeRemainder(toCents(total), count)) {
          expect(share % 10).toBe(0);
        }
      }
    }
  });

  it('puts a sub-cent part of the total on the first share only', () => {
    expect(distributeRemainder(toCents(80765), 2)).toEqual([40385, 40380]);
    expect(distributeRemainder(toCents(1), 3)).toEqual([1, 0, 0]);
    expect(distributeRemainder(toCents(29), 3)).toEqual([19, 10, 0]);
  });

  it('always sums back to the total', () => {
    for (const total of [1, 7, 99, 100, 12345, 54070]) {
      for (const count of [1, 2, 3, 7, 11]) {
        const shares = distributeRemainder(toCents(total), count);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      }
    }
  });

  it('rejects a non-positive or fractional count', () => {
    expect(() => distributeRemainder(toCents(100), 0)).toThrow();
    expect(() => distributeRemainder(toCents(100), -1)).toThrow();
    expect(() => distributeRemainder(toCents(100), 1.5)).toThrow();
  });

  it('rejects a negative total', () => {
    expect(() => distributeRemainder(toCents(-100), 2)).toThrow();
  });
});
