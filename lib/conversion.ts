// Whether a raised row can be converted into a purchase paid alongside
// (PAID-ALONGSIDE.md), and if not, why. Pure: one set of rules for the
// conversion itself (db/alongside.ts, inside its transaction), the Move
// button, the raised-rows filter and the Needs you band, so nothing offers a
// conversion the conversion will refuse (2026-11-06: the demo's raised car
// hire, split by amount, was offered Move, and the dialog's Convert could
// never be pressed).
import { dedupHash } from './parsers/dedup';
import { formatUSD, toCents } from './money';

// The amount a CSV or manual row came in with, when only its amount was
// raised since: the amount below the current one whose dedup_hash, with the
// row's date and description as they are, is the stored one. Null when none
// is (the date or description changed too, or it was edited before the
// 2026-07-30 rescale recomputed the hashes).
export function importedAmountBelow(row: {
  source: string;
  accountLabel: string | null;
  date: string;
  amountCents: number;
  descriptionRaw: string;
  dedupHash: string;
}): number | null {
  for (let cents = 1; cents * 10 < row.amountCents; cents++) {
    const amountCents = cents * 10;
    if (dedupHash({ ...row, amountCents }) === row.dedupHash) return amountCents;
  }
  return null;
}

export type ConversionCheck =
  | { ok: true; originalCents: number; extraCents: number; partCents: number }
  | { error: string };

export function conversionCheck(input: {
  row: {
    deleted: boolean;
    providerTransactionId: string | null;
    dedupHash: string | null;
    source: string;
    accountLabel: string | null;
    date: string;
    amountCents: number;
    descriptionRaw: string;
  } | null;
  // The row's split, if any: whether the owner paid it, and its method.
  split: { paidByOwner: boolean; method: string } | null;
  shareAmounts: readonly number[];
  // A live purchase already recorded alongside the row for the extra.
  alongsideForExtra: (extraCents: number) => string | null;
}): ConversionCheck {
  const { row, split } = input;
  if (!row || row.deleted) return { error: 'That transaction no longer exists.' };
  if (row.providerTransactionId !== null || row.dedupHash === null) {
    return { error: 'Only a CSV or manual row can be converted; a synced row is the bank’s.' };
  }
  if (dedupHash(row) === row.dedupHash) return { error: 'This row has the amount it came in with; there is nothing to move.' };
  const original = importedAmountBelow({ ...row, dedupHash: row.dedupHash });
  if (original === null) {
    return {
      error:
        'The amount this row came in with cannot be recovered (its date or description changed too, or it was edited before Jul 30), so it is not converted.',
    };
  }
  if (!split || !split.paidByOwner || split.method !== 'equal') return { error: 'Only a row with an equal split you paid is converted.' };
  const people = input.shareAmounts.length;
  const extra = row.amountCents - original;
  if (people === 0 || extra % (people * 10) !== 0) {
    return { error: `The extra does not divide evenly in whole cents among ${people} people, so it is not converted.` };
  }
  const part = extra / people;
  if (input.shareAmounts.some((a) => a < part)) return { error: 'A share is smaller than its part of the extra; not converted.' };
  const already = input.alongsideForExtra(extra);
  if (already !== null) {
    return {
      error: `"${already}" for ${formatUSD(toCents(extra))} is already recorded alongside this row, so converting would record the extra a second time. If that row is the extra, delete it, then convert.`,
    };
  }
  return { ok: true, originalCents: original, extraCents: extra, partCents: part };
}
