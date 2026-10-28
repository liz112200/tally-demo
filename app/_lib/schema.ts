import { z } from 'zod';
import { tryParseDollars } from '@/lib/money';
import type { DuplicateKind } from '@/lib/import-dedup';

export const SOURCES = ['manual', 'chase', 'discover', 'amex'] as const;

// Category Selects use this sentinel for "Uncategorized" because the value must
// be a non-empty string to round-trip through FormData. The helpers below are
// the single place that converts between the sentinel and the nullable
// categoryId the database stores.
export const UNCATEGORIZED = '__none__';

export function sentinelToCategoryId(
  value: string | null | undefined,
): string | null {
  return !value || value === UNCATEGORIZED ? null : value;
}

export function categoryIdToSentinel(id: string | null | undefined): string {
  return id ?? UNCATEGORIZED;
}

// Free-text note bound so a runaway paste can't bloat a row; empty (after
// trim) normalizes to null so "cleared" and "never set" are the same state.
export const TRANSACTION_NOTE_MAX = 500;
const noteField = z
  .string()
  .trim()
  .max(TRANSACTION_NOTE_MAX, 'Keep the note under 500 characters')
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

export const createTransactionSchema = z.object({
  date: z.string().min(1, 'Date is required'),
  amount: z
    .string()
    .refine((v) => tryParseDollars(v) !== null, 'Enter a dollar amount like 12.34'),
  description: z.string().trim().min(1, 'Description is required'),
  categoryId: z.string().uuid().nullable(),
  note: noteField,
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

export const updateCategorySchema = z.object({
  id: z.string().uuid(),
  categoryId: z.string().uuid().nullable(),
});

// Set/clear a transaction's note from the row detail. Independent of the
// core-field edit so a note change never touches the dedup hash or splits.
export const updateTransactionNoteSchema = z.object({
  id: z.string().uuid(),
  note: noteField,
});

export type UpdateNoteState = {
  error?: string;
  ok?: boolean;
};

// Inline edit of an expanded row's core fields: the same date / amount /
// description validation as manual entry, plus the row id. The dedup hash
// is deliberately NOT part of this path — it recorded what the import
// saw, and user edits are trusted post-hoc.
export const updateTransactionDetailsSchema = createTransactionSchema
  .pick({ date: true, amount: true, description: true })
  .extend({ id: z.string().uuid() });

// Bulk actions submit the selected row ids as a plain array. Capped well
// above any realistic page selection to bound the SQL IN list.
export const bulkTransactionIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(1000);

// Re-exported so forms, actions, and importers share one ParsedTransaction
// definition; the schema itself lives framework-free in lib/parsers.
export {
  parsedTransactionSchema,
  type ParsedTransaction,
} from '@/lib/parsers/types';

// useActionState return shapes for the import flow. These are action outputs,
// not validated inputs, so they are plain types rather than Zod schemas.
// Duplicate classification lives framework-free in lib; re-exported so the
// import form and actions share one definition.
export type { DuplicateKind };

export type ImportPreview = {
  bank: string;
  rowCount: number;
  dateRange: { from: string; to: string } | null;
  // How many rows a rule will auto-categorize on confirm, and how many will
  // land uncategorized.
  autoCategorized: number;
  uncategorized: number;
  // Rows that are new vs. duplicates of an existing row, across the whole
  // file (not just the shown slice). Duplicates import only when approved.
  newCount: number;
  duplicateCount: number;
  // Rows on or after the cutover of a ledger account a bank already syncs
  // (REAL-ACCOUNTS.md): never imported, since they would count twice.
  coveredCount: number;
  coveredFrom: string | null;
  // Parsed rows for the preview table, capped server-side; rowCount holds the
  // true total so the UI can note when the list is truncated. `category` is the
  // rule-matched category name, or null if no rule matches. `index` is the
  // row's position in the full parsed file, the stable id the confirm step
  // uses to know which duplicates the user approved. `duplicate` flags a
  // collision and its kind.
  rows: {
    index: number;
    date: string;
    amountCents: number;
    descriptionRaw: string;
    accountLabel: string | null;
    category: string | null;
    duplicate: DuplicateKind | null;
    coveredByBank: boolean;
  }[];
};

export type PreviewState = {
  ok?: boolean;
  error?: string;
  preview?: ImportPreview;
};

export type ConfirmState = {
  ok?: boolean;
  error?: string;
  // `forced` counts approved duplicates that were inserted despite a
  // collision; `skipped` counts unapproved duplicates dropped as before.
  // `covered` counts rows a bank already syncs (on or after its cutover).
  result?: { inserted: number; skipped: number; forced: number; covered: number };
};

// Rename an import's display label. Bounded so a group header stays a
// header; empty is rejected (clearing the name is not a use case — delete
// the import instead).
export const IMPORT_NAME_MAX = 80;
export const renameImportSchema = z.object({
  importId: z.string().uuid(),
  displayName: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(IMPORT_NAME_MAX, 'Name is too long'),
});

export type RenameImportState = {
  error?: string;
  ok?: boolean;
};

export const personSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
});

