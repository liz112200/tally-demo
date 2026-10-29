import 'server-only';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { db } from './index';
import { bankAccounts, bankConnections, imports, ledgerAccounts, syncSkippedRows, transactions } from './schema';
import { getRules, lockConnection, SYNCABLE_ACCOUNT_TYPES, type Tx } from './queries';
import { BOUNDARY_DAYS, MATCH_DAYS, cutoverProblem, defaultCutover, merchantKey, sameMerchant } from '@/lib/bank-sync/cutover';
import { categorize } from '@/lib/categorize';
import { normalizeMerchant } from '@/lib/parsers/normalize';

// Ledger accounts, the cutover, re-issued accounts, the boundary review and
// sign verification (bank sync slice 7, REAL-ACCOUNTS.md). Every change runs
// under the login's lock, so it cannot race a sync's commit. Nothing here
// writes a CSV or manual transaction: the only transactions row written is a
// held synced row the owner says is a different purchase.

export type LedgerChoice = {
  id: string;
  displayName: string;
  csvSource: string | null;
  // The last CSV row of the ledger account, undone imports included.
  lastCsvDate: string | null;
  cutoverDate: string | null;
  // The live account mapped onto it, if any (one at a time); listed only
  // while that account has not synced, so it can re-pick it with Change.
  usedByAccountId: string | null;
};

// A ledger account in use: a Plaid account still shared, on a login not
// removed, syncs into it (or may again). Only one not in use can take another
// account: one with CSV history and no bank, or one whose bank accounts have
// all stopped (a migrated or replaced account continuing into it).
const IN_USE = (ledger: ReturnType<typeof sql>, except: string | null) => sql`exists (
  select 1 from bank_accounts b join bank_connections c on c.id = b.connection_id
  where b.ledger_account_id = ${ledger} and b.unshared_at is null and c.status <> 'removed'
    ${except === null ? sql`` : sql`and b.id <> ${except}`})`;

// The ledger accounts that can be chosen in Set up or Change, CSV ones first:
// those no live account uses, and those used by one that has not synced yet
// (only that account may choose it, to correct its cutover; choicesFor).
export async function ledgerChoices(): Promise<LedgerChoice[]> {
  const rows = (await db.execute(sql`
    select l.id, l.display_name, l.csv_source, l.cutover_date,
      (select max(t.date) from transactions t join imports i on i.id = t.import_id
        where i.ledger_account_id = l.id)::text as last_csv_date,
      (select b.id from bank_accounts b join bank_connections c on c.id = b.connection_id
        where b.ledger_account_id = l.id and b.unshared_at is null and c.status <> 'removed'
        limit 1) as used_by
    from ledger_accounts l
    where not ${IN_USE(sql`l.id`, null)}
      or exists (select 1 from bank_accounts b join bank_connections c on c.id = b.connection_id
        where b.ledger_account_id = l.id and b.unshared_at is null and c.status <> 'removed' and b.last_synced_at is null)
    order by l.csv_source is null, l.display_name`)) as unknown as {
    id: string;
    display_name: string;
    csv_source: string | null;
    cutover_date: string | null;
    last_csv_date: string | null;
    used_by: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    csvSource: r.csv_source,
    lastCsvDate: r.last_csv_date,
    cutoverDate: r.cutover_date,
    usedByAccountId: r.used_by,
  }));
}

// What one account may choose: the free ledger accounts and its own.
export function choicesFor(choices: readonly LedgerChoice[], accountId: string): LedgerChoice[] {
  return choices.filter((c) => c.usedByAccountId === null || c.usedByAccountId === accountId);
}

async function lastCsvDate(tx: Tx, ledgerAccountId: string): Promise<string | null> {
  const [row] = (await tx.execute(sql`
    select max(t.date)::text as d from transactions t join imports i on i.id = t.import_id
    where i.ledger_account_id = ${ledgerAccountId}`)) as unknown as { d: string | null }[];
  return row?.d ?? null;
}

