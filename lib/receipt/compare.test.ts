import { describe, it, expect } from 'vitest';
import { mismatchToleranceCents, totalsMismatch } from './compare';

// Amounts are integer minor units (thousandths of a dollar): $1 = 1000.

describe('mismatchToleranceCents', () => {
  it('is $2 for small transactions (floor dominates)', () => {
    expect(mismatchToleranceCents(10000)).toBe(2000); // 5% of $10 is 50¢ < $2
  });

  it('is 5% for large transactions', () => {
    expect(mismatchToleranceCents(100000)).toBe(5000); // 5% of $100 is $5
    expect(mismatchToleranceCents(-100000)).toBe(5000); // sign-agnostic
  });
});

describe('totalsMismatch', () => {
  it('accepts an exact match', () => {
    expect(totalsMismatch(35840, 35840)).toBe(false);
  });

  it('accepts differences within the tolerance', () => {
    // $35.84 transaction → tolerance max(1792, 2000) = 2000.
    expect(totalsMismatch(35840 - 2000, 35840)).toBe(false);
    expect(totalsMismatch(35840 + 2000, 35840)).toBe(false);
  });

  it('warns just past the tolerance', () => {
    expect(totalsMismatch(35840 - 2001, 35840)).toBe(true);
    expect(totalsMismatch(35840 + 2001, 35840)).toBe(true);
  });

  it('warns on the fixture case: $20.80 receipt vs $35.84 transaction', () => {
    expect(totalsMismatch(20800, 35840)).toBe(true);
  });

  it('uses the 5% band on large amounts', () => {
    // $200 transaction → tolerance $10.
    expect(totalsMismatch(209999, 200000)).toBe(false);
    expect(totalsMismatch(210001, 200000)).toBe(true);
  });

  it('compares against the absolute transaction amount', () => {
    expect(totalsMismatch(10000, -10000)).toBe(false);
  });
});
