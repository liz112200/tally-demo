'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { formatUSD, toCents } from '@/lib/money';
import { currentDifference, insertRaisedReview, insertStatementReview, liveAmountOf } from '@/db/reviews';
import { setLedgerClosed } from '@/db/statement-cycles';
import { conversionChecks } from '@/db/alongside';
import { requireUser } from '@/app/_lib/session';
import { attempt } from './attempt';

// Reviews and closed accounts (migration 0037, ACCOUNTS-BOARD.md). None of
// these touches a row, a split, a share or a payment: a review records what
// the owner accepted, and a closed date ends what statements are expected.

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note = z.string().trim().min(1, 'Say why, in a few words.').max(500, 'Keep the note under 500 characters.');
const mills = z.number().int();

const usd = (n: number) => formatUSD(toCents(n));
const side = (diff: number, word: string) => (diff === 0 ? null : `${usd(Math.abs(diff))} ${diff < 0 ? 'less' : 'more'} in ${word}`);

// Accept a statement's difference from its period's rows, as shown. Refused
// when it has changed since the page showed it: a review holds the figures
// the owner looked at, never ones they did not see.
export async function recordStatementReview(input: unknown): Promise<ActionResult> {
  await requireUser();
  const parsed = z
    .object({ ledgerAccountId: uuid, closingDate: isoDate, chargesDiff: mills, creditsDiff: mills, note })
    .safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  const r = parsed.data;
  return attempt('recordStatementReview', async () => {
    const now = await currentDifference(r.ledgerAccountId, r.closingDate);
    if (!now || (now.chargesDiff === 0 && now.creditsDiff === 0)) return { error: 'This statement agrees with its rows now; there is nothing to review.' };
    if (now.chargesDiff !== r.chargesDiff || now.creditsDiff !== r.creditsDiff) {
      return { error: `The difference has changed since this page showed it: it is now ${[side(now.chargesDiff, 'charges'), side(now.creditsDiff, 'credits')].filter(Boolean).join(' and ')}. Reload and review it as it is.` };
    }
    await insertStatementReview({ ledgerAccountId: r.ledgerAccountId, closingDate: r.closingDate, chargesDiffCents: now.chargesDiff, creditsDiffCents: now.creditsDiff, note: r.note });
    revalidatePath('/', 'layout');
    return { ok: true, message: `Reviewed: ${[side(now.chargesDiff, 'charges'), side(now.creditsDiff, 'credits')].filter(Boolean).join(' and ')}, accepted. If either figure changes, it is raised again.` };
  });
}

// Keep a raised row raised rather than convert it, at its current amount.
// Offered only where Move is (the conversion would accept the row).
export async function recordRaisedRowReview(input: unknown): Promise<ActionResult> {
  await requireUser();
  const parsed = z.object({ transactionId: uuid, amountCents: mills, note }).safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  const r = parsed.data;
  return attempt('recordRaisedRowReview', async () => {
    const amount = await liveAmountOf(r.transactionId);
    if (amount === null) return { error: 'That row no longer exists.' };
    if (amount !== r.amountCents) return { error: `Its amount has changed since this page showed it: it is now ${usd(amount)}. Reload and review it as it is.` };
    const check = (await conversionChecks()).get(r.transactionId);
    if (!check || 'error' in check) return { error: 'This row is not one that Move offers to convert, so there is nothing to keep.' };
    await insertRaisedReview({ transactionId: r.transactionId, amountCents: amount, note: r.note });
    revalidatePath('/', 'layout');
    return { ok: true, message: `Kept raised at ${usd(amount)}. If its amount changes, it is raised again.` };
  });
}

// Record the day an account closed, or clear it when recorded by mistake.
export async function setAccountClosed(ledgerAccountId: unknown, closedOn: unknown): Promise<ActionResult> {
  await requireUser();
  const id = uuid.safeParse(ledgerAccountId);
  const date = closedOn === null ? { success: true as const, data: null } : isoDate.safeParse(closedOn);
  if (!id.success || !date.success) return { error: 'Enter the day it closed.' };
  if (date.data !== null && date.data > new Date().toISOString().slice(0, 10)) return { error: 'That day is still to come.' };
  return attempt('setAccountClosed', async () => {
    if (!(await setLedgerClosed(id.data, date.data))) return { error: 'That account was not found.' };
    revalidatePath('/', 'layout');
    return { ok: true, message: date.data ? `Marked closed on ${date.data}. No statement is expected after it.` : 'Marked open again.' };
  });
}
