import { config } from 'dotenv';
import postgres from 'postgres';
import { dedupHash } from '../lib/parsers/dedup';

config({ path: '.env.local' });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// ONE-TIME DATA MIGRATION: hundredths (cents) -> thousandths (mills).
//
// The money unit widened from 1/100 to 1/1000 of a dollar so amounts like
// 80.765 are representable (see lib/money.ts). Column types are unchanged
// (bigint), so this is a pure data rescale with no Drizzle schema diff — hence
// a standalone script, run once against the live database, rather than a
// generated migration. A fresh database has no rows, so it never needs this.
//
// Every stored money value is multiplied by 10. transactions.dedup_hash is
// recomputed from the new amount so a re-import of the same bank row still
// dedups (the hash is derived from amount_cents; rescaling it without
// recomputing would silently break dedup across the unit change).
//
// Guarded by a marker row (data_migrations), so committing this file is safe
// and a second run is a no-op instead of a catastrophic ×100.
const MARKER = 'rescale_to_mills_v1';

async function main() {
  const sql = postgres(connectionString!, { prepare: false });
  try {
    await sql.begin(async (tx) => {
      await tx`
        CREATE TABLE IF NOT EXISTS data_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`;
      const already = await tx`SELECT 1 FROM data_migrations WHERE name = ${MARKER}`;
      if (already.length > 0) {
        console.log(`Already applied (${MARKER}); nothing to do.`);
        return;
      }

      // Scale every money column ×10. input_amount_cents is nullable;
      // NULL * 10 stays NULL. settlement_allocations is empty today but
      // scaled for completeness.
      await tx`UPDATE transactions SET amount_cents = amount_cents * 10`;
      await tx`UPDATE splits SET tax_cents = tax_cents * 10, tip_cents = tip_cents * 10`;
      await tx`UPDATE split_shares SET amount_cents = amount_cents * 10, input_amount_cents = input_amount_cents * 10`;
      await tx`UPDATE receipts SET subtotal_cents = subtotal_cents * 10, tax_cents = tax_cents * 10, tip_cents = tip_cents * 10, total_cents = total_cents * 10`;
      await tx`UPDATE receipt_items SET amount_cents = amount_cents * 10`;
      await tx`UPDATE settlements SET amount_cents = amount_cents * 10`;
      await tx`UPDATE settlement_allocations SET amount_cents = amount_cents * 10`;

      // Recompute dedup_hash from the NEW amount, using the same canonical
      // string the importer hashes (date as YYYY-MM-DD, null account label
      // normalized to '').
      const rows = await tx`
        SELECT id, source, account_label,
               to_char(date, 'YYYY-MM-DD') AS date,
               amount_cents, description_raw
        FROM transactions`;
      for (const r of rows) {
        const hash = dedupHash({
          source: r.source,
          accountLabel: r.account_label,
          date: r.date,
          amountCents: Number(r.amount_cents),
          descriptionRaw: r.description_raw,
        });
        await tx`UPDATE transactions SET dedup_hash = ${hash} WHERE id = ${r.id}`;
      }

      await tx`INSERT INTO data_migrations (name) VALUES (${MARKER})`;
      console.log(`Rescaled ${rows.length} transactions and all money columns ×10; recomputed dedup hashes.`);
    });
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
