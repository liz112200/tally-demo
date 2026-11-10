// Why a statement's figures differ from its period's rows, as facts the app
// can show rather than a cause it guesses (ACCOUNTS-BOARD.md, reviews). Pure.
//
// Two facts move a purchase between the statement and the period's rows:
//   - a held bank row answered "same purchase": the statement counts the
//     bank's row by its posting date, the ledger keeps the CSV row by its own
//     date, and the two can fall in different periods;
//   - a CSV row raised after import: the ledger has the raised amount, the
//     bank's statement the amount charged.
// Each is stated with its dates and amount, and the sum is compared with the
// difference: whatever they do not account for is said, never absorbed.

export type HeldFact = { postedDate: string; twinDate: string; amountCents: number; answeredOn: string };
export type RaisedFact = { date: string; originalCents: number; currentCents: number };

export type Explanation = {
  lines: string[];
  // Rows minus statement left after the facts, each side; zero when the
  // facts account for the whole difference.
  leftCharges: number;
  leftCredits: number;
};

export function explainDifference(input: {
  from: string;
  to: string;
  chargesDiff: number;
  creditsDiff: number;
  held: readonly HeldFact[];
  raised: readonly RaisedFact[];
  day: (iso: string) => string;
  money: (mills: number) => string;
}): Explanation {
  const { from, to, day, money } = input;
  const inside = (d: string) => d >= from && d <= to;
  const lines: string[] = [];
  let charges = 0;
  let credits = 0;
  const add = (amountCents: number, delta: 1 | -1) => {
    if (amountCents > 0) charges += delta * amountCents;
    else credits += delta * -amountCents;
  };

  for (const h of input.held) {
    const size = money(Math.abs(h.amountCents));
    if (inside(h.postedDate) && !inside(h.twinDate)) {
      add(h.amountCents, -1);
      lines.push(
        `A held bank row posted ${day(h.postedDate)}, answered the same purchase on ${day(h.answeredOn)}, matches a CSV row dated ${day(h.twinDate)}, in the ${h.twinDate < from ? 'previous' : 'next'} period: ${size} less here.`,
      );
    } else if (inside(h.twinDate) && !inside(h.postedDate)) {
      add(h.amountCents, 1);
      lines.push(
        `A CSV row dated ${day(h.twinDate)} is the same purchase as a held bank row posted ${day(h.postedDate)}, in the ${h.postedDate > to ? 'next' : 'previous'} period, answered on ${day(h.answeredOn)}: ${size} more here.`,
      );
    }
  }
  for (const r of input.raised) {
    if (!inside(r.date) || r.currentCents === r.originalCents) continue;
    const extra = r.currentCents - r.originalCents;
    add(extra, 1);
    lines.push(`A CSV row dated ${day(r.date)} was raised after import from ${money(r.originalCents)} to ${money(r.currentCents)}: ${money(Math.abs(extra))} ${extra > 0 ? 'more' : 'less'} here.`);
  }
  return { lines, leftCharges: input.chargesDiff - charges, leftCredits: input.creditsDiff - credits };
}
