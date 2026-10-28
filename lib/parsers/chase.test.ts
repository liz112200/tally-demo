import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv';
import { chaseParser } from './chase';
import { parsedTransactionSchema } from './types';

const csv = readFileSync(
  join(process.cwd(), 'tests/fixtures/chase/sample.csv'),
  'utf8',
);
const dataRows = parseCsv(csv).slice(1);
const rows = chaseParser.parseRows(dataRows);

const byDesc = (needle: string) =>
  rows.find((r) => r.descriptionRaw.includes(needle));

describe('chaseParser', () => {
  it('parses every data row in the fixture', () => {
    expect(rows.length).toBe(13);
  });

  it('tags rows as chase with a null account label', () => {
    for (const r of rows) {
      expect(r.source).toBe('chase');
      expect(r.accountLabel).toBeNull();
    }
  });

  it('converts MM/DD/YYYY posting dates to ISO', () => {
    expect(rows[0].date).toBe('2026-08-14');
  });

  it('negates an outflow into positive spending', () => {
    // APPLE.COM/BILL subscription: raw -2.99 -> +2990
    expect(byDesc('APPLE.COM/BILL')?.amountCents).toBe(2990);
    // Cash withdrawal: raw -40.00 -> +40000
    expect(byDesc('WITHDRAWAL 08/14')?.amountCents).toBe(40000);
  });

  it('stores an inflow (payroll) as a negative credit', () => {
    // Payroll: raw +2180.42 -> -2180420
    expect(byDesc('NORTHWIND LABS   PAYROLL')?.amountCents).toBe(-2180420);
  });

  it('stores a refund as negative even though Details says DEBIT', () => {
    // PP*4471CODE 07/31 refund: raw +2.45 -> -2450 (Details=DEBIT is ignored)
    const refund = rows.find(
      (r) => r.descriptionRaw.includes('PP*4471CODE') && r.descriptionRaw.includes('07/31'),
    );
    expect(refund?.amountCents).toBe(-2450);
    // Its paired original charge: raw -2.45 -> +2450
    const charge = rows.find(
      (r) => r.descriptionRaw.includes('PP*4471CODE') && r.descriptionRaw.includes('08/02'),
    );
    expect(charge?.amountCents).toBe(2450);
  });

  it('keeps a comma embedded in a quoted description', () => {
    const uber = byDesc('UBER TECHNOLOGIES, INC');
    expect(uber).toBeDefined();
    expect(uber?.amountCents).toBe(38200);
  });

  it('parses the foreign-currency row', () => {
    const grab = rows.find((r) => r.descriptionRaw.includes('SINGAPORE'));
    expect(grab?.amountCents).toBe(4610); // raw -4.61 -> +4610
  });

  it('produces rows that all pass parsedTransactionSchema', () => {
    for (const r of rows) {
      expect(parsedTransactionSchema.safeParse(r).success).toBe(true);
    }
  });
});
