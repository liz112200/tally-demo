'use server';

import { revalidatePath } from 'next/cache';
import { formatUSD, parseDollars, toCents } from '@/lib/money';
import { checkAllocations } from '@/lib/settle-selection';
import {
  deleteSettlementById,
  insertSettlementWithAllocations,
  recordSettlementGroup,
  SettlementWriteError,
} from '@/db/queries';
import {
  settlementSchema,
  settlementAllocationsInputSchema,
  settlementGroupSchema,
  type SettlementFormState,
} from '@/app/_lib/schema';

export async function createSettlement(
  _prev: SettlementFormState,
  formData: FormData,
): Promise<SettlementFormState> {
  const parsed = settlementSchema.safeParse({
    personId: formData.get('personId'),
    direction: formData.get('direction') ?? 'incoming',
    amount: formData.get('amount'),
    date: formData.get('date'),
    note: formData.get('note') ?? '',
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !(key in errors)) errors[key] = issue.message;
    }
    return { errors };
  }

  // Advanced mode (optional): explicit per-share allocation. Absent or
  // malformed => default FIFO across outstanding shares.
  let manualAllocations: { shareId: string; amountCents: number }[] | undefined;
  const rawAllocations = formData.get('allocations');
  if (typeof rawAllocations === 'string' && rawAllocations.length > 0) {
    try {
      const parsedAlloc = settlementAllocationsInputSchema.safeParse(
        JSON.parse(rawAllocations),
      );
      if (parsedAlloc.success && parsedAlloc.data.length > 0) {
        manualAllocations = parsedAlloc.data;
      }
    } catch {
      // Ignore a malformed advanced payload and fall back to FIFO.
    }
  }

  // Over-allocation is a hard block, not a silent trim: the requested amounts
  // may not sum past the payment. Under-allocation stays allowed (the
  // remainder becomes credit). Same check the allocator dialog runs.
  const amountCents = parseDollars(parsed.data.amount);
  if (manualAllocations) {
    const check = checkAllocations(amountCents, manualAllocations);
    if (!check.ok) {
      return {
        errors: {
          allocations: `Allocations exceed the payment by ${formatUSD(toCents(check.overByCents))}`,
        },
      };
    }
  }

  await insertSettlementWithAllocations({
    personId: parsed.data.personId,
    amountCents,
    direction: parsed.data.direction,
    date: parsed.data.date,
    note: parsed.data.note,
    manualAllocations,
  });

  revalidatePath('/people');
  return { ok: true };
}

// The share picker: a payment against chosen shares on either side, netted
// into cash plus an offset pair when both sides are selected, or an edit of
// an existing settlement (replaceId). All validation that matters — shares
// still outstanding, cash not below the net — runs inside the write's
// transaction, which rolls back on refusal.
export async function recordPickedSettlement(
  _prev: SettlementFormState,
  formData: FormData,
): Promise<SettlementFormState> {
  const json = (key: string): unknown => {
    try {
      return JSON.parse(String(formData.get(key) ?? '[]'));
    } catch {
      return null;
    }
  };
  const parsed = settlementGroupSchema.safeParse({
    personId: formData.get('personId'),
    date: formData.get('date'),
    note: formData.get('note') ?? '',
    cash: formData.get('cash') ?? '',
    fallbackDirection: formData.get('fallbackDirection') ?? 'incoming',
    incoming: json('incoming'),
    outgoing: json('outgoing'),
    replaceId: formData.get('replaceId') || null,
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !(key in errors)) errors[key] = issue.message;
    }
    return { errors };
  }

  const d = parsed.data;
  try {
    await recordSettlementGroup({
      personId: d.personId,
      date: d.date,
      note: d.note,
      incoming: d.incoming,
      outgoing: d.outgoing,
      pinnedCashCents: d.cash === '' ? null : parseDollars(d.cash),
      fallbackDirection: d.fallbackDirection,
      replaceId: d.replaceId,
    });
  } catch (e) {
    if (e instanceof SettlementWriteError) return { errors: { allocations: e.message } };
    throw e;
  }

  revalidatePath('/people');
  return { ok: true };
}

// Hard-delete a settlement, with the rest of its netted group. The person's
// balance recomputes on the revalidated page; if the payment was the only
// thing keeping a soft-deleted person visible, that person drops off /people
// entirely.
export async function deleteSettlement(id: string): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) return;
  await deleteSettlementById(id);
  revalidatePath('/people');
}