// The account, locked through its login, with what a change needs to know.
async function lockedAccount(tx: Tx, accountId: string) {
  const [found] = await tx.select({ connectionId: bankAccounts.connectionId }).from(bankAccounts).where(eq(bankAccounts.id, accountId));
  if (!found) return null;
  await lockConnection(tx, found.connectionId);
  const [account] = await tx
    .select({
      id: bankAccounts.id,
      type: bankAccounts.type,
      name: bankAccounts.name,
      mask: bankAccounts.mask,
      ledgerAccountId: bankAccounts.ledgerAccountId,
      lastSyncedAt: bankAccounts.lastSyncedAt,
      unsharedAt: bankAccounts.unsharedAt,
      syncEnabled: bankAccounts.syncEnabled,
      replacesAccountId: bankAccounts.replacesAccountId,
      status: bankConnections.status,
    })
    .from(bankAccounts)
    .innerJoin(bankConnections, eq(bankConnections.id, bankAccounts.connectionId))
    .where(eq(bankAccounts.id, accountId));
  return account ?? null;
}

type Refusal = { error: string };

function cannotSync(account: NonNullable<Awaited<ReturnType<typeof lockedAccount>>>): Refusal | null {
  if (account.status === 'removed') return { error: 'This login was removed; its accounts cannot sync again.' };
  if (account.unsharedAt !== null) return { error: 'The bank no longer shares this account.' };
  if (!(SYNCABLE_ACCOUNT_TYPES as readonly string[]).includes(account.type)) return { error: 'Only checking, savings and card accounts can sync.' };
  if (account.replacesAccountId !== null) {
    return { error: 'This looks like an account already recorded, under a new id. Adopt it, or say it is a different account, first.' };
  }
  return null;
}

// Map a Plaid account onto a ledger account and turn its sync on. Onto one
// with CSV history: the cutover (default the day after its last CSV row,
// undone imports included) is confirmed here and may not be on or before
// that row. As a new ledger account: refused while ledger accounts with CSV
// history and no bank are left, unless the owner confirms this account has
// none of its own. Fixed once the account has synced into a ledger account.
// A mapping changed before the first sync: a ledger account the earlier
// choice created, with no CSV history and no other bank account, is dropped,
// so a mistaken "new ledger account" does not linger in the Set up list.
// Nothing can reference it: imports carry CSV ledger accounts only, and
// synced rows reach a ledger account through their bank account.
async function dropAbandoned(tx: Tx, previous: string | null) {
  if (previous === null) return;
  await tx.execute(sql`
    delete from ledger_accounts l
    where l.id = ${previous} and l.csv_source is null
      and not exists (select 1 from bank_accounts b where b.ledger_account_id = l.id)
      and not exists (select 1 from imports i where i.ledger_account_id = l.id)`);
}

export async function mapAccountToLedger(
  accountId: string,
  choice: { kind: 'existing'; ledgerAccountId: string; cutoverDate: string | null } | { kind: 'new'; displayName: string; noCsvHistory: boolean },
): Promise<{ ok: true; message: string } | Refusal> {
  return db.transaction(async (tx) => {
    const account = await lockedAccount(tx, accountId);
    if (!account) return { error: 'Account not found.' };
    const refused = cannotSync(account);
    if (refused) return refused;
    if (account.lastSyncedAt !== null && account.ledgerAccountId !== null) {
      return { error: 'This account has synced into its ledger account already; that mapping is fixed.' };
    }

    if (choice.kind === 'new') {
      if (!choice.noCsvHistory) {
        const waiting = (await tx.execute(sql`
          select l.display_name from ledger_accounts l
          where l.csv_source is not null
            and not exists (select 1 from bank_accounts b where b.ledger_account_id = l.id)
          order by l.display_name`)) as unknown as { display_name: string }[];
        if (waiting.length > 0) {
          return {
            error: `CSV history is waiting for a bank in ${waiting.map((w) => w.display_name).join(', ')}. If this is one of them, choose it, so its history is not counted twice; otherwise confirm it has no CSV history here.`,
          };
        }
      }
      const [ledger] = await tx
        .insert(ledgerAccounts)
        .values({ displayName: choice.displayName, cutoverConfirmedAt: sql`now()` })
        .returning({ id: ledgerAccounts.id });
      await tx.update(bankAccounts).set({ ledgerAccountId: ledger.id, syncEnabled: true }).where(eq(bankAccounts.id, accountId));
      await dropAbandoned(tx, account.ledgerAccountId);
      return { ok: true, message: `${account.name} syncs into ${choice.displayName}, from the start of its history.` };
    }

    const [ledger] = await tx
      .select({ id: ledgerAccounts.id, displayName: ledgerAccounts.displayName, csvSource: ledgerAccounts.csvSource })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.id, choice.ledgerAccountId));
    if (!ledger) return { error: 'That ledger account no longer exists.' };
    const [busy] = (await tx.execute(sql`select ${IN_USE(sql`${ledger.id}`, accountId)} as busy`)) as unknown as { busy: boolean }[];
    if (busy?.busy) return { error: `${ledger.displayName} belongs to another bank account.` };
    const last = await lastCsvDate(tx, ledger.id);
    let cutover: string | null = null;
    if (last !== null) {
      cutover = choice.cutoverDate ?? defaultCutover(last);
      const problem = cutoverProblem(cutover!, last);
      if (problem) return { error: problem };
    }
    await tx
      .update(ledgerAccounts)
      .set({ cutoverDate: cutover, cutoverConfirmedAt: sql`now()` })
      .where(eq(ledgerAccounts.id, ledger.id));
    await tx.update(bankAccounts).set({ ledgerAccountId: ledger.id, syncEnabled: true }).where(eq(bankAccounts.id, accountId));
    await dropAbandoned(tx, account.ledgerAccountId);
    return {
      ok: true,
      message:
        cutover === null
          ? `${account.name} syncs into ${ledger.displayName}, from the start of its history.`
          : `${account.name} syncs into ${ledger.displayName} from ${cutover}. Its CSV rows, to ${last}, stay exactly as they are.`,
    };
  });
}

