'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getBillLinkBase } from '@/app/_lib/bill-links';
import { billHref } from '@/lib/share-summary';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { insertShareLink, revokeSharedBill } from '@/db/queries';
import { shareLinkSchema } from '@/app/_lib/schema';
import { requireUser } from '@/app/_lib/session';

// The lines come from the client because the snapshot should preserve the
// sort and grouping the user is looking at, which is client state. They are
// validated here rather than trusted: v1 has a single user and no privilege
// boundary to cross, but the payload is written to a public page, so its
// shape and size are checked before it is stored.
export async function createShareLink(
  input: unknown,
): Promise<{ ok: true; href: string } | { ok: false; error: string }> {
  await requireUser();
  const parsed = shareLinkSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Could not build a share link',
    };
  }
  const base = await getBillLinkBase();
  if (base === null) return { ok: false, error: 'Bill site unavailable.' };
  const { token } = await insertShareLink(parsed.data);
  revalidatePath('/people/shared-bills');
  return { ok: true, href: billHref(base, token) };
}

export async function turnOffBillLink(id: string): Promise<ActionResult> {
  await requireUser();
  if (!z.string().uuid().safeParse(id).success) {
    return { error: 'Bill history is unavailable.' };
  }
  return attempt('turnOffBillLink', async () => {
    const bill = await revokeSharedBill(id);
    if (bill) revalidatePath(`/s/${bill.token}`);
    revalidatePath('/people/shared-bills');
    return { ok: true, message: 'Link turned off.' };
  });
}
