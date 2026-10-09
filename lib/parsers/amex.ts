import { parseDollars } from '../money';
import { usDateToIso } from './dates';
import type { BankParser, ParsedTransaction } from './types';

// Amex export. Charges are positive, matching the canonical sign, so the amount
// applies as-is (no negation). CAVEAT: the fixture is a brand-new card with only
// charge rows — the credit/payment/refund sign path is unverified against real
// data (see PHASE3.md). If a real Amex credit turns out not to be a plain
// negative amount, this identity mapping is where it will need adjusting.
const HEADER = ['Date', 'Description', 'Amount'] as const;

export const amexParser: BankParser = {
  bank: 'amex',
  header: HEADER,

  parseRows(dataRows): ParsedTransaction[] {
    const out: ParsedTransaction[] = [];
    for (const row of dataRows) {
      if (row.every((f) => f.trim() === '')) continue;
      if (row.length < HEADER.length) {
        throw new Error(
          `Amex row has ${row.length} columns, expected at least ${HEADER.length}`,
        );
      }

      out.push({
        date: usDateToIso(row[0]),
        amountCents: parseDollars(row[2]),
        descriptionRaw: row[1],
        source: 'amex',
        accountLabel: null,
      });
    }
    return out;
  },
};