// A re-issued account joins the ledger account of the one it replaces, with
// the cutover moved to the day after that account's last synced row, so the
// history it arrives with is not counted twice. The old account keeps its
// rows and stays off. No new Item.
export async function adoptReissuedAccount(accountId: string): Promise<{ ok: true; message: string } | Refusal> {
  return db.transaction(async (tx) => {
    const account = await lockedAccount(tx, accountId);
    if (!account) return { error: 'Account not found.' };
    if (account.replacesAccountId === null) return { error: 'This account is not marked as a re-issued one.' };
    const [old] = await tx
      .select({ id: bankAccounts.id, name: bankAccounts.name, ledgerAccountId: bankAccounts.ledgerAccountId })
      .from(bankAccounts)
      .where(eq(bankAccounts.id, account.replacesAccountId));
    if (!old?.ledgerAccountId) {
      await tx.update(bankAccounts).set({ replacesAccountId: null }).where(eq(bankAccounts.id, accountId));
      return { ok: true, message: `${old?.name ?? 'The earlier account'} never synced, so there is nothing to continue; set this one up as usual.` };
    }
    const [ledger] = await tx
      .select({ basis: ledgerAccounts.cutoverBasis, cutoverDate: ledgerAccounts.cutoverDate, displayName: ledgerAccounts.displayName })
      .from(ledgerAccounts)
      .where(eq(ledgerAccounts.id, old.ledgerAccountId));
    const [last] = (await tx.execute(sql`
      select max(case when ${ledger.basis} = 'posted' then coalesce(t.provider_raw->>'date', t.date::text)::date else t.date end)::text as d
      from transactions t where t.bank_account_id = ${old.id}`)) as unknown as { d: string | null }[];
    const afterOld = defaultCutover(last?.d ?? null);
    const cutover = [ledger.cutoverDate, afterOld].filter((d): d is string => d !== null).sort().at(-1) ?? null;
    await tx.update(bankAccounts).set({ syncEnabled: false }).where(eq(bankAccounts.id, old.id));
    await tx
      .update(ledgerAccounts)
      .set({ cutoverDate: cutover, cutoverConfirmedAt: sql`now()` })
      .where(eq(ledgerAccounts.id, old.ledgerAccountId));
    await tx
      .update(bankAccounts)
      .set({ ledgerAccountId: old.ledgerAccountId, replacesAccountId: null, syncEnabled: true })
      .where(eq(bankAccounts.id, accountId));
    return {
      ok: true,
      message: `${account.name} continues ${ledger.displayName}${cutover ? ` from ${cutover}` : ''}. ${old.name}'s rows stay; nothing is counted twice.`,
    };
  });
}

