import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { cannedExtraction } from './canned-receipt';

describe('cannedExtraction', () => {
  it('sizes a realistic dinner receipt to the transaction', () => {
    const r = cannedExtraction(8_437);
    expect(r.total_cents).toBe(8_437);
    expect(r.items).toHaveLength(6);
    expect(r.tax_cents).toBeGreaterThan(0);
    expect(r.tip_cents).toBeGreaterThan(r.tax_cents);
  });

  it('always adds up: items to the subtotal, and subtotal + tax + tip to the total', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), (total) => {
        const r = cannedExtraction(total);
        expect(r.items.reduce((acc, i) => acc + i.amount_cents, 0)).toBe(r.subtotal_cents);
        expect(r.subtotal_cents + r.tax_cents + r.tip_cents).toBe(total);
        for (const v of [r.subtotal_cents, r.tax_cents, r.tip_cents]) expect(v).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
