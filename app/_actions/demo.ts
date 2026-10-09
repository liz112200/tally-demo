'use server';

import { revalidatePath } from 'next/cache';
import { resetDemo } from '@/db/demo-reset';
import { isDemoMode } from '@/lib/demo-mode';

// Per-instance floor between resets from the banner button, so a held-down
// click cannot queue a dozen rebuilds. Not a security boundary: the reset only
// ever touches the demo's own stores.
const MIN_INTERVAL_MS = 30_000;
let lastReset = 0;

export async function resetDemoNow(): Promise<{ ok: true } | { error: string }> {
  if (!isDemoMode()) return { error: 'Not available' };
  if (Date.now() - lastReset < MIN_INTERVAL_MS) {
    return { error: 'The demo was just reset; try again in a few seconds.' };
  }
  lastReset = Date.now();
  await resetDemo({
    DATABASE_URL: process.env.DATABASE_URL,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
  });
  revalidatePath('/', 'layout');
  return { ok: true };
}
