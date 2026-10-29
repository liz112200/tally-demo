import 'server-only';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from './index';
import { persons, settlementAllocations, splitShares, splits, transactions } from './schema';
import type { Tx } from './queries';
import { dedupHash } from '@/lib/parsers/dedup';
import { normalizeMerchant } from '@/lib/parsers/normalize';
import { formatUSD, toCents } from '@/lib/money';

const usd = (n: number) => formatUSD(toCents(n));

// The manual rows this one would duplicate (same date, amount and
// description). A live one is refused, named, with what to do. A deleted one
// is invisible and was deleted by the owner, so it does not block: the new
// row goes in dedup_exempt, past the unique index that still holds the
// deleted row's hash, as an approved duplicate from an import preview does.
// (Counting the deleted row pointed the owner at a row they could not see,
// telling them to delete what they already had; dev, 2026-10-29.)
async function twinOf(
  conn: Pick<Tx, 'select'>,
  date: string,
  amountCents: number,
  descriptionRaw: string,
): Promise<{ refusal: string | null; exempt: boolean }> {
  const hash = dedupHash({ source: 'manual', accountLabel: null, date, amountCents, descriptionRaw });
  const twins = await conn
    .select({ deletedAt: transactions.deletedAt })
    .from(transactions)
    .where(and(eq(transactions.dedupHash, hash), eq(transactions.dedupExempt, false)));
  if (twins.some((t) => t.deletedAt === null)) {
    return {
      refusal: `You already have a manual row "${descriptionRaw}" for ${usd(amountCents)} on ${date}. Describe this one differently, or delete that row first.`,
      exempt: false,
    };
  }
  return { refusal: null, exempt: twins.length > 0 };
}

// Paid alongside (PAID-ALONGSIDE.md): a manual purchase the owner paid
// off-card next to another transaction, linked to it; and the one-row
// conversion of an amount raised after import into such a purchase.

// Insert the manual row, linked to the transaction it went with. Its date
// and category are the anchor's; the description and amount are the owner's.
// Returns the new row's id, or an error the owner can act on.
export async function insertPaidAlongside(
  conn: Pick<Tx, 'select' | 'insert'>,
  anchorId: string,
  input: { descriptionRaw: string; amountCents: number },
): Promise<{ id: string; date: string } | { error: string }> {
  const [anchor] = await conn
    .select({ date: transactions.date, categoryId: transactions.categoryId, deletedAt: transactions.deletedAt })
    .from(transactions)
    .where(eq(transactions.id, anchorId));
  if (!anchor || anchor.deletedAt) return { error: 'That transaction no longer exists.' };
  const twin = await twinOf(conn, anchor.date, input.amountCents, input.descriptionRaw);
  if (twin.refusal) return { error: twin.refusal };
  const [row] = await conn
    .insert(transactions)
    .values({
      date: anchor.date,
      amountCents: input.amountCents,
      descriptionRaw: input.descriptionRaw,
      merchantNormalized: normalizeMerchant(input.descriptionRaw),
      categoryId: anchor.categoryId,
      categorySource: anchor.categoryId ? 'manual' : null,
      source: 'manual',
      accountLabel: null,
      dedupHash: dedupHash({ source: 'manual', accountLabel: null, date: anchor.date, amountCents: input.amountCents, descriptionRaw: input.descriptionRaw }),
      dedupExempt: twin.exempt,
      alongsideTransactionId: anchorId,
    })
    .onConflictDoNothing({
      target: transactions.dedupHash,
      where: sql`${transactions.dedupHash} is not null and ${transactions.dedupExempt} = false`,
    })
    .returning({ id: transactions.id });
  // Only a row written between the check above and this insert lands here.
  if (!row) return { error: 'A manual row with this date, amount and description was just added; nothing more was added.' };
  return { id: row.id, date: anchor.date };
}

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

