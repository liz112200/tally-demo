import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import postgres from 'postgres';
import { formatUSD, toCents } from '../lib/money';

// ONE-TIME DATA MIGRATION: round open sub-cent shares to whole cents.
//
// Shares now divide in whole cents (lib/money.ts, distributeRemainder).
// Splits saved earlier can hold mill shares such as 4995 ($4.995), which
// display rounded and leave a remainder no payment can clear. This rounds
// each such share DOWN to the cent and gives the mills to the owner's share
// in the same split, which is never owed, so every split still sums to what
// it did. For an equal split with the owner first in person order that is
// exactly what re-saving it produces now.
//
// Only shares nobody has paid anything toward: a share with an allocation
// would need its allocation moved, so it is left alone, and so are shares in
// splits the owner did not pay (none exist today) and on deleted
// transactions. No settlement or allocation row is written. The shares are
// locked FOR UPDATE before the allocation check, which also blocks a
// concurrent allocation against them (its foreign-key check needs a lock on
// the share), so the check cannot go stale before the update.
//
// Usage: npx tsx db/round-open-shares.ts <env file> [--apply --expect <n>]
// Without --apply it does everything inside a transaction and rolls back,
// printing what it would change. --apply commits, and only if exactly
// <n> shares qualify. Guarded by a data_migrations marker, so a second run
// is a no-op.
const MARKER = 'round_open_shares_to_cents_v1';

const args = process.argv.slice(2);
const envFile = args[0];
if (!envFile || envFile.startsWith('--')) {
  throw new Error('Usage: npx tsx db/round-open-shares.ts <env file> [--apply --expect <n>]');
}
const apply = args.includes('--apply');
const expectIndex = args.indexOf('--expect');
const expected = expectIndex >= 0 ? Number(args[expectIndex + 1]) : null;
if (apply && (expected === null || !Number.isInteger(expected))) {
  throw new Error('--apply requires --expect <number of shares>');
}

const connectionString = parse(readFileSync(envFile)).DATABASE_URL;
if (!connectionString) throw new Error(`DATABASE_URL is not set in ${envFile}`);

class RolledBack extends Error {}

type Line = { person: string; shown: number };