// The owner says it is a different account: it is set up like any other.
export async function rejectReissuedAccount(accountId: string): Promise<{ ok: true; message: string } | Refusal> {
  return db.transaction(async (tx) => {
    const account = await lockedAccount(tx, accountId);
    if (!account) return { error: 'Account not found.' };
    if (account.replacesAccountId === null) return { error: 'This account is not marked as a re-issued one.' };
    await tx.update(bankAccounts).set({ replacesAccountId: null }).where(eq(bankAccounts.id, accountId));
    return { ok: true, message: `${account.name} is treated as a different account; set it up as usual.` };
  });
}

// ---- The boundary review ----

export type BoundaryRow = {
  providerTransactionId: string | null;
  date: string;
  amountCents: number;
  description: string;
  kind: 'csv' | 'before_cutover' | 'possible_duplicate';
  resolution: 'same' | 'released' | null;
  // On a bank row: the CSV row of the same merchant within MATCH_DAYS whose
  // amount differs, when no CSV row there has the bank's amount. Stated as a
  // fact; the cause is the owner's to know (an edit, a hold, a tip).
  differsFrom: { date: string; amountCents: number } | null;
};

// The rows either side of the cutover: the ledger account's CSV rows from the
// last BOUNDARY_DAYS before it, and the synced rows set aside, before it or
// held as possible duplicates. Read-only apart from the held rows' answers.
export async function boundaryReview(accountId: string): Promise<{ cutover: string; rows: BoundaryRow[] } | null> {
  const [account] = await db
    .select({ ledgerAccountId: bankAccounts.ledgerAccountId, cutover: ledgerAccounts.cutoverDate, basis: ledgerAccounts.cutoverBasis })
    .from(bankAccounts)
    .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, bankAccounts.ledgerAccountId))
    .where(eq(bankAccounts.id, accountId));
  if (!account?.cutover) return null;
  // Bank rows are shown and compared on the account's basis, the date its CSV
  // rows carry and the cutover was judged on: the posting date for Chase
  // checking, where showing the purchase date put a row days away from its
  // CSV twin (2026-10-29: 09-04 beside 09-08).
  const posted = account.basis === 'posted';
  const basisColumn = posted ? syncSkippedRows.postedDate : syncSkippedRows.date;
  const csv = await db
    .select({ date: transactions.date, amountCents: transactions.amountCents, description: transactions.descriptionRaw })
    .from(transactions)
    .innerJoin(imports, eq(imports.id, transactions.importId))
    .where(
      and(
        eq(imports.ledgerAccountId, account.ledgerAccountId!),
        isNull(transactions.deletedAt),
        sql`${transactions.date} >= ${account.cutover}::date - ${BOUNDARY_DAYS}::int`,
      ),
    );
  const setAside = await db
    .select()
    .from(syncSkippedRows)
    .where(
      and(
        eq(syncSkippedRows.bankAccountId, accountId),
        isNull(syncSkippedRows.removedAt),
        sql`(${syncSkippedRows.reason} = 'possible_duplicate' or ${basisColumn} >= ${account.cutover}::date - ${BOUNDARY_DAYS}::int)`,
      ),
    );
  const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
  const differsFrom = (bank: { date: string; amountCents: number; descriptionRaw: string }) => {
    const merchant = merchantKey(bank.descriptionRaw);
    const near = csv.filter((c) => days(c.date, bank.date) <= MATCH_DAYS);
    if (merchant === null || near.some((c) => c.amountCents === bank.amountCents)) return null;
    const other = near.find((c) => sameMerchant(merchantKey(c.description), merchant));
    return other ? { date: other.date, amountCents: other.amountCents } : null;
  };
  const rows: BoundaryRow[] = [
    ...csv.map((c) => ({
      providerTransactionId: null,
      date: c.date,
      amountCents: c.amountCents,
      description: c.description,
      kind: 'csv' as const,
      resolution: null,
      differsFrom: null,
    })),
    ...setAside.map((s) => {
      const date = posted ? s.postedDate : s.date;
      return {
        providerTransactionId: s.providerTransactionId,
        date,
        amountCents: s.amountCents,
        description: s.descriptionRaw,
        kind: s.reason,
        resolution: s.resolution,
        differsFrom: differsFrom({ ...s, date }),
      };
    }),
  ].sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
  return { cutover: account.cutover, rows };
}

