// Undone imports: what the restore strip says a restore would bring back.
// Found by the sweep for unqualified columns in select field lists: the count
// compared transactions.import_id with transactions.id and was always 0.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  getDeletedImports,
  insertImport,
  insertTransaction,
  softDeleteImportById,
  softDeleteTransactionById,
  restoreImportById,
  getTransactions,
} from './queries';

describe('undone imports', () => {
  it('count exactly the rows a restore would revive, not rows deleted before the undo', async () => {
    const tag = `UNDOCHECK${randomUUID().slice(0, 8).toUpperCase()}`;
    const { importId } = await insertImport({ source: 'chase', filename: `${tag}.csv`, displayName: tag, rowCount: 3 });
    for (const n of [1, 2, 3]) {
      await insertTransaction({
        date: `2026-09-0${n}`,
        amountCents: n * 1_000,
        descriptionRaw: `${tag} ROW ${n}`,
        categoryId: null,
        source: 'chase',
        importId,
      });
    }
    const rows = (await getTransactions()).filter((t) => t.descriptionRaw.startsWith(tag));
    expect(rows).toHaveLength(3);
    // Deleted on its own before the undo: stays deleted after a restore.
    await softDeleteTransactionById(rows[0].id);
    await softDeleteImportById(importId);

    const undone = (await getDeletedImports()).find((i) => i.id === importId);
    expect(undone?.restorableCount).toBe(2);

    await restoreImportById(importId);
    expect((await getTransactions()).filter((t) => t.descriptionRaw.startsWith(tag))).toHaveLength(2);
  });
});