export type PersonFormState = {
  errors?: Record<string, string>;
  ok?: boolean;
  // What a successful save did, for the page result line.
  message?: string;
};

// User-created categories. Name uniqueness is enforced by the DB (a partial
// unique index on categories.name); the action turns that conflict into a
// friendly field error. `isSplittable` mirrors the seed property: a
// non-splittable category (like Rent or Income) is hidden from the split
// editor and excluded from the insights breakdown. `countsAsSpending` false
// (like Transfers) also leaves its rows out of every spending total; such a
// category cannot be splittable (also a CHECK in the database).
export const CATEGORY_NAME_MAX = 40;

export const categorySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(CATEGORY_NAME_MAX, 'Name is too long'),
  isSplittable: z.boolean(),
  countsAsSpending: z.boolean(),
}).refine((c) => c.countsAsSpending || !c.isSplittable, {
  message: 'A category that is not spending cannot be splittable',
  path: ['isSplittable'],
});

export type CategoryFormState = {
  errors?: Record<string, string>;
  ok?: boolean;
};

// Methods enterable in the split editor. 'item' splits exist too but are
// created only through the receipt wizard, never picked here.
export const SPLIT_METHODS = ['equal', 'amount', 'percent'] as const;
export type SplitMethodInput = (typeof SPLIT_METHODS)[number];
export type SplitMethodDisplay = SplitMethodInput | 'item';

// The split editor submits one JSON payload (the participant list is
// dynamic, so flat FormData fields would be awkward). Cents are computed
// client-side for the live preview, but the Server Action re-runs the split
// engine against the stored transaction amount, so nothing here is trusted
// for money math beyond the raw inputs.
export const splitPayloadSchema = z.object({
  transactionId: z.string().uuid(),
  method: z.enum(SPLIT_METHODS),
  taxCents: z.number().int().min(0),
  tipCents: z.number().int().min(0),
  participants: z
    .array(
      z.object({
        personId: z.string().uuid(),
        inputAmountCents: z.number().int().min(0).nullable(),
        inputPercent: z.number().int().min(0).max(100).nullable(),
      }),
    )
    .min(1, 'Pick at least one participant'),
});

export type SplitPayload = z.infer<typeof splitPayloadSchema>;

export type SplitFormState = {
  error?: string;
  ok?: boolean;
  // What a successful save did, for the page result line.
  message?: string;
};

// Receipt uploads: JPG/PNG only, 10MB cap (fork 7). Checked client-side
// for fast feedback and re-checked in the Server Action.
export const RECEIPT_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024;
// A receipt can be several photos/screenshots of one order; cap the count so
// a single extraction request stays within the model's size/token budget.
export const RECEIPT_MAX_IMAGES = 6;

export type UploadReceiptState = {
  ok?: boolean;
  error?: string;
  // Set when the image stored fine but extraction failed: the wizard shows
  // the message with retry / manual-entry choices instead of a dead end.
  extractionFailed?: string;
  receiptId?: string;
  extractLatencyMs?: number;
  usage?: { promptTokens: number; outputTokens: number; totalTokens: number } | null;
};

// Review-step save payload. Items are dynamic, so the wizard submits one
// JSON field; cents are parsed client-side for the live math but the
// server re-validates shape and bounds here.
export const receiptReviewSchema = z.object({
  receiptId: z.string().uuid(),
  transactionId: z.string().uuid(),
  merchant: z.string().trim().max(120),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
    .nullable(),
  subtotalCents: z.number().int().min(0),
  taxCents: z.number().int().min(0),
  tipCents: z.number().int().min(0),
  totalCents: z.number().int().min(0),
  mismatchNote: z.string().trim().max(200).nullable(),
  items: z
    .array(
      z.object({
        description: z.string().trim().min(1, 'Item description is required'),
        quantity: z.number().positive(),
        amountCents: z.number().int().min(0),
      }),
    )
    .min(1, 'Add at least one item'),
});

export type ReceiptReviewPayload = z.infer<typeof receiptReviewSchema>;

export type ReceiptReviewState = {
  ok?: boolean;
  error?: string;
};

// Assignment-step save payload: every receipt item with its (possibly
// empty) assignee list. Shares are re-derived server-side from the stored
// receipt, never trusted from the client.
export const itemSplitSchema = z.object({
  transactionId: z.string().uuid(),
  receiptId: z.string().uuid(),
  assignments: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        personIds: z.array(z.string().uuid()),
      }),
    )
    .min(1),
});

export type ItemSplitPayload = z.infer<typeof itemSplitSchema>;

export type ItemSplitState = {
  ok?: boolean;
  error?: string;
  // What a successful save did, for the page result line.
  message?: string;
};

// Direction of a settlement, chosen on the record form and locked after
// creation. 'incoming' = they paid me; 'outgoing' = I paid them.
export const SETTLEMENT_DIRECTIONS = ['incoming', 'outgoing'] as const;
export type SettlementDirection = (typeof SETTLEMENT_DIRECTIONS)[number];

