'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/db/index';
import { convertEditedRow, insertPaidAlongside, type ConversionPlan } from '@/db/alongside';
import { getPersons, getSplits, replaceSplit } from '@/db/queries';
import { computeShares } from '@/lib/split';
import { formatUSD, toCents, tryParseDollars } from '@/lib/money';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { requireUser } from '@/app/_lib/session';

// Paid alongside (PAID-ALONGSIDE.md). Every amount and balance in a result is
// shown exactly (formatUSD), as the owner asked for conversions.

const id = z.string().uuid();
const what = z.string().trim().min(1, 'Say what it was.').max(120);

function refresh() {
  revalidatePath('/');
  revalidatePath('/people');
  revalidatePath('/insights');
}

// Add what the owner paid off-card alongside a transaction: a manual row on
// its date and in its category, split equally among the same people as its
// split (or not split, when it has none).
export async function addPaidAlongside(anchorId: unknown, description: unknown, amount: unknown): Promise<ActionResult> {
  await requireUser();
  const anchor = id.safeParse(anchorId);
  const text = what.safeParse(description);
  if (!anchor.success) return { error: 'Invalid request.' };
  if (!text.success) return { error: text.error.issues[0].message };
  const cents = typeof amount === 'string' ? tryParseDollars(amount) : null;
  if (cents === null || cents <= 0) return { error: 'Enter the amount you paid.' };
  return attempt('addPaidAlongside', async () => {
    const inserted = await db.transaction((tx) => insertPaidAlongside(tx, anchor.data, { descriptionRaw: text.data, amountCents: cents }));
    if ('error' in inserted) return inserted;
    const anchorSplit = (await getSplits()).find((s) => s.transactionId === anchor.data);
    const owner = (await getPersons()).find((p) => p.isOwner);
    refresh();
    // Splits on a transaction are always the owner's (external ones have none).
    if (!anchorSplit || !owner) {
      return { ok: true, message: `Added ${formatUSD(toCents(cents))} paid alongside it, not split.` };
    }
    // Same people, in person order (the remainder rule depends on it).
    const people = (await getPersons()).filter((p) => anchorSplit.shares.some((s) => s.personId === p.id));
    const shares = computeShares(toCents(cents), toCents(0), toCents(0), 'equal', people.map((p) => ({ personId: p.id })));
    const saved = await replaceSplit({
      transactionId: inserted.id,
      amountCents: cents,
      payerPersonId: owner.id,
      method: 'equal',
      taxCents: 0,
      tipCents: 0,
      shares: shares.map((s) => ({ personId: s.personId, amountCents: s.amountCents, inputAmountCents: null, inputPercent: null })),
    });
    if ('error' in saved) {
      return { ok: true, warning: `Added ${formatUSD(toCents(cents))} paid alongside it, but its split was not saved: ${saved.error}` };
    }
    return {
      ok: true,
      message: `Added ${formatUSD(toCents(cents))} paid alongside it, split equally with ${people.filter((p) => !p.isOwner).map((p) => p.name).join(', ')}.`,
    };
  });
}

export type ConversionPreview = { ok: true; plan: ConversionPlan } | { error: string };

// What converting would do, computed by the conversion itself and rolled
// back: nothing is written.
export async function previewConversion(transactionId: unknown): Promise<ConversionPreview> {
  await requireUser();
  const row = id.safeParse(transactionId);
  if (!row.success) return { error: 'Invalid request.' };
  try {
    return await convertEditedRow(row.data, 'preview', false);
  } catch {
    return { error: 'Something went wrong. Nothing was converted.' };
  }
}

// Convert: the row returns to the amount it came in with and the extra
// becomes a paid-alongside purchase, refused unless every balance and the
// spending total are unchanged. The result repeats both numbers.
export async function convertToPaidAlongside(transactionId: unknown, description: unknown): Promise<ActionResult> {
  await requireUser();
  const row = id.safeParse(transactionId);
  const text = what.safeParse(description);
  if (!row.success) return { error: 'Invalid request.' };
  if (!text.success) return { error: text.error.issues[0].message };
  return attempt('convertToPaidAlongside', async () => {
    const result = await convertEditedRow(row.data, text.data, true);
    if ('error' in result) return result;
    refresh();
    const p = result.plan;
    const usd = (n: number) => formatUSD(toCents(n));
    return {
      ok: true,
      message: `Back to ${usd(p.originalCents)}, with ${usd(p.extraCents)} "${text.data}" paid alongside it, ${usd(p.partCents)} each.`,
      details: [
        ...p.people.filter((x) => !x.isOwner).map((x) => `${x.name} owes ${usd(x.before.owed)} before and ${usd(x.after.owed)} after; paid ${usd(x.before.paid)} before and after.`),
        `Your spending: ${usd(p.spending.before)} before and ${usd(p.spending.after)} after.`,
      ],
    };
  });
}
