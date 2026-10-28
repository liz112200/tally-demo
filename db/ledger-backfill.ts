import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import postgres from 'postgres';

// ONE-TIME DATA MIGRATION (bank sync slice 7, REAL-ACCOUNTS.md): map the CSV
// imports made before ledger accounts existed onto ledger accounts, one per
// source and account label, named by the owner.
//
// It writes only ledger_accounts rows and imports.ledger_account_id (which
// account a batch belongs to). No transactions row is written, and the script
// proves it: a fingerprint of every transactions row, taken before and after
// inside the same database transaction, must be identical, or nothing commits.
//
// Usage:
//   npx tsx db/ledger-backfill.ts <env file> [--name <source>[:<label>]=<name> ...] [--apply --expect <imports>]
// Without --apply it does everything inside a transaction and rolls back,
// printing the mapping: per source and label, the import batches, live and
// deleted rows, the first and last CSV row (undone imports included) and the
// cutover that last row implies. --apply commits, and only if exactly
// <imports> batches are mapped. Before anything it prints the database's
// now(), the point-in-time restore timestamp. A second run maps nothing new.
const args = process.argv.slice(2);
const envFile = args[0];
if (!envFile || envFile.startsWith('--')) {
  throw new Error('Usage: npx tsx db/ledger-backfill.ts <env file> [--name source[:label]=Name ...] [--apply --expect <imports>]');
}
const apply = args.includes('--apply');
const expectIndex = args.indexOf('--expect');
const expected = expectIndex >= 0 ? Number(args[expectIndex + 1]) : null;
if (apply && (expected === null || !Number.isInteger(expected))) throw new Error('--apply requires --expect <number of imports>');
const names = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--name') continue;
  const [key, ...rest] = (args[i + 1] ?? '').split('=');
  if (!key || rest.length === 0) throw new Error('--name takes source[:label]=Name');
  names.set(key, rest.join('='));
}

const connectionString = parse(readFileSync(envFile)).DATABASE_URL;
if (!connectionString) throw new Error(`DATABASE_URL is not set in ${envFile}`);

const DEFAULT_NAMES: Record<string, string> = { chase: 'Chase', discover: 'Discover', amex: 'Amex' };
// The date each CSV parser records (lib/parsers): posted for Chase checking,
// transaction date for Discover and Amex.
const BASIS: Record<string, 'posted' | 'transaction'> = { chase: 'posted', discover: 'transaction', amex: 'transaction' };

class RolledBack extends Error {}

const addDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

async function main() {
  const sql = postgres(connectionString!, { prepare: false, max: 1, onnotice() {} });
  try {
    await sql.begin(async (tx) => {
      const [{ branch, now }] = await tx`select current_setting('neon.branch_id', true) as branch, now()::text as now`;
      console.log(`${envFile}: branch=${branch}${apply ? '' : ' (preview, rolled back)'}`);
      console.log(`Restore point (database now()): ${now}`);
      const fingerprint = async () =>
        (await tx`select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t.id), '')) as h from transactions t`)[0];
      const before = await fingerprint();
      console.log(`transactions before: ${before.n} rows, fingerprint ${before.h}`);

      // Batches not yet mapped, with the one account label their rows carry.
      const batches = await tx`
        select i.id, i.source::text as source, i.deleted_at is not null as undone,
          array_agg(distinct coalesce(t.account_label, '')) as labels
        from imports i left join transactions t on t.import_id = i.id
        where i.ledger_account_id is null
        group by i.id`;
      const mixed = batches.filter((b) => b.labels.length > 1);
      if (mixed.length > 0) throw new Error(`Batches with more than one account label, not mapped: ${mixed.map((b) => b.id).join(', ')}`);

      const groups = new Map<string, { source: string; label: string | null; ids: string[]; undone: number }>();
      for (const b of batches) {
        const label = b.labels[0] ? b.labels[0] : null;
        const key = label ? `${b.source}:${label}` : b.source;
        const g = groups.get(key) ?? { source: b.source as string, label, ids: [] as string[], undone: 0 };
        g.ids.push(b.id as string);
        if (b.undone) g.undone += 1;
        groups.set(key, g);
      }

      let mapped = 0;
      for (const [key, g] of groups) {
        const name = names.get(key) ?? `${DEFAULT_NAMES[g.source] ?? g.source}${g.label ? ` ${g.label}` : ''}`;
        const [stats] = await tx`
          select count(*) filter (where t.deleted_at is null)::int as live,
            count(*) filter (where t.deleted_at is not null)::int as deleted,
            min(t.date)::text as first, max(t.date)::text as last
          from transactions t where t.import_id = any(${tx.array(g.ids)}::uuid[])`;
        console.log(
          `${key.padEnd(18)} -> "${name}" (${BASIS[g.source] ?? 'transaction'} date): ${g.ids.length} imports (${g.undone} undone), ` +
            `${stats.live} live rows (${stats.deleted} deleted), CSV ${stats.first} to ${stats.last}, cutover default ${stats.last ? addDay(stats.last) : 'none'}`,
        );
        await tx`
          insert into ledger_accounts (display_name, csv_source, csv_account_label, cutover_basis)
          values (${name}, ${g.source}::transaction_source, ${g.label}, ${BASIS[g.source] ?? 'transaction'}::ledger_cutover_basis)
          on conflict do nothing`;
        const [ledger] = await tx`
          select id from ledger_accounts where csv_source = ${g.source}::transaction_source and coalesce(csv_account_label, '') = ${g.label ?? ''}`;
        const updated = await tx`update imports set ledger_account_id = ${ledger.id} where id = any(${tx.array(g.ids)}::uuid[]) and ledger_account_id is null returning id`;
        mapped += updated.length;
      }

      const after = await fingerprint();
      console.log(`transactions after:  ${after.n} rows, fingerprint ${after.h}`);
      if (after.n !== before.n || after.h !== before.h) throw new Error('A transactions row changed; nothing was committed.');
      console.log(`imports mapped: ${mapped}`);
      if (!apply) throw new RolledBack();
      if (mapped !== expected) throw new Error(`Expected ${expected} imports, would map ${mapped}; nothing was committed.`);
    });
    console.log('Committed.');
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
    console.log('Preview only; nothing changed. Run again with --apply --expect <imports>.');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
