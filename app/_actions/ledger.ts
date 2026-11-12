'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import {
  adoptReissuedAccount,
  dismissBoundaryReview,
  mapAccountToLedger,
  recordStatements,
  recordVerification,
  rejectReissuedAccount,
  resolveHeldRow,
  verificationRows,
} from '@/db/ledger';
import type { ActionResult } from '@/lib/action-result';
import { compareToStatement, type VerificationResult } from '@/lib/bank-sync/verify';
import { isDemoMode } from '@/lib/demo-mode';
import { parseDollars } from '@/lib/money';
import { parseClosingDates } from '@/lib/statement-cycles';
import { deleteStatement, editStatement, statementOf as recordedStatement } from '@/db/statement-cycles';
import { requireUser } from '@/app/_lib/session';
import { attempt } from './attempt';

// Ledger accounts, the cutover, re-issued accounts, the boundary review and
// sign verification (bank sync slice 7, REAL-ACCOUNTS.md). None of these
// writes a CSV or manual row.

const NOT_IN_DEMO = 'Bank linking is not available in the demo.';
const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function refresh() {
  revalidatePath('/', 'layout');
  revalidatePath('/', 'layout');
  revalidatePath('/insights');
}

const setUpSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('existing'), ledgerAccountId: uuid, cutoverDate: isoDate.nullable() }),
  z.object({ kind: z.literal('new'), displayName: z.string().trim().min(1).max(80), noCsvHistory: z.boolean() }),
]);

// Choose the ledger account an account syncs into, confirm its cutover, and
// turn its sync on.
export async function setUpAccountSync(accountId: unknown, choice: unknown): Promise<ActionResult> {
  await requireUser();
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const id = uuid.safeParse(accountId);
  const parsed = setUpSchema.safeParse(choice);
  if (!id.success || !parsed.success) return { error: 'Invalid request.' };
  return attempt('setUpAccountSync', async () => {
    const result = await mapAccountToLedger(id.data, parsed.data);
    if ('error' in result) return result;
    refresh();
    return { ok: true, message: `${result.message} Press Sync now to fetch it.` };
  });
}

export async function adoptAccount(accountId: unknown): Promise<ActionResult> {
  await requireUser();
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const id = uuid.safeParse(accountId);
  if (!id.success) return { error: 'Invalid request.' };
  return attempt('adoptAccount', async () => {
    const result = await adoptReissuedAccount(id.data);
    if ('error' in result) return result;
    refresh();
    return { ok: true, message: result.message };
  });
}

export async function declineReissued(accountId: unknown): Promise<ActionResult> {
  await requireUser();
  if (isDemoMode()) return { error: NOT_IN_DEMO };
  const id = uuid.safeParse(accountId);
  if (!id.success) return { error: 'Invalid request.' };
  return attempt('declineReissued', async () => {
    const result = await rejectReissuedAccount(id.data);
    if ('error' in result) return result;
    refresh();
    return { ok: true, message: result.message };
  });
}

export async function answerHeldRow(accountId: unknown, providerTransactionId: unknown, answer: unknown): Promise<ActionResult> {
  await requireUser();
  const id = uuid.safeParse(accountId);
  const txn = z.string().min(1).max(200).safeParse(providerTransactionId);
  const which = z.enum(['same', 'released']).safeParse(answer);
  if (!id.success || !txn.success || !which.success) return { error: 'Invalid request.' };
  return attempt('answerHeldRow', async () => {
    const result = await resolveHeldRow(id.data, txn.data, which.data);
    if ('error' in result) return result;
    refresh();
    return { ok: true, message: result.message };
  });
}

export async function finishBoundaryReview(accountId: unknown): Promise<ActionResult> {
  await requireUser();
  const id = uuid.safeParse(accountId);
  if (!id.success) return { error: 'Invalid request.' };
  return attempt('finishBoundaryReview', async () => {
    const result = await dismissBoundaryReview(id.data);
    if ('error' in result) return result;
    refresh();
    return { ok: true, message: 'Boundary review done.' };
  });
}

const statementSchema = z.object({
  from: isoDate,
  to: isoDate,
  charges: z.string().min(1),
  credits: z.string().min(1),
  excludedKeys: z.array(z.string()).max(500),
  confirmed: z.boolean(),
});

