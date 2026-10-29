import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import postgres from 'postgres';

// ONE-TIME DATA MIGRATION (REAL-ACCOUNTS.md, one account, one basis): a
// synced row on a posted-basis ledger account (Chase checking) was stored on
// its purchase date while the account's CSV rows, its cutover and its
// statements use the posting date. Sync now stores the posting date; this
// moves the rows synced before that to it.
//
// It writes transactions.date only, on synced rows of posted-basis ledger
// accounts whose date is not their posting date (provider_raw.date). It
// refuses a row that has a split, a receipt or a note, and prints how many
// rows change month (none, 2026-10-29). Every other column of every
// transactions row is fingerprinted before and after inside the same
// database transaction and must be identical, or nothing commits.
//
// Usage: npx tsx db/ledger-date-basis.ts <env file> [--apply --expect <rows>]
// Without --apply it does everything inside a transaction and rolls back.
// Before anything it prints the database's now(), the point-in-time restore
// timestamp. A second run changes nothing.
const args = process.argv.slice(2);
const envFile = args[0];
if (!envFile || envFile.startsWith('--')) throw new Error('Usage: npx tsx db/ledger-date-basis.ts <env file> [--apply --expect <rows>]');
const apply = args.includes('--apply');
const expectIndex = args.indexOf('--expect');
const expected = expectIndex >= 0 ? Number(args[expectIndex + 1]) : null;
if (apply && (expected === null || !Number.isInteger(expected))) throw new Error('--apply requires --expect <rows>');
const connectionString = parse(readFileSync(envFile)).DATABASE_URL;
if (!connectionString) throw new Error(`DATABASE_URL is not set in ${envFile}`);

class RolledBack extends Error {}

async function main() {
  const sql = postgres(connectionString!, { prepare: false, max: 1, onnotice() {} });
  try {
    await sql.begin(async (tx) => {
      const [{ branch, now }] = await tx`select current_setting('neon.branch_id', true) as branch, now()::text as now`;
      console.log(`${envFile}: branch=${branch}${apply ? '' : ' (preview, rolled back)'}`);
      console.log(`Restore point (database now()): ${now}`);
      const fingerprint = async () =>
        (await tx`select count(*)::int as n, md5(coalesce(string_agg((to_jsonb(t) - 'date')::text, '|' order by t.id), '')) as h from transactions t`)[0];
      const before = await fingerprint();
      console.log(`every column but date: ${before.n} rows, fingerprint ${before.h}`);

      const rows = await tx`
        select t.id, t.date::text as stored, t.provider_raw->>'date' as posted, t.amount_cents, t.description_raw,
          exists (select 1 from splits s where s.transaction_id = t.id) as split,
          exists (select 1 from receipts r where r.transaction_id = t.id) as receipt, t.note is not null as note
        from transactions t join bank_accounts b on b.id = t.bank_account_id join ledger_accounts l on l.id = b.ledger_account_id
        where l.cutover_basis = 'posted' and t.provider_raw->>'date' is not null and t.date <> (t.provider_raw->>'date')::date
        order by t.date
        for update of t`;
      const builtOn = rows.filter((r) => r.split || r.receipt || r.note);
      if (builtOn.length > 0) throw new Error(`Rows with a split, receipt or note, not moved: ${builtOn.map((r) => r.id).join(', ')}`);
      for (const r of rows) {
        console.log(`  ${r.stored} -> ${r.posted}  ${(Number(r.amount_cents) / 1000).toFixed(2).padStart(9)}  ${String(r.description_raw).slice(0, 40)}`);
      }
      console.log(`rows changing month: ${rows.filter((r) => r.stored.slice(0, 7) !== String(r.posted).slice(0, 7)).length}`);
      const moved = rows.length
        ? await tx`update transactions set date = (provider_raw->>'date')::date where id = any(${tx.array(rows.map((r) => r.id))}::uuid[]) returning id`
        : [];
      const after = await fingerprint();
      console.log(`every column but date: ${after.n} rows, fingerprint ${after.h}`);
      if (after.n !== before.n || after.h !== before.h) throw new Error('A column other than date changed; nothing was committed.');
      console.log(`rows moved to their posting date: ${moved.length}`);
      if (!apply) throw new RolledBack();
      if (moved.length !== expected) throw new Error(`Expected ${expected} rows, would move ${moved.length}; nothing was committed.`);
    });
    console.log('Committed.');
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
    console.log('Preview only; nothing changed. Run again with --apply --expect <rows>.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
