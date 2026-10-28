import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv';
import { amexParser } from './amex';
import { parsedTransactionSchema } from './types';

// SPARSE FIXTURE: the Amex card is new. Its fixture is two charge rows only —
// there is no payment, refund, or foreign-currency example, so the negative
// (credit) sign path is intentionally untested here. See PHASE3.md. When a real
// credit row first imports, add it to the fixture and assert its sign.
const csv = readFileSync(
  join(process.cwd(), 'tests/fixtures/amex/sample.csv'),
  'utf8',
);
const rows = amexParser.parseRows(parseCsv(csv).slice(1));

describe('amexParser', () => {
  it('parses both charge rows in the fixture', () => {
    expect(rows.length).toBe(2);
  });

  it('keeps charges positive (identity sign)', () => {
    expect(rows[0].amountCents).toBe(96400); // 96.40
    expect(rows[1].amountCents).toBe(18750); // 18.75
  });

  it('converts the date and tags rows as amex with a null account label', () => {
    expect(rows[0].date).toBe('2026-08-12');
    for (const r of rows) {
      expect(r.source).toBe('amex');
      expect(r.accountLabel).toBeNull();
    }
  });

  it('preserves the whitespace-heavy description verbatim', () => {
    expect(rows[0].descriptionRaw).toContain('HERTZ CAR RENTAL');
    expect(rows[0].descriptionRaw).toContain('RIVERTON');
  });

  it('produces rows that all pass parsedTransactionSchema', () => {
    for (const r of rows) {
      expect(parsedTransactionSchema.safeParse(r).success).toBe(true);
    }
  });
});