export type PersonFigures = { owed: number; paid: number; owing: number; credit: number };
export type ConversionPlan = {
  originalCents: number;
  currentCents: number;
  extraCents: number;
  partCents: number;
  people: { personId: string; name: string; isOwner: boolean; shareBefore: number; shareAfter: number; extraShare: number; before: PersonFigures; after: PersonFigures }[];
  spending: { before: number; after: number; creditsBefore: number; creditsAfter: number };
  month: string;
  monthByCategoryUnchanged: boolean;
};

// What each person owes the owner, has paid toward it, owes back, and holds
// as unallocated credit, counting only live rows (as the balances do).
async function figures(tx: Tx, ownerId: string, personIds: string[]): Promise<Map<string, PersonFigures>> {
  const rows = (await tx.execute(sql`
    with share as (
      select ss.id, ss.amount_cents,
        case when sp.payer_person_id = ${ownerId} then ss.person_id else sp.payer_person_id end as person,
        case when sp.payer_person_id = ${ownerId} then 'in' else 'out' end as dir,
        coalesce((select sum(a.amount_cents) from settlement_allocations a where a.split_share_id = ss.id), 0) as alloc
      from split_shares ss join splits sp on sp.id = ss.split_id
      left join transactions t on t.id = sp.transaction_id
      where (sp.transaction_id is null or t.deleted_at is null)
        and ((sp.payer_person_id = ${ownerId} and ss.person_id <> ${ownerId}) or (sp.payer_person_id <> ${ownerId} and ss.person_id = ${ownerId}))
    ), settled as (
      select st.person_id as person,
        sum(st.amount_cents - coalesce((select sum(a.amount_cents) from settlement_allocations a
          join split_shares ss on ss.id = a.split_share_id join splits sp on sp.id = ss.split_id
          left join transactions t on t.id = sp.transaction_id
          where a.settlement_id = st.id and (sp.transaction_id is null or t.deleted_at is null)), 0)) as credit
      from settlements st group by st.person_id
    )
    select p.id as person,
      coalesce((select sum(greatest(amount_cents - alloc, 0)) from share where share.person = p.id and dir = 'in'), 0)::bigint as owed,
      coalesce((select sum(alloc) from share where share.person = p.id and dir = 'in'), 0)::bigint as paid,
      coalesce((select sum(greatest(amount_cents - alloc, 0)) from share where share.person = p.id and dir = 'out'), 0)::bigint as owing,
      coalesce((select credit from settled where settled.person = p.id), 0)::bigint as credit
    from persons p where p.id in (${sql.join(personIds.map((personId) => sql`${personId}::uuid`), sql`, `)})`)) as unknown as { person: string; owed: string; paid: string; owing: string; credit: string }[];
  return new Map(rows.map((r) => [r.person, { owed: Number(r.owed), paid: Number(r.paid), owing: Number(r.owing), credit: Number(r.credit) }]));
}

// The owner's spending and credits as the Expenses summary counts them, and
// one month's spending by category as Insights shows it.
async function spendingOf(tx: Tx, month: string) {
  const counted = sql`t.deleted_at is null and not t.pending and (t.bank_account_id is null or b.verified_at is not null) and coalesce(c.counts_as_spending, true)`;
  const [total] = (await tx.execute(sql`
    select coalesce(sum(t.amount_cents) filter (where t.amount_cents > 0), 0)::bigint as spending,
      coalesce(sum(t.amount_cents) filter (where t.amount_cents < 0), 0)::bigint as credits
    from transactions t left join categories c on c.id = t.category_id left join bank_accounts b on b.id = t.bank_account_id
    where ${counted}`)) as unknown as { spending: string; credits: string }[];
  const byCategory = (await tx.execute(sql`
    select coalesce(t.category_id::text, '') as category, sum(t.amount_cents)::bigint as total
    from transactions t left join categories c on c.id = t.category_id left join bank_accounts b on b.id = t.bank_account_id
    where ${counted} and to_char(t.date, 'YYYY-MM') = ${month}
    group by 1 order by 1`)) as unknown as { category: string; total: string }[];
  return { spending: Number(total.spending), credits: Number(total.credits), byCategory: JSON.stringify(byCategory) };
}

