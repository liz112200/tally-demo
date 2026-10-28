'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '@/lib/action-result';
import { attempt } from './attempt';
import { csvLedger, ensureCsvLedger } from '@/db/ledger';
import { detectParser } from '@/lib/parsers/detect';
import {
  parsedTransactionSchema,
  type ParsedTransaction,
} from '@/lib/parsers/types';
import { normalizeMerchant } from '@/lib/parsers/normalize';
import { categorize, type CategoryRule } from '@/lib/categorize';
import { dedupHash } from '@/lib/parsers/dedup';
import {
  classifyDuplicate,
  planImportRow,
  type DuplicateKind,
} from '@/lib/import-dedup';
import { defaultImportName } from '@/lib/import-groups';
import {
  deleteEmptyImport,
  getRules,
  insertImport,
  insertTransaction,
  lookupDedupStatus,
  setImportHiddenById,
  showAllImports as showAllImportsQuery,
  restoreImportById,
  softDeleteImportById,
  updateImportDisplayName,
  updateImportAfterSkips,
} from '@/db/queries';
import {
  renameImportSchema,
  type PreviewState,
  type ConfirmState,
  type RenameImportState,
} from '@/app/_lib/schema';
import { requireUser } from '@/app/_lib/session';

// The canonical dedup hash for a parsed row — the same value the DB stores,
// so preview detection and the unique index agree on what a duplicate is.
function rowDedupHash(row: ParsedTransaction): string {
  return dedupHash({
    source: row.source,
    accountLabel: row.accountLabel,
    date: row.date,
    amountCents: row.amountCents,
    descriptionRaw: row.descriptionRaw,
  });
}

// Classify each parsed row against what is already in the DB: 'active' or
// 'deleted' if its hash collides with a live / soft-deleted row, else null.
async function classifyDuplicates(
  rows: ParsedTransaction[],
): Promise<(DuplicateKind | null)[]> {
  const hashes = rows.map(rowDedupHash);
  const status = await lookupDedupStatus([...new Set(hashes)]);
  return hashes.map((hash) => classifyDuplicate(status[hash]));
}

// Fetch the rules once and return both the engine-shaped array and a
// category-id -> name map for preview display.
async function loadRules(): Promise<{
  engineRules: CategoryRule[];
  nameById: Map<string, string>;
}> {
  const rules = await getRules();
  return {
    engineRules: rules.map((r) => ({
      categoryId: r.categoryId,
      matchPattern: r.matchPattern,
      matchType: r.matchType,
      priority: r.priority,
      createdAt: r.createdAt,
    })),
    nameById: new Map(rules.map((r) => [r.categoryId, r.categoryName])),
  };
}

// Read the uploaded file's text, or a clean error if nothing usable arrived.
async function readUploadText(
  formData: FormData,
): Promise<{ text: string; filename: string } | { error: string }> {
  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { error: 'Choose a CSV file to import.' };
  }
  return { text: await file.text(), filename: file.name };
}

// The single parse+validate path shared by preview and confirm: detect the
// bank, parse the tokenized data rows, then run every row through
// parsedTransactionSchema so no import bypasses the canonical validation.
function parseAndValidate(
  text: string,
): { ok: true; bank: string; rows: ParsedTransaction[] } | { ok: false; error: string } {
  const detected = detectParser(text);
  if (!detected.ok) return { ok: false, error: detected.error };

  let raw: ParsedTransaction[];
  try {
    raw = detected.parser.parseRows(detected.dataRows);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse the ${detected.parser.bank} file: ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    };
  }

  const rows: ParsedTransaction[] = [];
  for (const candidate of raw) {
    const parsed = parsedTransactionSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        ok: false,
        error: `A parsed row failed validation: ${issue?.message ?? 'invalid row'}`,
      };
    }
    rows.push(parsed.data);
  }
  return { ok: true, bank: detected.parser.bank, rows };
}

// Cap on how many parsed rows the preview table renders. Small imports (a
// statement) show every row so the sign and description of each can be eyeballed
// before confirming; larger files are truncated with rowCount still reporting
// the true total.
const PREVIEW_ROW_CAP = 100;

