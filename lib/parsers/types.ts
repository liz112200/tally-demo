import { z } from 'zod';

// Banks that can be imported. Excludes 'manual' (the transactions.source enum
// superset lives in db/schema.ts); an import always attributes to a real bank.
export const IMPORT_SOURCES = ['chase', 'discover', 'amex'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

// The canonical shape every parser emits and the single validation gate every
// imported row passes before it reaches insertTransaction. Money stays integer
// cents (positive spending, negative credit) — no floats cross this boundary.
export const parsedTransactionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be ISO YYYY-MM-DD'),
  amountCents: z.number().int('Amount must be integer cents'),
  descriptionRaw: z.string().trim().min(1, 'Description is required'),
  source: z.enum(IMPORT_SOURCES),
  accountLabel: z.string().trim().min(1).nullable(),
});

export type ParsedTransaction = z.infer<typeof parsedTransactionSchema>;

// A bank parser is defined by its exact expected header (the tokenized first
// row detect() routes on) and a function turning tokenized data rows into
// canonical rows. Both sides consume parseCsv() output, so the header is
// normalized identically to the data. No Next/Drizzle/DB imports here.
export interface BankParser {
  readonly bank: ImportSource;
  // Expected header fields, compared element-wise against parseCsv(file)[0].
  readonly header: readonly string[];
  // Parses the data rows (header already removed). The caller re-validates each
  // returned row through parsedTransactionSchema.
  parseRows(dataRows: readonly string[][]): ParsedTransaction[];
}
