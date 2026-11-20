'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { isDemoMode } from '@/lib/demo-mode';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { insertShareLink, revokeSharedBill } from '@/db/queries';
import { shareLinkSchema } from '@/app/_lib/schema';
import { requireUser } from '@/app/_lib/session';

// The caller builds the link on the separate bill site, or on the demo's origin.
//
// The lines come from the client because the snapshot should preserve the
// sort and grouping the user is looking at, which is client state. They are
// validated here rather than trusted: v1 has a single user and no privilege
// boundary to cross, but the payload is written to a public page, so its
// shape and size are checked before it is stored.
export async function createShareLink(
  input: unknown,
): Promise<{ ok: true; token: string } | { ok: false; error: string }> {
  await requireUser();
  const parsed = shareLinkSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Could not build a share link',
    };
  }
  const { token } = await insertShareLink(parsed.data);
  if (isDemoMode()) revalidatePath('/people/shared-bills');
  return { ok: true, token };
}

export async function turnOffBillLink(id: string): Promise<ActionResult> {
  await requireUser();
  if (!isDemoMode() || !z.string().uuid().safeParse(id).success) {
    return { error: 'Bill history is unavailable.' };
  }
  return attempt('turnOffBillLink', async () => {
    const bill = await revokeSharedBill(id);
    if (bill) revalidatePath(`/s/${bill.token}`);
    revalidatePath('/people/shared-bills');
    return { ok: true, message: 'Link turned off.' };
  });
}