export async function previewImport(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  await requireUser();
  const upload = await readUploadText(formData);
  if ('error' in upload) return { error: upload.error };

  const result = parseAndValidate(upload.text);
  if (!result.ok) return { error: result.error };

  const { engineRules, nameById } = await loadRules();
  const duplicates = await classifyDuplicates(result.rows);
  const ledger = await csvLedger(result.rows[0]?.source ?? '', result.rows[0]?.accountLabel ?? null);
  const coveredFrom = ledger?.coveredFrom ?? null;
  const covered = result.rows.map((r) => coveredFrom !== null && r.date >= coveredFrom);
  const categorized = result.rows.map((r, i) => {
    const categoryId = categorize(normalizeMerchant(r.descriptionRaw), engineRules);
    return {
      index: i,
      row: r,
      category: categoryId ? nameById.get(categoryId) ?? null : null,
      duplicate: duplicates[i],
    };
  });

  const coveredCount = covered.filter(Boolean).length;
  const duplicateCount = duplicates.filter((d, i) => d !== null && !covered[i]).length;
  const dates = result.rows.map((r) => r.date).sort();
  return {
    ok: true,
    preview: {
      bank: result.bank,
      rowCount: result.rows.length,
      dateRange:
        dates.length > 0
          ? { from: dates[0], to: dates[dates.length - 1] }
          : null,
      autoCategorized: categorized.filter((c) => c.category !== null).length,
      uncategorized: categorized.filter((c) => c.category === null).length,
      newCount: result.rows.length - duplicateCount - coveredCount,
      duplicateCount,
      coveredCount,
      coveredFrom,
      rows: categorized
        .slice(0, PREVIEW_ROW_CAP)
        .map(({ index, row, category, duplicate }) => ({
          index,
          date: row.date,
          amountCents: row.amountCents,
          descriptionRaw: row.descriptionRaw,
          accountLabel: row.accountLabel,
          category,
          duplicate: covered[index] ? null : duplicate,
          coveredByBank: covered[index],
        })),
    },
  };
}

export async function confirmImport(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  await requireUser();
  const upload = await readUploadText(formData);
  if ('error' in upload) return { error: upload.error };

  const result = parseAndValidate(upload.text);
  if (!result.ok) return { error: result.error };

  const { engineRules } = await loadRules();

  if (result.rows.length === 0) {
    return { error: 'The file parsed but contained no transaction rows.' };
  }

  // Duplicates the user ticked "include anyway" in the preview, by their
  // stable file index. Non-duplicate rows ignore this set entirely.
  const approvedDuplicates = new Set(
    (formData.get('approveDuplicates') as string | null)
      ?.split(',')
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n)) ?? [],
  );
  const duplicates = await classifyDuplicates(result.rows);

  // The upload batch. Created up front so inserted rows can reference it;
  // row_count is provisional (the parsed total) until the dedup skips are
  // known, and a batch where every row was a skip is removed again — a
  // re-import of an already-imported file should not leave an empty group.
  // Standardized display name from the batch's date span, e.g.
  // "Discover 06/12 – 07/09", provisional like row_count: once the skips are
  // known it spans only the rows actually imported. The raw filename is kept
  // separately; the user can rename the label later.
  const batchDates = result.rows.map((r) => r.date).sort();
  // The batch's ledger account (REAL-ACCOUNTS.md); rows a bank already syncs
  // (on or after its cutover) are never imported: they would count twice.
  const ledgerAccountId = await ensureCsvLedger(result.rows[0].source, result.rows[0].accountLabel);
  const coveredFrom = (await csvLedger(result.rows[0].source, result.rows[0].accountLabel))?.coveredFrom ?? null;
  const { importId } = await insertImport({
    ledgerAccountId,
    source: result.rows[0].source,
    filename: upload.filename,
    displayName: defaultImportName(
      result.rows[0].source,
      batchDates[0],
      batchDates[batchDates.length - 1],
    ),
    rowCount: result.rows.length,
  });

  let inserted = 0;
  let skipped = 0;
  let forced = 0;
  let covered = 0;
  const writtenDates: string[] = [];
  for (const [i, row] of result.rows.entries()) {
    if (coveredFrom !== null && row.date >= coveredFrom) {
      covered += 1;
      continue;
    }
    const isDuplicate = duplicates[i] !== null;
    const plan = planImportRow(isDuplicate, approvedDuplicates.has(i));
    // An unapproved duplicate imports nothing.
    if (plan === 'skip') {
      skipped += 1;
      continue;
    }
    const categoryId = categorize(normalizeMerchant(row.descriptionRaw), engineRules);
    // 'force' sets dedup_exempt so the row lands past the unique index and
    // coexists with the transaction it duplicates.
    const res = await insertTransaction({
      date: row.date,
      amountCents: row.amountCents,
      descriptionRaw: row.descriptionRaw,
      categoryId,
      categorySource: categoryId ? 'rule' : null,
      source: row.source,
      accountLabel: row.accountLabel,
      importId,
      dedupExempt: plan === 'force',
    });
    if (res.inserted) {
      writtenDates.push(row.date);
      if (plan === 'force') forced += 1;
      else inserted += 1;
    } else {
      // A non-approved collision the preview missed (e.g. two identical rows
      // inside this same file) still no-ops on the index.
      skipped += 1;
    }
  }

  const written = inserted + forced;
  if (written === 0) await deleteEmptyImport(importId);
  else if (written !== result.rows.length) {
    writtenDates.sort();
    await updateImportAfterSkips(
      importId,
      written,
      defaultImportName(result.rows[0].source, writtenDates[0], writtenDates[writtenDates.length - 1]),
    );
  }

  revalidatePath('/');
  return { ok: true, result: { inserted, skipped, forced, covered } };
}

