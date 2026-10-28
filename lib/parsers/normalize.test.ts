import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsv } from './csv';
import { chaseParser } from './chase';
import { discoverParser } from './discover';
import { amexParser } from './amex';
import { normalizeMerchant } from './normalize';
import { categorize, type CategoryRule } from '../categorize';

describe('normalizeMerchant', () => {
  const cases: [string, string][] = [
    ['UBER TECHNOLOGIES, INC WILMINGTON DE         07/05', 'UBER TECHNOLOGIES, INC WILMINGTON'],
    ['APPLE.COM/BILL 866-555-0142 CA               08/06', 'APPLE.COM/BILL'],
    ['UBER *TRIP 866-555-0101 CAAPPLE PAY ENDING IN ****', 'UBER *TRIP'],
    ['MARATHON 412204 RIVERTON INAPPLE PAY ENDING IN ****', 'MARATHON 412204 RIVERTON'],
    ['WEEE INC. 510-555-0177 CAAPPLE PAY ENDING IN ****', 'WEEE INC.'],
    ['WALMART.COM 800-555-0123 AR', 'WALMART.COM'],
    ['HERTZ CAR RENTAL    RIVERTON            IL', 'HERTZ CAR RENTAL RIVERTON'],
    ['TST*CORNER SANDWICHES OAKDALE ILAPPLE PAY ENDING IN ****00001111222233334444AA', 'TST*CORNER SANDWICHES OAKDALE'],
    ['NORTHWIND LABS   PAYROLL                    PPD ID: 9111111111', 'NORTHWIND LABS PAYROLL PPD ID:'],
    ['AplPay NOODLE BARNEW YORK NY', 'NOODLE BARNEW YORK'],
  ];
  for (const [input, expected] of cases) {
    it(`normalizes ${JSON.stringify(input.slice(0, 24))}...`, () => {
      expect(normalizeMerchant(input)).toBe(expected);
    });
  }
});

// The seed rule set (patterns from db/seed.ts), with the category name standing
// in for the category id so the expectations read clearly.
const SEED: CategoryRule[] = [
  { categoryId: 'Transport', matchPattern: 'UBER|LYFT', matchType: 'regex', priority: 100, createdAt: '2026-01-01' },
  { categoryId: 'Transport', matchPattern: 'MARATHON', matchType: 'substring', priority: 100, createdAt: '2026-01-01' },
  { categoryId: 'Travel', matchPattern: 'HERTZ', matchType: 'substring', priority: 100, createdAt: '2026-01-01' },
  { categoryId: 'Shopping', matchPattern: 'AMAZON', matchType: 'substring', priority: 100, createdAt: '2026-01-01' },
  { categoryId: 'Shopping', matchPattern: 'WALMART', matchType: 'substring', priority: 100, createdAt: '2026-01-01' },
  { categoryId: 'Groceries', matchPattern: 'WEEE', matchType: 'substring', priority: 100, createdAt: '2026-01-01' },
  { categoryId: 'Dining', matchPattern: 'TST*', matchType: 'substring', priority: 100, createdAt: '2026-01-01' },
];

const read = (bank: string) =>
  readFileSync(join(process.cwd(), `tests/fixtures/${bank}/sample.csv`), 'utf8');

function categoriesFor(bank: string, parser: { parseRows: (r: string[][]) => { descriptionRaw: string }[] }) {
  return parser
    .parseRows(parseCsv(read(bank)).slice(1))
    .map((r) => categorize(normalizeMerchant(r.descriptionRaw), SEED));
}

describe('seed rules over every fixture row', () => {
  it('chase: only UBER and TST* rows match; payroll/Zelle/transfers stay null', () => {
    expect(categoriesFor('chase', chaseParser)).toEqual([
      null, // WITHDRAWAL
      null, // DISCOVER E-PAYMENT (transfer)
      null, // Zelle from
      null, // APPLE.COM/BILL
      null, // PP* charge
      null, // PP* refund
      null, // PAYROLL
      null, // FOREIGN EXCHANGE FEE
      null, // Grab foreign
      null, // Zelle to
      null, // CITY PAYMENT
      'Transport', // UBER TECHNOLOGIES
      'Dining', // TST*HARBOR
    ]);
  });

  it('discover: 8 of 12 rows match', () => {
    expect(categoriesFor('discover', discoverParser)).toEqual([
      null, // RIVERTON FISH MARKET (skipped, ambiguous)
      'Transport', // UBER *TRIP
      null, // IL SOS
      'Dining', // TST*CORNER
      null, // DIRECTPAY (payment)
      'Shopping', // AMAZON PRIME
      'Shopping', // AMAZON MKTPL
      'Groceries', // WEEE
      'Transport', // MARATHON
      null, // NOTION LABS (skipped, ambiguous)
      'Shopping', // AMAZON MKTPL
      'Shopping', // WALMART.COM
    ]);
  });

  it('amex: both HERTZ rows match Travel', () => {
    expect(categoriesFor('amex', amexParser)).toEqual(['Travel', 'Travel']);
  });
});