// A settlement is a positive payment; `direction` says which way it moves
// (they paid me vs. I paid them) and the balance formula reads the direction,
// not the sign. Direction defaults to 'incoming' and is locked after save.
export const settlementSchema = z.object({
  personId: z.string().uuid(),
  direction: z.enum(SETTLEMENT_DIRECTIONS).default('incoming'),
  amount: z.string().refine((v) => {
    const cents = tryParseDollars(v);
    return cents !== null && cents > 0;
  }, 'Enter a positive dollar amount'),
  date: z.string().min(1, 'Date is required'),
  note: z
    .string()
    .trim()
    .max(200, 'Keep the note under 200 characters')
    .transform((v) => (v.length === 0 ? null : v)),
});

// Advanced mode: an explicit per-share allocation of a settlement, overriding
// the default FIFO. Amounts are clamped to each share's outstanding balance
// server-side; anything left over becomes unallocated credit.
export const settlementAllocationsInputSchema = z.array(
  z.object({
    shareId: z.string().uuid(),
    amountCents: z.number().int().min(0),
  }),
);

// The share picker's submit: one payment, possibly netted against what the
// owner owes, recorded as a settlement group. `cash` is the payment the user
// typed; empty means "follow the net". `replaceId` names a settlement being
// edited — it and its group are replaced in the same transaction.
export const settlementGroupSchema = z.object({
  personId: z.string().uuid(),
  date: z.string().min(1, 'Date is required'),
  note: z
    .string()
    .trim()
    .max(200, 'Keep the note under 200 characters')
    .transform((v) => (v.length === 0 ? null : v)),
  cash: z
    .string()
    .trim()
    .refine((v) => {
      if (v === '') return true;
      const cents = tryParseDollars(v);
      return cents !== null && cents >= 0;
    }, 'Enter a dollar amount'),
  fallbackDirection: z.enum(SETTLEMENT_DIRECTIONS).default('incoming'),
  incoming: settlementAllocationsInputSchema,
  outgoing: settlementAllocationsInputSchema,
  replaceId: z.string().uuid().nullable(),
});

export type SettlementFormState = {
  errors?: Record<string, string>;
  ok?: boolean;
  // What a successful save did, for the page result line.
  message?: string;
};

// External expense ("Log expense you paid"): an expense someone else paid that
// the owner owes a share of. `payerPersonId` must be a non-owner person — the
// owner cannot be the external payer (fork 10). That rule needs the runtime
// owner id, so it is enforced in the Server Action; the schema validates shape
// and bounds only.
export const EXTERNAL_EXPENSE_DESC_MAX = 120;
export const externalExpenseSchema = z.object({
  payerPersonId: z.string().uuid(),
  amount: z.string().refine((v) => {
    const cents = tryParseDollars(v);
    return cents !== null && cents > 0;
  }, 'Enter a positive dollar amount'),
  date: z.string().min(1, 'Date is required'),
  description: z
    .string()
    .trim()
    .min(1, 'Description is required')
    .max(EXTERNAL_EXPENSE_DESC_MAX, 'Keep the description short'),
});

export type ExternalExpenseFormState = {
  errors?: Record<string, string>;
  ok?: boolean;
  // What a successful save did, for the page result line.
  message?: string;
};

export const MATCH_TYPES = ['substring', 'regex'] as const;

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

export const ruleSchema = z
  .object({
    matchPattern: z.string().trim().min(1, 'Pattern is required'),
    matchType: z.enum(MATCH_TYPES),
    categoryId: z.string().uuid('Choose a category'),
    priority: z.coerce
      .number()
      .int('Priority must be a whole number')
      .min(0, 'Priority must be 0 or more'),
  })
  .refine((d) => d.matchType !== 'regex' || isValidRegex(d.matchPattern), {
    message: 'Invalid regular expression',
    path: ['matchPattern'],
  });

export type RuleInput = z.infer<typeof ruleSchema>;

export type RuleFormState = {
  errors?: Record<string, string>;
  ok?: boolean;
  // What a successful save did, for the page result line.
  message?: string;
};

export type ApplyRulesState = {
  ok?: boolean;
  result?: { matched: number; unmatched: number; skippedManual: number };
};

// ---- Share links ----

// A share link is a snapshot, so the payload is the rendered display text
// rather than ids: nothing in it addresses another row, and the page needs
// no further reads. Validated here because the lines arrive from the client
// (which holds the sort order the user is looking at) rather than being
// re-derived server-side.
export const SHARE_LINE_DESC_MAX = 200;
export const SHARE_LINES_MAX = 500;

export const shareLineSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  description: z.string().max(SHARE_LINE_DESC_MAX),
  outstandingCents: z.number().int(),
  category: z.string().max(120).nullable(),
});

// Both directions travel together: a snapshot showing only what someone
// owes, while omitting what they are owed back, overstates the debt.
export const shareLinkSchema = z
  .object({
    personName: z.string().min(1).max(120),
    groupedByCategory: z.boolean(),
    owed: z.array(shareLineSchema).max(SHARE_LINES_MAX),
    owing: z.array(shareLineSchema).max(SHARE_LINES_MAX),
  })
  .refine((v) => v.owed.length + v.owing.length > 0, {
    message: 'Nothing outstanding to share',
  });

export type ShareLinkInput = z.infer<typeof shareLinkSchema>;