// The owner's answer for a held row: the same purchase as a CSV row (it stays
// out), or a different one (it is added now, categorized by the rules as a
// synced row would be).
export async function resolveHeldRow(
  accountId: string,
  providerTransactionId: string,
  answer: 'same' | 'released',
): Promise<{ ok: true; message: string } | Refusal> {
  return db.transaction(async (tx) => {
    const account = await lockedAccount(tx, accountId);
    if (!account) return { error: 'Account not found.' };
    const [held] = await tx
      .select()
      .from(syncSkippedRows)
      .where(
        and(
          eq(syncSkippedRows.bankAccountId, accountId),
          eq(syncSkippedRows.providerTransactionId, providerTransactionId),
          eq(syncSkippedRows.reason, 'possible_duplicate'),
          isNull(syncSkippedRows.removedAt),
        ),
      )
      .for('update');
    if (!held) return { error: 'That row is not held, or the bank has removed it.' };
    if (held.resolution === 'released') return { error: 'That row was already added.' };
    if (answer === 'released') {
      const merchant = normalizeMerchant(held.descriptionRaw);
      const rules = (await getRules()).map((r) => ({ categoryId: r.categoryId, matchPattern: r.matchPattern, matchType: r.matchType, priority: r.priority, createdAt: r.createdAt }));
      const categoryId = categorize(merchant, rules);
      // Dated as the account's other rows are (REAL-ACCOUNTS.md, one basis).
      const [ledger] = await tx
        .select({ basis: ledgerAccounts.cutoverBasis })
        .from(ledgerAccounts)
        .where(eq(ledgerAccounts.id, account.ledgerAccountId!));
      await tx.insert(transactions).values({
        date: ledger?.basis === 'posted' ? held.postedDate : held.date,
        amountCents: held.amountCents,
        descriptionRaw: held.descriptionRaw,
        merchantNormalized: merchant,
        categoryId,
        categorySource: categoryId === null ? null : 'rule',
        pending: held.pending,
        source: 'plaid',
        bankAccountId: accountId,
        providerTransactionId: held.providerTransactionId,
        providerRaw: held.providerRaw,
      });
    }
    await tx
      .update(syncSkippedRows)
      .set({ resolution: answer })
      .where(and(eq(syncSkippedRows.bankAccountId, accountId), eq(syncSkippedRows.providerTransactionId, providerTransactionId)));
    return {
      ok: true,
      message: answer === 'same' ? 'Kept out: the same purchase as the CSV row.' : 'Added as a purchase of its own.',
    };
  });
}

export async function dismissBoundaryReview(accountId: string): Promise<boolean> {
  const updated = await db
    .update(bankAccounts)
    .set({ boundaryReviewedAt: sql`now()` })
    .where(and(eq(bankAccounts.id, accountId), isNull(bankAccounts.boundaryReviewedAt), isNotNull(bankAccounts.lastSyncedAt)))
    .returning({ id: bankAccounts.id });
  return updated.length > 0;
}

// ---- Verification ----

export type VerificationRow = {
  key: string;
  postedDate: string;
  amountCents: number;
  description: string;
  inserted: boolean;
};

// Every posted row fetched for the account in a period, by the posted date a
// statement groups by: inserted rows and rows set aside alike.
export async function verificationRows(accountId: string, from: string, to: string): Promise<VerificationRow[]> {
  const inserted = (await db.execute(sql`
    select t.id::text as key, coalesce(t.provider_raw->>'date', t.date::text) as posted, t.amount_cents, t.description_raw
    from transactions t
    where t.bank_account_id = ${accountId} and not t.pending
      -- A synced row the owner deleted is still the bank's, and on its
      -- statement; one the bank removed is not.
      and (t.deleted_at is null or t.removed_by_bank_at is null)
      and coalesce(t.provider_raw->>'date', t.date::text)::date between ${from}::date and ${to}::date`)) as unknown as {
    key: string;
    posted: string;
    amount_cents: string | number;
    description_raw: string;
  }[];
  const aside = await db
    .select()
    .from(syncSkippedRows)
    .where(
      and(
        eq(syncSkippedRows.bankAccountId, accountId),
        eq(syncSkippedRows.pending, false),
        isNull(syncSkippedRows.removedAt),
        // A held row the owner added ("Different: add it") is a transaction
        // now, counted above; counting its record too would count it twice.
        sql`${syncSkippedRows.resolution} is distinct from 'released'`,
        sql`${syncSkippedRows.postedDate} between ${from}::date and ${to}::date`,
      ),
    );
  return [
    ...inserted.map((r) => ({ key: r.key, postedDate: r.posted, amountCents: Number(r.amount_cents), description: r.description_raw, inserted: true })),
    ...aside.map((s) => ({ key: `aside:${s.providerTransactionId}`, postedDate: s.postedDate, amountCents: s.amountCents, description: s.descriptionRaw, inserted: false })),
  ].sort((a, b) => a.postedDate.localeCompare(b.postedDate));
}

