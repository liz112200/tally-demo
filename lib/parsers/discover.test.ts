import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv';
import { discoverParser } from './discover';
import { parsedTransactionSchema } from './types';

const csv = readFileSync(
  join(process.cwd(), 'tests/fixtures/discover/sample.csv'),
  'utf8',
);
const rows = discoverParser.parseRows(parseCsv(csv).slice(1));
const byDesc = (needle: string) =>
  rows.find((r) => r.descriptionRaw.includes(needle));

describe('discoverParser', () => {
  it('parses every data row in the fixture', () => {
    expect(rows.length).toBe(12);
  });

  it('tags rows as discover with a null account label', () => {
    for (const r of rows) {
      expect(r.source).toBe('discover');
      expect(r.accountLabel).toBeNull();
    }
  });

  it('keeps purchases positive (identity sign)', () => {
    expect(byDesc('RIVERTON FISH MARKET')?.amountCents).toBe(70000);
    expect(byDesc('NOTION LABS')?.amountCents).toBe(20000);
  });

  it('keeps a payment negative', () => {
    expect(byDesc('DIRECTPAY')?.amountCents).toBe(-1186400);
  });

  it('keeps a refund negative', () => {
    expect(byDesc('WALMART.COM')?.amountCents).toBe(-6750);
  });

  it('uses Trans. Date, not Post Date', () => {
    // The Walmart refund row is Trans. Date 06/20 but Post Date 06/21.
    expect(byDesc('WALMART.COM')?.date).toBe('2026-06-20');
    // First row Trans. Date 07/09.
    expect(rows[0].date).toBe('2026-07-09');
  });

  it('produces rows that all pass parsedTransactionSchema', () => {
    for (const r of rows) {
      expect(parsedTransactionSchema.safeParse(r).success).toBe(true);
    }
  });
});