class Preview extends Error {
  constructor(readonly plan: ConversionPlan) {
    super('preview');
  }
}

// A refusal once anything has been written. Inside db.transaction a return
// commits what was written before it, so after the first write a refusal
// must throw, which rolls everything back (the cause of a half-written
// conversion on dev, 2026-10-29).
class Refused extends Error {}

// Move an amount raised after import into a paid-alongside purchase, one row
// at a time. Offered only for a CSV or manual row whose original amount is
// recovered from its dedup_hash, with an equal, owner-paid split whose extra
// divides evenly in whole cents among its people. In one transaction: the
// row returns to its original amount; the extra becomes a manual row linked
// to it, split equally among the same people; each share drops by exactly
// that person's part (adjusted, not re-divided, so nothing moves by a mill);
// and the part of a share's allocation above its new amount moves to the
// person's share of the extra, from the same settlement. Every person's
// owed, paid, owing and credit, the spending and credit totals, and the
// month's spending by category are compared before and after; any
// difference refuses and nothing is written. With apply false it rolls back
// and returns the plan, for the dialog.
export async function convertEditedRow(
  transactionId: string,
  description: string,
  apply: boolean,
): Promise<{ ok: true; plan: ConversionPlan } | { error: string }> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(transactions)
        .where(eq(transactions.id, transactionId))
        .for('update');
      if (!row || row.deletedAt) return { error: 'That transaction no longer exists.' };
      if (row.providerTransactionId !== null || row.dedupHash === null) {
        return { error: 'Only a CSV or manual row can be converted; a synced row is the bank’s.' };
      }
      if (dedupHash(row) === row.dedupHash) {
        return { error: 'This row has the amount it came in with; there is nothing to move.' };
      }
      const original = importedAmountBelow({ ...row, dedupHash: row.dedupHash });
      if (original === null) {
        return { error: 'The amount this row came in with cannot be recovered (its date or description changed too, or it was edited before Jul 30), so it is not converted.' };
      }
      const [owner] = await tx.select({ id: persons.id }).from(persons).where(eq(persons.isOwner, true));
      const [split] = await tx.select().from(splits).where(eq(splits.transactionId, transactionId)).for('update');
      if (!split || split.payerPersonId !== owner.id || split.method !== 'equal') {
        return { error: 'Only a row with an equal split you paid is converted.' };
      }
      const shares = await tx
        .select({ id: splitShares.id, personId: splitShares.personId, amountCents: splitShares.amountCents, name: persons.name, isOwner: persons.isOwner })
        .from(splitShares)
        .innerJoin(persons, eq(persons.id, splitShares.personId))
        .where(eq(splitShares.splitId, split.id))
        .orderBy(asc(persons.createdAt))
        .for('update', { of: splitShares });
      const extra = row.amountCents - original;
      if (extra % (shares.length * 10) !== 0) {
        return { error: `The extra does not divide evenly in whole cents among ${shares.length} people, so it is not converted.` };
      }
      const part = extra / shares.length;
      if (shares.some((s) => s.amountCents < part)) return { error: 'A share is smaller than its part of the extra; not converted.' };
      // Already recorded alongside it: converting would count the extra twice.
      const already = await tx
        .select({ descriptionRaw: transactions.descriptionRaw })
        .from(transactions)
        .where(and(eq(transactions.alongsideTransactionId, transactionId), eq(transactions.amountCents, extra), sql`${transactions.deletedAt} is null`));
      if (already.length > 0) {
        return {
          error: `"${already[0].descriptionRaw}" for ${usd(extra)} is already recorded alongside this row, so converting would record the extra a second time. If that row is the extra, delete it, then convert.`,
        };
      }
      if (apply) {
        const twin = await twinOf(tx, row.date, extra, description);
        if (twin.refusal) return { error: twin.refusal };
      }

      const personIds = shares.map((s) => s.personId);
      const month = row.date.slice(0, 7);
      const before = await figures(tx, owner.id, personIds);
      const spendBefore = await spendingOf(tx, month);

      // Every check is above this line. From the first write on, a refusal
      // throws (Refused), so nothing is left half-written.
      await tx.update(transactions).set({ amountCents: original }).where(eq(transactions.id, transactionId));
      const inserted = await insertPaidAlongside(tx, transactionId, { descriptionRaw: description, amountCents: extra });
      if ('error' in inserted) throw new Refused(inserted.error);
      const [extraSplit] = await tx
        .insert(splits)
        .values({ transactionId: inserted.id, payerPersonId: owner.id, method: 'equal', taxCents: 0, tipCents: 0 })
        .returning({ id: splits.id });
      for (const share of shares) {
        const [extraShare] = await tx
          .insert(splitShares)
          .values({ splitId: extraSplit.id, personId: share.personId, amountCents: part })
          .returning({ id: splitShares.id });
        const newAmount = share.amountCents - part;
        await tx.update(splitShares).set({ amountCents: newAmount }).where(eq(splitShares.id, share.id));
        // The paid part above the new share moves, settlement by settlement.
        const allocations = await tx
          .select()
          .from(settlementAllocations)
          .where(eq(settlementAllocations.splitShareId, share.id))
          .orderBy(desc(settlementAllocations.createdAt));
        let excess = allocations.reduce((n, a) => n + a.amountCents, 0) - newAmount;
        for (const a of allocations) {
          if (excess <= 0) break;
          const moved = Math.min(excess, a.amountCents);
          const where = and(eq(settlementAllocations.settlementId, a.settlementId), eq(settlementAllocations.splitShareId, share.id));
          if (moved === a.amountCents) await tx.delete(settlementAllocations).where(where);
          else await tx.update(settlementAllocations).set({ amountCents: a.amountCents - moved }).where(where);
          await tx
            .insert(settlementAllocations)
            .values({ settlementId: a.settlementId, splitShareId: extraShare.id, amountCents: moved })
            .onConflictDoUpdate({
              target: [settlementAllocations.settlementId, settlementAllocations.splitShareId],
              set: { amountCents: sql`${settlementAllocations.amountCents} + ${moved}` },
            });
          excess -= moved;
        }
      }

      const after = await figures(tx, owner.id, personIds);
      const spendAfter = await spendingOf(tx, month);
      const plan: ConversionPlan = {
        originalCents: original,
        currentCents: row.amountCents,
        extraCents: extra,
        partCents: part,
        people: shares.map((s) => ({
          personId: s.personId,
          name: s.name,
          isOwner: s.isOwner,
          shareBefore: s.amountCents,
          shareAfter: s.amountCents - part,
          extraShare: part,
          before: before.get(s.personId)!,
          after: after.get(s.personId)!,
        })),
        spending: { before: spendBefore.spending, after: spendAfter.spending, creditsBefore: spendBefore.credits, creditsAfter: spendAfter.credits },
        month,
        monthByCategoryUnchanged: spendBefore.byCategory === spendAfter.byCategory,
      };
      const same =
        plan.people.every((p) => JSON.stringify(p.before) === JSON.stringify(p.after)) &&
        plan.spending.before === plan.spending.after &&
        plan.spending.creditsBefore === plan.spending.creditsAfter &&
        plan.monthByCategoryUnchanged;
      if (!same) throw new Refused('A balance or the spending total would change; nothing was converted.');
      if (!apply) throw new Preview(plan);
      return { ok: true as const, plan };
    });
  } catch (err) {
    if (err instanceof Preview) return { ok: true, plan: err.plan };
    if (err instanceof Refused) return { error: err.message };
    throw err;
  }
}
