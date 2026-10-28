// Sign verification against a statement (REAL-ACCOUNTS.md). Pure.
//
// Sandbox cannot show whether a real card's payments arrive negative, and a
// wrong sign would look plausible, so an account's synced rows count only
// once the owner has checked them against a statement. The owner enters the
// statement's two totals; the fetched rows for its period (by the posted
// date statements group by) are summed and compared to the cent, after any
// rows the owner marks as not on the statement (a charge pending at close,
// posted in the next period). The rows most likely to carry a wrong sign are
// listed for the owner to tick: every negative row (payments, credits,
// refunds; deposits on checking) and the five largest positive ones.
export type FetchedRow = { key: string; postedDate: string; amountCents: number; description: string };

export type Statement = {
  from: string;
  to: string;
  // Positive amounts, as printed. Charges: purchases + fees + interest on a
  // card, withdrawals on checking. Credits: payments + credits on a card,
  // deposits on checking.
  chargesCents: number;
  creditsCents: number;
};

export type VerificationResult = {
  fetchedChargesCents: number;
  fetchedCreditsCents: number;
  chargesMatch: boolean;
  creditsMatch: boolean;
  // Rows to tick against the statement.
  toCheck: FetchedRow[];
  excluded: FetchedRow[];
  passed: boolean;
};

export function compareToStatement(input: {
  rows: readonly FetchedRow[];
  statement: Statement;
  // Keys of rows the owner marks as not on this statement.
  excludedKeys: ReadonlySet<string>;
  // The owner ticked every listed row against the statement.
  confirmed: boolean;
}): VerificationResult {
  const inPeriod = input.rows.filter((r) => r.postedDate >= input.statement.from && r.postedDate <= input.statement.to);
  const excluded = inPeriod.filter((r) => input.excludedKeys.has(r.key));
  const counted = inPeriod.filter((r) => !input.excludedKeys.has(r.key));
  const fetchedChargesCents = counted.filter((r) => r.amountCents > 0).reduce((n, r) => n + r.amountCents, 0);
  const fetchedCreditsCents = -counted.filter((r) => r.amountCents < 0).reduce((n, r) => n + r.amountCents, 0);
  const negatives = counted.filter((r) => r.amountCents < 0);
  const largest = counted
    .filter((r) => r.amountCents > 0)
    .sort((a, b) => b.amountCents - a.amountCents || a.postedDate.localeCompare(b.postedDate))
    .slice(0, 5);
  const chargesMatch = fetchedChargesCents === input.statement.chargesCents;
  const creditsMatch = fetchedCreditsCents === input.statement.creditsCents;
  return {
    fetchedChargesCents,
    fetchedCreditsCents,
    chargesMatch,
    creditsMatch,
    toCheck: [...negatives, ...largest],
    excluded,
    // A statement with nothing in it verifies nothing.
    passed: chargesMatch && creditsMatch && input.confirmed && counted.length > 0,
  };
}
