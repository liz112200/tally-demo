import { describe, expect, it } from 'vitest';
import { reviewApplies } from './review';

describe('reviewApplies', () => {
  const review = { chargesDiffCents: -3_000, creditsDiffCents: 0 };
  it('applies only to the exact figures it accepted', () => {
    expect(reviewApplies(review, { chargesDiff: -3_000, creditsDiff: 0 })).toBe(true);
  });
  it('lapses when either side moves, by any amount, either way', () => {
    expect(reviewApplies(review, { chargesDiff: -3_010, creditsDiff: 0 })).toBe(false);
    expect(reviewApplies(review, { chargesDiff: -2_990, creditsDiff: 0 })).toBe(false);
    expect(reviewApplies(review, { chargesDiff: -3_000, creditsDiff: 10 })).toBe(false);
    expect(reviewApplies(review, { chargesDiff: 3_000, creditsDiff: 0 })).toBe(false);
  });
  it('does not apply without a review', () => {
    expect(reviewApplies(undefined, { chargesDiff: -3_000, creditsDiff: 0 })).toBe(false);
  });
});