async function main() {
  const sql = postgres(connectionString!, { prepare: false, max: 1, onnotice() {} });
  try {
    await sql.begin(async (tx) => {
      const [{ branch }] = await tx`select current_setting('neon.branch_id', true) as branch`;
      console.log(`${envFile}: branch=${branch}${apply ? '' : ' (preview, rolled back)'}`);
      await tx`
        CREATE TABLE IF NOT EXISTS data_migrations (
          name text PRIMARY KEY,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`;
      if ((await tx`SELECT 1 FROM data_migrations WHERE name = ${MARKER}`).length > 0) {
        console.log(`Already applied (${MARKER}); nothing to do.`);
        return;
      }

      const [{ id: ownerId }] = await tx`SELECT id FROM persons WHERE is_owner`;

      // Candidate shares and their owner shares, locked before anything is read
      // from them.
      await tx`
        SELECT ss.id FROM split_shares ss
        JOIN splits s ON s.id = ss.split_id
        JOIN transactions t ON t.id = s.transaction_id
        WHERE t.deleted_at IS NULL AND s.payer_person_id = ${ownerId}
          AND (ss.amount_cents % 10 <> 0 OR ss.person_id = ${ownerId})
        ORDER BY ss.id
        FOR UPDATE OF ss`;
      const targets = await tx`
        SELECT ss.id, ss.split_id, ss.person_id, ss.amount_cents::bigint AS amount,
               (ss.amount_cents % 10)::int AS mills,
               (SELECT o.id FROM split_shares o WHERE o.split_id = ss.split_id AND o.person_id = ${ownerId}) AS owner_share_id
        FROM split_shares ss
        JOIN splits s ON s.id = ss.split_id
        JOIN transactions t ON t.id = s.transaction_id
        WHERE t.deleted_at IS NULL AND s.payer_person_id = ${ownerId}
          AND ss.person_id <> ${ownerId}
          AND ss.amount_cents % 10 <> 0
          AND NOT EXISTS (SELECT 1 FROM settlement_allocations a WHERE a.split_share_id = ss.id)
        ORDER BY ss.id`;
      console.log(`${targets.length} open sub-cent share(s) in ${new Set(targets.map((r) => r.split_id)).size} split(s).`);
      if (targets.length === 0) return;
      for (const r of targets) {
        if (!r.owner_share_id) throw new Error(`Split ${r.split_id} has no owner share to absorb the mills.`);
      }

      const letters = new Map<string, string>();
      for (const r of targets) {
        if (!letters.has(r.person_id)) letters.set(r.person_id, `Person ${letters.size + 1}`);
      }
      const before = await snapshot(tx, letters);

      for (const r of targets) {
        await tx`UPDATE split_shares SET amount_cents = amount_cents - ${r.mills} WHERE id = ${r.id}`;
        await tx`UPDATE split_shares SET amount_cents = amount_cents + ${r.mills} WHERE id = ${r.owner_share_id}`;
      }

      const after = await snapshot(tx, letters);

      // What must not have moved.
      for (const key of ['splitTotals', 'settlements', 'allocations'] as const) {
        if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
          throw new Error(`${key} changed; refusing.`);
        }
      }
      const [{ left }] = await tx`
        SELECT count(*)::int AS left FROM split_shares WHERE id IN ${tx(targets.map((r) => r.id))} AND amount_cents % 10 <> 0`;
      if (left !== 0) throw new Error(`${left} share(s) still sub-cent; refusing.`);

      console.log(`unchanged: ${before.splitTotals.length} split totals, ${before.settlements.n} settlements (${before.settlements.sum} mills), ` +
        `${before.allocations.n} allocations (${before.allocations.sum} mills)`);
      console.log(`mills moved from people to the owner's own shares: ${targets.reduce((n, r) => n + r.mills, 0)}`);
      console.log('\nper person (incoming; lines as /people shows them: unpaid share amount, or outstanding when partial):');
      for (const [personId, name] of letters) {
        for (const [label, s] of [['before', before], ['after ', after]] as const) {
          const p = s.people.get(personId)!;
          const sumShown = p.lines.reduce((n, l) => n + l.shown, 0);
          console.log(
            `  ${name} ${label}: balance ${p.owed} mills, shown ${usd(p.owed)}; ` +
              `${p.lines.length} line(s) shown summing to ${usd(sumShown)} ` +
              `${usd(sumShown) === usd(p.owed) ? '(matches)' : '(DOES NOT MATCH)'}`,
          );
        }
      }
      for (const [label, s] of [['before', before], ['after', after]] as const) {
        const mismatched = [...s.people.entries()].filter(([, p]) => usd(p.lines.reduce((n, l) => n + l.shown, 0)) !== usd(p.owed));
        console.log(`people whose shown lines do not sum to their shown balance, ${label}: ${mismatched.length}`);
      }

      if (!apply) throw new RolledBack();
      if (targets.length !== expected) {
        throw new Error(`Expected ${expected} share(s), found ${targets.length}; nothing applied.`);
      }
      await tx`INSERT INTO data_migrations (name) VALUES (${MARKER})`;
      console.log(`\nApplied: ${targets.length} share(s) rounded to whole cents.`);
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
    console.log('\nPreview only: rolled back, nothing changed.');
  } finally {
    await sql.end();
  }
}

// Mills rounded half to even to whole cents and printed, exactly as the app
// displays them.
function usd(mills: number): string {
  return formatUSD(toCents(mills));
}
function cents(mills: number): number {
  const q = Math.floor(mills / 10);
  const r = mills - q * 10;
  return (r > 5 || (r === 5 && q % 2 === 1) ? q + 1 : q) * 10;
}

async function snapshot(tx: postgres.TransactionSql, letters: Map<string, string>) {
  const splitTotals = await tx`
    SELECT split_id, sum(amount_cents)::bigint::text AS total FROM split_shares GROUP BY split_id ORDER BY split_id`;
  const [settlements] = await tx`SELECT count(*)::int AS n, coalesce(sum(amount_cents), 0)::bigint::text AS sum FROM settlements`;
  const [allocations] = await tx`
    SELECT count(*)::int AS n, coalesce(sum(amount_cents), 0)::bigint::text AS sum FROM settlement_allocations`;
  // Every person's incoming shares on live transactions, with what has been
  // allocated to each, as the balance and the /people lines read them.
  const rows = await tx`
    SELECT ss.person_id, ss.amount_cents::bigint AS amount,
           coalesce((SELECT sum(a.amount_cents) FROM settlement_allocations a WHERE a.split_share_id = ss.id), 0)::bigint AS alloc
    FROM split_shares ss
    JOIN splits s ON s.id = ss.split_id
    JOIN transactions t ON t.id = s.transaction_id
    WHERE t.deleted_at IS NULL AND ss.person_id <> s.payer_person_id`;
  const people = new Map<string, { owed: number; lines: Line[] }>();
  for (const r of rows) {
    const amount = Number(r.amount);
    const alloc = Number(r.alloc);
    const outstanding = Math.max(0, amount - alloc);
    const p = people.get(r.person_id) ?? { owed: 0, lines: [] };
    p.owed += outstanding;
    // Settled lines show "settled" and no amount; unpaid ones the share,
    // partial ones what is left.
    if (outstanding > 0) p.lines.push({ person: letters.get(r.person_id) ?? '', shown: cents(alloc > 0 ? outstanding : amount) });
    people.set(r.person_id, p);
  }
  return { splitTotals, settlements, allocations, people };
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
