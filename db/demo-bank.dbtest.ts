import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, bankConnections, categories, splitShares, splits, syncSkippedRows, transactions } from './schema';
import { getBankConnections } from './queries';
import { TABLES, UNNAMED_TABLES, wipeDemoTables, writeDemoSeed } from './demo-reset';
import { boundaryReview, lastCsvDates } from './ledger';
import { buildDemoSeed, type DemoSeed } from '@/lib/demo/seed';
import { syncConnection } from '@/app/_actions/bank';
import { runScheduledSync } from '@/app/_lib/scheduled-sync';
import { answerHeldRow, checkAgainstStatement, recordStatementCheck } from '@/app/_actions/ledger';
import { formatCents, toCents } from '@/lib/money';
import { loadBoard, needsYouFacts } from '@/app/_lib/board';
import { needsYouItems } from '@/lib/needs-you';
import { conversionChecks, convertEditedRow } from './alongside';

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// The demo's bank sync against the real commit path (DEMO-SYNC.md): the seed
// written as a reset writes it, then Sync now, the boundary review and the
// statement check through the actions, in demo mode, with no bank
// credential. This file wipes the database before and after itself; every
// other file builds its own rows.

let seed: DemoSeed;
const urls = (s: DemoSeed) => new Map(s.receipts.map((r) => [r.id, `https://blob.example.invalid/${r.id}.svg`]));
const reseed = () => db.transaction((tx) => writeDemoSeed(tx, seed, urls(seed)));
const login = (institution: string) => seed.bankConnections.find((c) => c.institutionName.startsWith(institution))!;
const accountOf = (institution: string) => seed.bankAccounts.find((a) => a.connectionId === login(institution).id)!;

beforeAll(async () => {
  seed = buildDemoSeed('2026-11-02');
  await reseed();
  process.env.DEMO_MODE = '1';
});

afterAll(async () => {
  delete process.env.DEMO_MODE;
  await db.transaction((tx) => wipeDemoTables(tx));
});

