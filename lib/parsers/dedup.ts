import { createHash } from 'node:crypto';

// Fields that identify a transaction for deduplication. Named, not positional:
// a 5-argument positional call is exactly how a caller silently swaps two
// strings and card B's rows dedup as card A's six months from now.
export type DedupFields = {
  source: string;
  accountLabel: string | null;
  date: string; // ISO YYYY-MM-DD
  amountCents: number;
  descriptionRaw: string;
};

// Canonical string form, FROZEN:
//   `${source}|${accountLabel ?? ''}|${date}|${amountCents}|${descriptionRaw}`
// - Delimiter: '|'
// - accountLabel null is normalized to '' (so null and '' hash identically)
// - Field order: source, accountLabel, date, amountCents, descriptionRaw
// The string is built from named fields, never Object.values(), so call-site
// key order is irrelevant.
//
// Changing the delimiter, the null representation, or the field order changes
// every hash this function has ever produced. That is a breaking change: it
// invalidates every dedup_hash already stored and requires a full backfill of
// the transactions table.
function canonicalString(fields: DedupFields): string {
  const { source, accountLabel, date, amountCents, descriptionRaw } = fields;
  return `${source}|${accountLabel ?? ''}|${date}|${amountCents}|${descriptionRaw}`;
}

export function dedupHash(fields: DedupFields): string {
  return createHash('sha256').update(canonicalString(fields)).digest('hex');
}