export type VerificationCheck = { ok: true; result: VerificationResult; rows: number } | { error: string };

function statementOf(input: z.infer<typeof statementSchema>) {
  return {
    from: input.from,
    to: input.to,
    chargesCents: parseDollars(input.charges),
    creditsCents: parseDollars(input.credits),
  };
}

// Compare without recording: what the page shows as the owner fills it in.
export async function checkAgainstStatement(accountId: unknown, statement: unknown): Promise<VerificationCheck> {
  await requireUser();
  const id = uuid.safeParse(accountId);
  const parsed = statementSchema.safeParse(statement);
  if (!id.success || !parsed.success) return { error: 'Enter the statement period and both totals.' };
  if (parsed.data.from > parsed.data.to) return { error: 'The period ends before it starts.' };
  let s;
  try {
    s = statementOf(parsed.data);
  } catch {
    return { error: 'Enter the totals as amounts, like 1,234.56.' };
  }
  const result = await attempt('checkAgainstStatement', async () => {
    const rows = await verificationRows(id.data, s.from, s.to);
    const compared = compareToStatement({
      rows,
      statement: s,
      excludedKeys: new Set(parsed.data.excludedKeys),
      confirmed: parsed.data.confirmed,
    });
    return { ok: true as const, result: compared, rows: rows.length };
  });
  return 'error' in result ? result : { ok: true, result: result.result, rows: result.rows };
}

// Record the outcome. Compared again on the server: a pass is recorded only
// if it passes here. A fail turns the account's sync off; its rows stay
// uncounted until the sign mapping is fixed and the check passes.
export async function recordStatementCheck(accountId: unknown, statement: unknown, outcome: unknown): Promise<ActionResult> {
  await requireUser();
  const id = uuid.safeParse(accountId);
  const parsed = statementSchema.safeParse(statement);
  const which = z.enum(['pass', 'fail']).safeParse(outcome);
  if (!id.success || !parsed.success || !which.success) return { error: 'Invalid request.' };
  let s;
  try {
    s = statementOf(parsed.data);
  } catch {
    return { error: 'Enter the totals as amounts, like 1,234.56.' };
  }
  return attempt('recordStatementCheck', async () => {
    const rows = await verificationRows(id.data, s.from, s.to);
    const compared = compareToStatement({ rows, statement: s, excludedKeys: new Set(parsed.data.excludedKeys), confirmed: parsed.data.confirmed });
    if (which.data === 'pass' && !compared.passed) return { error: 'This does not match the statement yet; nothing was recorded.' };
    const record = {
      statement: s,
      fetchedChargesCents: compared.fetchedChargesCents,
      fetchedCreditsCents: compared.fetchedCreditsCents,
      excluded: compared.excluded.map((r) => ({ postedDate: r.postedDate, amountCents: r.amountCents, description: r.description })),
      outcome: which.data,
    };
    const period = { from: s.from, to: s.to, chargesCents: s.chargesCents, creditsCents: s.creditsCents };
    if (!(await recordVerification(id.data, { passed: which.data === 'pass', record, period }))) return { error: 'Account not found.' };
    refresh();
    return which.data === 'pass'
      ? { ok: true, message: 'Verified against the statement. This account’s synced rows now count.' }
      : { ok: true, warning: 'Recorded as not matching. Sync is off for this account, and its rows stay uncounted.' };
  });
}

// Statements as the bank issued them (STATEMENT-CYCLES.md), recorded from the
// owner's own: one with its dates, or a pasted list of closing dates. Allowed
// in the demo, whose data resets daily.
const recordedStatementSchema = z
  .object({
    ledgerAccountId: uuid,
    closingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the closing date.'),
    periodStart: z.union([isoDate, z.literal('')]),
    nextClosingDate: z.union([isoDate, z.literal('')]),
    startsNewCycle: z.boolean(),
    // The statement's two totals as printed, optional.
    charges: z.string().max(40).optional(),
    credits: z.string().max(40).optional(),
  })
  .refine((s) => !s.periodStart || s.periodStart <= s.closingDate, { message: 'The period starts after it closes.' })
  .refine((s) => !s.nextClosingDate || s.nextClosingDate > s.closingDate, { message: 'The next closing date must come after this one.' });

