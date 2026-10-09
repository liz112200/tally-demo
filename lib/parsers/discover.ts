import { parseDollars } from '../money';
import { usDateToIso } from './dates';
import type { BankParser, ParsedTransaction } from './types';

// Discover credit card export. Discover already matches the canonical sign
// (purchases positive, payments/refunds negative), so no negation. Uses
// Trans. Date (when the purchase happened), not Post Date (bank settlement).
const HEADER = [
  'Trans. Date',
  'Post Date',
  'Description',
  'Amount',
  'Category',
] as const;

export const discoverParser: BankParser = {
  bank: 'discover',
  header: HEADER,

  parseRows(dataRows): ParsedTransaction[] {
    const out: ParsedTransaction[] = [];
    for (const row of dataRows) {
      if (row.every((f) => f.trim() === '')) continue;
      if (row.length < HEADER.length) {
        throw new Error(
          `Discover row has ${row.length} columns, expected at least ${HEADER.length}`,
        );
      }

      out.push({
        date: usDateToIso(row[0]),
        amountCents: parseDollars(row[3]),
        descriptionRaw: row[2],
        source: 'discover',
        accountLabel: null,
      });
    }
    return out;
  },
};