export async function recordVerification(
  accountId: string,
  outcome: { passed: boolean; record: Record<string, unknown> },
): Promise<boolean> {
  const updated = await db
    .update(bankAccounts)
    .set(
      outcome.passed
        ? { verifiedAt: sql`now()`, verification: outcome.record }
        : { verifiedAt: null, verification: outcome.record, syncEnabled: false },
    )
    .where(eq(bankAccounts.id, accountId))
    .returning({ id: bankAccounts.id });
  return updated.length > 0;
}

// Accounts of a login with what /accounts shows for slice 7.
export async function ledgerStateFor(accountIds: string[]) {
  if (accountIds.length === 0) return new Map<string, never>();
  const rows = await db
    .select({
      id: bankAccounts.id,
      ledgerAccountId: bankAccounts.ledgerAccountId,
      ledgerName: ledgerAccounts.displayName,
      cutoverDate: ledgerAccounts.cutoverDate,
      verifiedAt: bankAccounts.verifiedAt,
      verification: bankAccounts.verification,
      boundaryReviewedAt: bankAccounts.boundaryReviewedAt,
      replacesAccountId: bankAccounts.replacesAccountId,
    })
    .from(bankAccounts)
    .leftJoin(ledgerAccounts, eq(ledgerAccounts.id, bankAccounts.ledgerAccountId))
    .where(inArray(bankAccounts.id, accountIds));
  const held = (await db.execute(sql`
    select bank_account_id, count(*)::int as n from sync_skipped_rows
    where reason = 'possible_duplicate' and resolution is null and removed_at is null
    group by bank_account_id`)) as unknown as { bank_account_id: string; n: number }[];
  const heldBy = new Map(held.map((h) => [h.bank_account_id, h.n]));
  return new Map(rows.map((r) => [r.id, { ...r, heldCount: heldBy.get(r.id) ?? 0 }]));
}

// ---- CSV imports ----

const CSV_NAMES: Record<string, string> = { chase: 'Chase', discover: 'Discover', amex: 'Amex' };

// The ledger account a CSV batch belongs to, by its source and account label,
// and the date from which a bank already covers it: a ledger account with a
// bank account mapped onto it syncs everything on or after its cutover, so a
// CSV row dated then would count twice.
export async function csvLedger(
  source: string,
  label: string | null,
): Promise<{ id: string; coveredFrom: string | null } | null> {
  const [row] = (await db.execute(sql`
    select l.id, l.cutover_date::text as cutover,
      exists (select 1 from bank_accounts b where b.ledger_account_id = l.id) as has_bank
    from ledger_accounts l
    where l.csv_source = ${source}::transaction_source and coalesce(l.csv_account_label, '') = ${label ?? ''}`)) as unknown as {
    id: string;
    cutover: string | null;
    has_bank: boolean;
  }[];
  if (!row) return null;
  return { id: row.id, coveredFrom: row.has_bank ? row.cutover : null };
}

// The CSV batch's ledger account, created on the first import of a new
// source and label with a default name.
export async function ensureCsvLedger(source: string, label: string | null): Promise<string> {
  const existing = await csvLedger(source, label);
  if (existing) return existing.id;
  const name = `${CSV_NAMES[source] ?? source}${label ? ` ${label}` : ''}`;
  const basis = source === 'chase' ? 'posted' : 'transaction';
  await db.execute(sql`
    insert into ledger_accounts (display_name, csv_source, csv_account_label, cutover_basis)
    values (${name}, ${source}::transaction_source, ${label}, ${basis}::ledger_cutover_basis)
    on conflict do nothing`);
  return (await csvLedger(source, label))!.id;
}