// Undo import: soft-delete the batch and every transaction in it. Splits
// under those transactions stop counting toward balances (the deleted_at
// filter is the cascade), so /people revalidates too.
export async function undoImport(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const importId = z.string().uuid().safeParse(formData.get('importId'));
  if (!importId.success) return { error: 'Invalid import.' };
  return attempt('undoImport', async () => {
    const undone = await softDeleteImportById(importId.data);
    if (!undone) return { error: 'That import is already undone.' };
    revalidatePath('/');
    revalidatePath('/people');
    const n = undone.rows;
    return { ok: true, message: `Import undone: ${n} row${n === 1 ? '' : 's'} deleted. Restore brings them back.` };
  });
}

// Restore an undone import: the batch and the transactions its undo deleted
// come back live, splits and balances included (nothing about them was
// changed by the undo). Rows deleted individually before the undo stay
// deleted. Re-importing the file is not the recovery path — it would insert
// dedup-exempt copies with no splits attached — so this is.
export async function restoreImport(importId: string): Promise<ActionResult> {
  await requireUser();
  const parsed = z.string().uuid().safeParse(importId);
  if (!parsed.success) return { error: 'Invalid import.' };
  return attempt('restoreImport', async () => {
    const restored = await restoreImportById(parsed.data);
    if (!restored) return { error: 'That import is not undone; there is nothing to restore.' };
    revalidatePath('/');
    revalidatePath('/people');
    const n = restored.rows;
    return { ok: true, message: `Restored ${n} row${n === 1 ? '' : 's'}.` };
  });
}

// Rename an import's display label from its group header.
export async function renameImport(
  _prev: RenameImportState,
  formData: FormData,
): Promise<RenameImportState> {
  await requireUser();
  const parsed = renameImportSchema.safeParse({
    importId: formData.get('importId'),
    displayName: formData.get('displayName'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid name' };
  }
  await updateImportDisplayName(parsed.data.importId, parsed.data.displayName);
  revalidatePath('/');
  return { ok: true };
}

// Hide or unhide an import batch. Persisted on the imports row (not the URL),
// so the choice survives reloads and deployments and the URL stays clean.
export async function setImportHidden(
  id: string,
  hidden: boolean,
): Promise<ActionResult> {
  await requireUser();
  const parsed = z.string().uuid().safeParse(id);
  if (!parsed.success || typeof hidden !== 'boolean') return { error: 'Invalid import.' };
  return attempt('setImportHidden', async () => {
    if (!(await setImportHiddenById(parsed.data, hidden))) return { error: 'That import was not found.' };
    revalidatePath('/');
    // The group moving in or out of the hidden strip is the confirmation.
    return { ok: true };
  });
}

// Unhide every hidden import ("Show all").
export async function showAllImports(): Promise<ActionResult> {
  await requireUser();
  return attempt('showAllImports', async () => {
    await showAllImportsQuery();
    revalidatePath('/');
    return { ok: true };
  });
}
