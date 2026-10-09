// Reset the demo: wipe its database and Blob store and write a fresh copy of
// the synthetic ledger (lib/demo/seed.ts) dated against today.
//
// Destructive by design, so it proves where it is first: the stores must carry
// the demo markers (db/demo-guard.ts), checked once up front and again inside
// the transaction immediately before TRUNCATE. Production carries neither
// marker and can never acquire them, so this cannot run against it whatever
// the environment says.
//
// Order keeps visitors from seeing a half-built ledger: new receipt images are
// uploaded first, the wipe and every insert happen in one transaction, and
// only after it commits are the previous images deleted.
//
// Shared by the daily cron route, the banner's reset action, and the
// `npm run demo:reset` CLI, so no 'server-only' and relative imports only.
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { del, list, put } from '@vercel/blob';
import * as schema from './schema';
import { DEMO_BLOB_MARKER, DEMO_DB_COMMENT, DEMO_DB_COMMENT_QUERY, demoStoreProblems } from './demo-guard';
import { buildDemoSeed } from '../lib/demo/seed';

// Every app table, wiped together. share_links included: demo visitors'
// published snapshots go with everything else.
const TABLES = [
  'settlement_allocations', 'settlements', 'receipt_item_assignments',
  'receipt_items', 'receipt_images', 'receipts', 'split_shares', 'splits',
  'transactions', 'imports', 'categorization_rules', 'categories', 'persons',
  'share_links',
];

export async function resetDemo(env: {
  DATABASE_URL?: string;
  BLOB_READ_WRITE_TOKEN?: string;
  today?: string;
}): Promise<{ transactions: number; receipts: number }> {
  const problems = await demoStoreProblems(env);
  if (problems.length > 0) {
    throw new Error(`Refusing to reset: these are not the demo's stores.\n- ${problems.join('\n- ')}`);
  }
  const token = env.BLOB_READ_WRITE_TOKEN!;
  const today = env.today ?? new Date().toISOString().slice(0, 10);
  const seed = buildDemoSeed(today);

  const previous = await listBlobs(token);

  // Receipt images first; the rows that point at them land in one commit.
  const urls = new Map<string, string>();
  await inBatches(seed.receipts, 6, async (r) => {
    const blob = await put(r.image.pathname, r.image.svg, {
      token,
      access: 'private',
      contentType: 'image/svg+xml',
      addRandomSuffix: true,
    });
    urls.set(r.id, blob.url);
  });

  const client = postgres(env.DATABASE_URL!, { prepare: false, max: 1 });
  try {
    const db = drizzle(client, { schema });
    await db.transaction(async (tx) => {
      const [marker] = (await tx.execute(sql.raw(DEMO_DB_COMMENT_QUERY))) as unknown as {
        value: string | null;
      }[];
      if (marker?.value !== DEMO_DB_COMMENT) throw new Error('Refusing to reset: database marker vanished');

      await tx.execute(sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`));

      const insert = async <T extends Record<string, unknown>>(table: Parameters<typeof tx.insert>[0], rows: T[]) => {
        for (let i = 0; i < rows.length; i += 500) {
          if (rows.length > 0) await tx.insert(table).values(rows.slice(i, i + 500) as never);
        }
      };
      await insert(schema.persons, seed.persons);
      await insert(schema.categories, seed.categories);
      await insert(schema.categorizationRules, seed.rules);
      await insert(schema.imports, seed.imports);
      await insert(schema.transactions, seed.transactions);
      await insert(schema.splits, seed.splits);
      await insert(schema.splitShares, seed.splitShares);
      await insert(
        schema.receipts,
        seed.receipts.map(({ image: _image, ...r }) => ({ ...r, blobUrl: urls.get(r.id)!, rawLlmResponse: null })),
      );
      await insert(
        schema.receiptImages,
        seed.receipts.map((r) => ({ receiptId: r.id, blobUrl: urls.get(r.id)!, position: 0, createdAt: r.createdAt })),
      );
      await insert(schema.receiptItems, seed.receiptItems);
      await insert(schema.receiptItemAssignments, seed.receiptItemAssignments);
      await insert(schema.settlements, seed.settlements);
      await insert(schema.settlementAllocations, seed.settlementAllocations);
    });
  } catch (err) {
    // The new images never got rows; clear them so a failed reset leaks
    // nothing. The previous ledger and its images are untouched.
    await del([...urls.values()], { token }).catch(() => {});
    throw err;
  } finally {
    await client.end();
  }

  // Committed: the previous images (receipts and anything visitors uploaded)
  // are unreferenced now. The store marker always stays.
  const stale = previous.filter((b) => b.pathname !== DEMO_BLOB_MARKER).map((b) => b.url);
  for (let i = 0; i < stale.length; i += 500) {
    await del(stale.slice(i, i + 500), { token });
  }

  return { transactions: seed.transactions.length, receipts: seed.receipts.length };
}

async function listBlobs(token: string): Promise<{ url: string; pathname: string }[]> {
  const out: { url: string; pathname: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ token, cursor, limit: 1000 });
    out.push(...page.blobs.map((b) => ({ url: b.url, pathname: b.pathname })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function inBatches<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
}