describe('the demo reset', () => {
  it('names every table in the database: those it wipes, and the sign-in tables the cascade reaches', async () => {
    const rows = (await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name`)) as unknown as { table_name: string }[];
    const present = rows.map((r) => r.table_name);
    // It looked: the migrated database has its tables.
    expect(present.length).toBeGreaterThanOrEqual(26);
    expect([...TABLES, ...UNNAMED_TABLES].sort()).toEqual(present);
  });
});

describe('the demo bank', () => {
  it('opens with a held Amex row and a raised CSV row stated as a difference', async () => {
    const review = await boundaryReview(accountOf('American Express').id);
    const held = review!.rows.filter((r) => r.kind === 'possible_duplicate');
    expect(held).toHaveLength(1);
    expect(held[0].resolution).toBeNull();
    const differs = review!.rows.filter((r) => r.differsFrom);
    expect(differs).toHaveLength(1);
    expect(differs[0].differsFrom!.amountCents - differs[0].amountCents).toBe(38_000);
  });

  it('dates each linked ledger account\'s last CSV row the day before its cutover', async () => {
    const last = await lastCsvDates();
    for (const ledger of seed.ledgerAccounts.filter((l) => l.cutoverDate)) {
      const day = new Date(`${ledger.cutoverDate}T00:00:00Z`);
      day.setUTCDate(day.getUTCDate() - 1);
      expect(last.get(ledger.id)).toBe(day.toISOString().slice(0, 10));
    }
  });

  it('brings each press through the real commit, then nothing', async () => {
    const amex = login('American Express').id;
    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await syncConnection(amex);
      if (!('ok' in result)) throw new Error(result.error);
      lines.push(...result.lines);
    }
    expect(lines).toEqual([
      'Card ••2093: 2 new (1 pending).',
      'Card ••2093: 1 posted.',
      'Card ••2093: 1 new.',
      'Card ••2093: 1 updated, 1 needs review.',
      'Card ••2093: no changes.',
    ]);
    // The tipped dinner took over its pending row, filed by the bank's category.
    const dinner = await db.select().from(transactions).where(eq(transactions.descriptionRaw, 'NORTH BRANCH BISTRO  RIVERTON            IL'));
    expect(dinner).toHaveLength(1);
    expect(dinner[0]).toMatchObject({ pending: false, amountCents: 77_040, categorySource: 'bank' });
    // The split flight changed amount: flagged, its shares exactly as they were.
    const flightSplit = seed.splits.find((s) => s.transactionId && seed.transactions.find((t) => t.id === s.transactionId)?.source === 'plaid')!;
    const [flight] = await db.select().from(transactions).where(eq(transactions.id, flightSplit.transactionId!));
    const seeded = seed.transactions.find((t) => t.id === flight.id)!;
    expect(flight).toMatchObject({ amountCents: seeded.amountCents + 35_000, bankAmountBeforeCents: seeded.amountCents });
    const shares = await db.select({ amountCents: splitShares.amountCents }).from(splitShares).innerJoin(splits, eq(splits.id, splitShares.splitId)).where(eq(splits.id, flightSplit.id));
    expect(shares.map((s) => s.amountCents).sort()).toEqual(
      seed.splitShares.filter((s) => s.splitId === flightSplit.id).map((s) => s.amountCents).sort(),
    );
  });

  it('keeps the logins in link order through a sync', async () => {
    // Two logins linked at the same instant had no order, and Amex jumped
    // above Chase after a sync (2026-11-02).
    await reseed();
    const order = async () => (await getBankConnections()).map((c) => c.institutionName);
    expect(await order()).toEqual(['Chase (demo)', 'American Express (demo)']);
    await syncConnection(login('American Express').id);
    expect(await order()).toEqual(['Chase (demo)', 'American Express (demo)']);
    // Linked at the same instant, the name decides, before and after a sync.
    await reseed();
    await db.update(bankConnections).set({ createdAt: new Date('2026-10-20T20:00:00Z') });
    expect(await order()).toEqual(['American Express (demo)', 'Chase (demo)']);
    await syncConnection(login('Chase').id);
    expect(await order()).toEqual(['American Express (demo)', 'Chase (demo)']);
  });

  it('files the synced rent, payroll and card payments by rule', async () => {
    await reseed();
    const rows = await db
      .select({ description: transactions.descriptionRaw, category: categories.name, counts: categories.countsAsSpending })
      .from(transactions)
      .leftJoin(categories, eq(categories.id, transactions.categoryId))
      .where(eq(transactions.source, 'plaid'));
    for (const r of rows.filter((x) => /OAKDALE PROPERTY|PAYROLL|E-?PAYMENT|PAYMENT - THANK YOU/.test(x.description))) {
      expect(r.category, r.description).not.toBeNull();
    }
    expect(rows.find((r) => r.description.includes('OAKDALE PROPERTY'))?.category).toBe('Rent');
    expect(rows.find((r) => r.description.includes('PAYROLL'))?.category).toBe('Income');
  });

  it('the daily sync runs every active login through the same sync, and skips a paused one', async () => {
    // The route is a 404 on the demo; its runner is the same code, and the
    // synthetic bank drives it end to end here (SCHEDULED-SYNC.md).
    await reseed();
    const first = await runScheduledSync(Date.now() + 60_000);
    expect(first.map((o) => [o.label, o.result, o.lines])).toEqual([
      ['Chase (demo)', 'synced', ['Checking ••4417: 1 new.']],
      ['American Express (demo)', 'synced', ['Card ••2093: 2 new (1 pending).']],
    ]);
    await db.update(bankConnections).set({ status: 'paused' }).where(eq(bankConnections.id, login('Chase').id));
    const second = await runScheduledSync(Date.now() + 60_000);
    expect(second.map((o) => [o.label, o.result, o.lines])).toEqual([['American Express (demo)', 'synced', ['Card ••2093: 1 posted.']]]);
  });

  it('applies one of two presses made at once; the other finds it done', async () => {
    await reseed();
    const amex = login('American Express').id;
    const results = await Promise.all([syncConnection(amex), syncConnection(amex)]);
    const lines = results.flatMap((r) => ('ok' in r ? r.lines : [r.error])).sort();
    // The other is refused while the first holds the lock, or finds it done
    // after, depending on timing; either way nothing is applied twice.
    expect(lines[0]).toBe('Card ••2093: 2 new (1 pending).');
    expect([
      'Card ••2093: another sync finished first; nothing more to apply.',
      'Card ••2093: another sync of this bank is running; nothing applied.',
    ]).toContain(lines[1]);
    const next = await syncConnection(amex);
    expect('ok' in next && next.lines).toEqual(['Card ••2093: 1 posted.']);
  });

  it('checks Chase checking against its statement: the figures pass, a typo does not', async () => {
    await reseed();
    const chase = accountOf('Chase');
    const s = seed.bankStatements[chase.providerAccountId];
    const statement = {
      from: s.from,
      to: s.to,
      charges: formatCents(toCents(s.chargesCents)),
      credits: formatCents(toCents(s.creditsCents)),
      excludedKeys: [],
      confirmed: true,
    };
    const good = await checkAgainstStatement(chase.id, statement);
    expect('ok' in good && good.result.passed).toBe(true);
    const typo = await checkAgainstStatement(chase.id, { ...statement, charges: formatCents(toCents(s.chargesCents + 9_000)) });
    expect('ok' in typo && typo.result).toMatchObject({ passed: false, chargesMatch: false, creditsMatch: true });
    expect(await recordStatementCheck(chase.id, { ...statement, charges: formatCents(toCents(s.chargesCents + 9_000)) }, 'pass')).toEqual({
      error: 'This does not match the statement yet; nothing was recorded.',
    });
    expect(await recordStatementCheck(chase.id, statement, 'pass')).toMatchObject({ ok: true });
    const [after] = await db.select({ verifiedAt: bankAccounts.verifiedAt }).from(bankAccounts).where(eq(bankAccounts.id, chase.id));
    expect(after.verifiedAt).not.toBeNull();
  });

  it('answers the held row: the same purchase stays out, a different one is added', async () => {
    await reseed();
    const amex = accountOf('American Express');
    const [held] = await db.select().from(syncSkippedRows).where(eq(syncSkippedRows.reason, 'possible_duplicate'));
    const before = (await db.select().from(transactions).where(eq(transactions.bankAccountId, amex.id))).length;
    expect(await answerHeldRow(amex.id, held.providerTransactionId, 'same')).toMatchObject({ ok: true });
    expect((await db.select().from(transactions).where(eq(transactions.bankAccountId, amex.id))).length).toBe(before);
    expect(await answerHeldRow(amex.id, held.providerTransactionId, 'released')).toMatchObject({ ok: true });
    expect((await db.select().from(transactions).where(eq(transactions.bankAccountId, amex.id))).length).toBe(before + 1);
  });

  it('opens with a Needs you band a visitor can act on: the held row, a statement that disagrees, an account to verify', async () => {
    await reseed();
    const band = async () => needsYouItems(needsYouFacts(await loadBoard()), { day: (iso) => iso, money: (n) => formatCents(toCents(n)) });
    const amexLedger = seed.ledgerAccounts.find((l) => l.csvSource === 'amex')!;
    const chase = accountOf('Chase');
    const items = await band();
    // Never All clear on arrival: a recruiter would see nothing the app does.
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.map((i) => i.key)).toEqual(expect.arrayContaining([`held:${amexLedger.id}`, `verify:${chase.id}`]));
    const differs = items.find((i) => i.key.startsWith(`differs:${amexLedger.id}:`));
    expect(differs?.text).toMatch(/more\.$/);
    // Every account has a cycle: no "record a statement" line on arrival.
    expect(items.filter((i) => i.key.startsWith('nostatement:') || i.key.startsWith('missing:') || i.key.startsWith('totals:'))).toEqual([]);

    // A visitor's answer resolves its line.
    const [held] = await db.select().from(syncSkippedRows).where(eq(syncSkippedRows.reason, 'possible_duplicate'));
    await answerHeldRow(accountOf('American Express').id, held.providerTransactionId, 'same');
    expect((await band()).map((i) => i.key)).not.toContain(`held:${amexLedger.id}`);
  });

  it('offers Move exactly where the conversion accepts it, and the car hire converts, clearing its line', async () => {
    await reseed();
    const checks = await conversionChecks();
    // It looked: the demo has a raised, split row.
    expect(checks.size).toBeGreaterThanOrEqual(1);
    for (const [id, check] of checks) {
      // The preview (apply false) runs the conversion's own transaction.
      const preview = await convertEditedRow(id, 'check', false);
      expect('error' in preview ? preview.error : null, id).toBe('error' in check ? check.error : null);
    }
    const hire = [...checks].find(([, c]) => !('error' in c));
    expect(hire).toBeDefined();
    const band = async () =>
      (await needsYouItems(needsYouFacts(await loadBoard()), { day: (iso) => iso, money: (n) => formatCents(toCents(n)) })).map((i) => i.key);
    expect(await band()).toContain('raised');
    expect(await convertEditedRow(hire![0], 'Gas on the way', true)).toMatchObject({ ok: true });
    expect(await band()).not.toContain('raised');
  });
});
