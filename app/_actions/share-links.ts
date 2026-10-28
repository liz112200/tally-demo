'use server';

import { insertShareLink } from '@/db/queries';
import { shareLinkSchema } from '@/app/_lib/schema';
import { requireUser } from '@/app/_lib/session';

// Publish a snapshot of one person's outstanding list and return its token.
// The caller builds the absolute URL from window.location.origin, so the
// link is correct on localhost, a preview deployment, and production alike
// without the server needing to know its own public hostname.
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
  return { ok: true, token };
}
