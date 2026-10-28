import { MINOR_UNITS_PER_DOLLAR } from '../money';

// Receipt-total vs transaction-amount comparison (fork 5): warn when the
// difference exceeds max(5% of the transaction, $2). Common benign cause: a
// tip written on the slip after the receipt printed. The warning never
// blocks saving. Amounts are integer minor units (thousandths of a dollar),
// so the $2 floor is 2 * MINOR_UNITS_PER_DOLLAR.
export function mismatchToleranceCents(transactionAmountCents: number): number {
  const abs = Math.abs(transactionAmountCents);
  return Math.max(Math.round(abs * 0.05), 2 * MINOR_UNITS_PER_DOLLAR);
}

export function totalsMismatch(
  receiptTotalCents: number,
  transactionAmountCents: number,
): boolean {
  return (
    Math.abs(receiptTotalCents - Math.abs(transactionAmountCents)) >
    mismatchToleranceCents(transactionAmountCents)
  );
}