const today = () => new Date().toISOString().slice(0, 10);

// The two totals as typed: blank is none.
function readTotals(s: { charges?: string; credits?: string }): { chargesCents: number | null; creditsCents: number | null } | null {
  try {
    return {
      chargesCents: s.charges?.trim() ? Math.abs(parseDollars(s.charges)) : null,
      creditsCents: s.credits?.trim() ? Math.abs(parseDollars(s.credits)) : null,
    };
  } catch {
    return null;
  }
}

export async function recordStatement(input: unknown): Promise<ActionResult> {
  await requireUser();
  const parsed = recordedStatementSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  const s = parsed.data;
  if (s.closingDate > today()) return { error: 'That closing date is still to come; record a statement once it has closed.' };
  const totals = readTotals(s);
  if (!totals) return { error: 'Enter the totals as amounts, like 1,234.56.' };
  const { chargesCents, creditsCents } = totals;
  return attempt('recordStatement', async () => {
    // One way to change a statement, which says it changes one: recording a
    // closing date already recorded used to merge into it silently.
    if (await recordedStatement(s.ledgerAccountId, s.closingDate)) {
      return { error: `A statement closing ${s.closingDate} is already recorded. Use Edit beside it in the list to change it.` };
    }
    await recordStatements(
      s.ledgerAccountId,
      [{ closingDate: s.closingDate, periodStart: s.periodStart || null, nextClosingDate: s.nextClosingDate || null, startsNewCycle: s.startsNewCycle, chargesCents, creditsCents }],
      'owner',
    );
    refresh();
    return { ok: true, message: `Statement closing ${s.closingDate} recorded.` };
  });
}

// A recorded statement edited in place (db/statement-cycles.ts, editStatement).
export async function editRecordedStatement(input: unknown): Promise<ActionResult> {
  await requireUser();
  const parsed = recordedStatementSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };
  const s = parsed.data;
  const totals = readTotals(s);
  if (!totals) return { error: 'Enter the totals as amounts, like 1,234.56.' };
  return attempt('editRecordedStatement', async () => {
    const outcome = await editStatement(s.ledgerAccountId, s.closingDate, {
      periodStart: s.periodStart || null,
      nextClosingDate: s.nextClosingDate || null,
      startsNewCycle: s.startsNewCycle,
      ...totals,
    });
    if (outcome === 'missing') return { error: `The statement closing ${s.closingDate} is no longer recorded.` };
    if (outcome === 'from-check') {
      return { error: 'Its period and totals are the statement check’s, which matched them to the rows to the cent, so they are not edited.' };
    }
    refresh();
    return { ok: true, message: `Statement closing ${s.closingDate} updated.` };
  });
}

// A list pasted from the bank's own list of closing dates. Read again here,
// never trusted from the browser; anything unreadable refuses the whole list.
export async function recordClosingDates(ledgerAccountId: unknown, text: unknown): Promise<ActionResult> {
  await requireUser();
  const id = uuid.safeParse(ledgerAccountId);
  const body = z.string().max(5000).safeParse(text);
  if (!id.success || !body.success) return { error: 'Invalid request.' };
  const { dates, unread } = parseClosingDates(body.data, today());
  if (unread.length > 0) return { error: `Nothing recorded: could not read ${unread.map((u) => `“${u}”`).join(', ')}.` };
  if (dates.length === 0) return { error: 'No closing dates found.' };
  return attempt('recordClosingDates', async () => {
    await recordStatements(id.data, dates.map((closingDate) => ({ closingDate })), 'owner');
    refresh();
    return { ok: true, message: `Recorded ${dates.length} closing date${dates.length === 1 ? '' : 's'}, ${dates[0]} to ${dates[dates.length - 1]}.` };
  });
}

export async function removeStatement(ledgerAccountId: unknown, closingDate: unknown): Promise<ActionResult> {
  await requireUser();
  const id = uuid.safeParse(ledgerAccountId);
  const date = isoDate.safeParse(closingDate);
  if (!id.success || !date.success) return { error: 'Invalid request.' };
  return attempt('removeStatement', async () => {
    if (!(await deleteStatement(id.data, date.data))) return { error: 'That statement was already removed.' };
    refresh();
    return { ok: true, message: `Statement closing ${date.data} removed.` };
  });
}
