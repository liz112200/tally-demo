'use server';

import { revalidatePath } from 'next/cache';
import { toCents } from '@/lib/money';
import { computeShares, computeItemShares } from '@/lib/split';
import {
  getPersons,
  getTransactionForSplit,
  getReceiptByTransactionId,
  replaceSplit,
  replaceItemSplit,
  deleteSplitByTransactionId,
} from '@/db/queries';
import {
  splitPayloadSchema,
  itemSplitSchema,
  type SplitFormState,
  type ItemSplitState,
} from '@/app/_lib/schema';

function revalidateSplitViews() {
  revalidatePath('/');
  revalidatePath('/people');
}

// Create or overwrite a transaction's split. The engine re-resolves shares
// server-side from the stored transaction amount and the raw inputs, with
// participants in person created_at order — the client preview runs the same
// pure function, so what was previewed is what lands.
export async function saveSplit(
  _prev: SplitFormState,
  formData: FormData,
): Promise<SplitFormState> {
  const raw = formData.get('payload');
  if (typeof raw !== 'string') return { error: 'Missing payload' };

  let parsed;
  try {
    parsed = splitPayloadSchema.safeParse(JSON.parse(raw));
  } catch {
    return { error: 'Malformed payload' };
  }
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid split' };
  }
  const payload = parsed.data;

  const transaction = await getTransactionForSplit(payload.transactionId);
  if (!transaction) return { error: 'Transaction not found' };
  if (!transaction.isSplittable) {
    return { error: 'This transaction is not splittable' };
  }

  // Resolve participants against active persons, in created_at order (the
  // remainder rule depends on it); drop any stale or deleted ids.
  const activePersons = await getPersons();
  const owner = activePersons.find((p) => p.isOwner);
  if (!owner) return { error: 'Owner person missing' };
  const active = new Map(activePersons.map((p) => [p.id, p]));
  const byId = new Map(payload.participants.map((p) => [p.personId, p]));
  const participants = [...active.values()].filter((p) => byId.has(p.id));
  if (participants.length !== payload.participants.length) {
    return { error: 'A selected person no longer exists' };
  }

  const inputs =
    payload.method === 'amount'
      ? participants.map((p) => byId.get(p.id)!.inputAmountCents)
      : payload.method === 'percent'
        ? participants.map((p) => byId.get(p.id)!.inputPercent)
        : undefined;
  if (inputs && inputs.some((v) => v === null)) {
    return {
      error:
        payload.method === 'amount'
          ? 'Enter an amount for every participant'
          : 'Enter a percent for every participant',
    };
  }

  let shares;
  try {
    shares = computeShares(
      toCents(transaction.amountCents),
      toCents(payload.taxCents),
      toCents(payload.tipCents),
      payload.method,
      participants.map((p) => ({ personId: p.id })),
      inputs as number[] | undefined,
    );
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid split' };
  }

  await replaceSplit({
    transactionId: payload.transactionId,
    // Owner-paid split: the payer is always the owner (external splits are
    // created through createExternalExpense, never here).
    payerPersonId: owner.id,
    method: payload.method,
    taxCents: payload.taxCents,
    tipCents: payload.tipCents,
    shares: shares.map((s) => ({
      personId: s.personId,
      amountCents: s.amountCents,
      inputAmountCents:
        payload.method === 'amount'
          ? byId.get(s.personId)!.inputAmountCents
          : null,
      inputPercent:
        payload.method === 'percent' ? byId.get(s.personId)!.inputPercent : null,
    })),
  });

  revalidateSplitViews();
  return { ok: true };
}

// Save an item split from receipt assignments. Shares derive server-side
// from the stored receipt items (the review step already persisted any
// edits), with the same pure engine the assignment preview ran.
export async function saveItemSplit(
  _prev: ItemSplitState,
  formData: FormData,
): Promise<ItemSplitState> {
  const raw = formData.get('payload');
  if (typeof raw !== 'string') return { error: 'Missing payload' };
  let parsed;
  try {
    parsed = itemSplitSchema.safeParse(JSON.parse(raw));
  } catch {
    return { error: 'Malformed payload' };
  }
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid assignments' };
  }
  const payload = parsed.data;

  const receipt = await getReceiptByTransactionId(payload.transactionId);
  if (!receipt || receipt.id !== payload.receiptId) {
    return { error: 'Receipt not found' };
  }
  const assignmentByItem = new Map(
    payload.assignments.map((a) => [a.itemId, a.personIds]),
  );
  if (
    receipt.items.length !== payload.assignments.length ||
    receipt.items.some((item) => !assignmentByItem.has(item.id))
  ) {
    return { error: 'Assignments do not match the receipt items — reopen and retry' };
  }

  const persons = await getPersons();
  const owner = persons.find((p) => p.isOwner);
  if (!owner) return { error: 'Owner person missing' };

  let shares;
  try {
    shares = computeItemShares({
      ownerId: owner.id,
      taxCents: toCents(receipt.taxCents),
      tipCents: toCents(receipt.tipCents),
      items: receipt.items.map((item) => ({
        amountCents: toCents(item.amountCents),
        assigneePersonIds: assignmentByItem.get(item.id)!,
      })),
      personOrder: persons.map((p) => p.id),
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid assignments' };
  }

  await replaceItemSplit({
    transactionId: payload.transactionId,
    payerPersonId: owner.id,
    receiptId: receipt.id,
    taxCents: receipt.taxCents,
    tipCents: receipt.tipCents,
    shares,
    assignments: payload.assignments.flatMap((a) =>
      a.personIds.map((personId) => ({ receiptItemId: a.itemId, personId })),
    ),
  });

  revalidateSplitViews();
  return { ok: true };
}

// Remove a split entirely; the transaction becomes the owner's again.
export async function removeSplit(formData: FormData): Promise<void> {
  const transactionId = formData.get('transactionId');
  if (typeof transactionId === 'string' && transactionId.length > 0) {
    await deleteSplitByTransactionId(transactionId);
    revalidateSplitViews();
  }
}
