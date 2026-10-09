import { parseDollars } from '../money';
import { usDateToIso } from './dates';
import type { BankParser, ParsedTransaction } from './types';

// Chase checking/debit export. Note this is the *checking-account* CSV shape
// (Details / Posting Date / Balance columns). A Chase credit card exports a
// different header and sign convention and would be a separate parser with its
// own detect signature — do not extend this one to cover both.
const HEADER = [
  'Details',
  'Posting Date',
  'Description',
  'Amount',
  'Type',
  'Balance',
  'Check or Slip #',
] as const;

export const chaseParser: BankParser = {
  bank: 'chase',
  header: HEADER,

  parseRows(dataRows): ParsedTransaction[] {
    const out: ParsedTransaction[] = [];
    for (const row of dataRows) {
      // Data rows carry a trailing comma (one field more than the header); a
      // blank line would be all-empty. Skip the latter, tolerate the former.
      if (row.every((f) => f.trim() === '')) continue;
      if (row.length < HEADER.length) {
        throw new Error(
          `Chase row has ${row.length} columns, expected at least ${HEADER.length}`,
        );
      }

      // Chase checking stores outflows negative and inflows positive — the
      // opposite of our canonical (spending positive, credit/refund negative) —
      // so negate. Amount is the sole sign source: the Details column is
      // unreliable (a DEBIT-typed refund appears as a positive amount).
      const amountCents = -parseDollars(row[3]);

      out.push({
        date: usDateToIso(row[1]),
        amountCents,
        descriptionRaw: row[2],
        source: 'chase',
        accountLabel: null,
      });
    }
    return out;
  },
};
