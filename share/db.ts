import { readBillDesign } from '@shared/bill-design';
import { availablePreviousBalances, type BillSnapshot, type PreviousBalance, type ShareSnapshotLine } from '@shared/bill-snapshot';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// This app deliberately declares only share_links, not the app's full schema.
// It is the public face of a private ledger, so the isolation is the point:
// there is no table definition here for transactions, splits, or people, and
// no query that could reach them. The columns mirror db/schema.ts in the
// parent app; migrations are owned there and never run from this project.
const shareLinks = pgTable('share_links', {
  id: uuid('id').primaryKey(),
  previousBalances: jsonb('previous_balances').$type<PreviousBalance[]>(),
  paper: text('paper').notNull().default('classic'),
  token: text('token').notNull(),
  personName: text('person_name').notNull(),
  totalCents: integer('total_cents').notNull(),
  lines: jsonb('lines').notNull(),
  owingCents: integer('owing_cents').notNull(),
  owingLines: jsonb('owing_lines').notNull(),
  groupedByCategory: boolean('grouped_by_category').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set');

// prepare: false is required behind Neon's pooled endpoint.
const db = drizzle(postgres(connectionString, { prepare: false }));

// A revoked link reads as missing, so the page treats null as "not found"
// without a second case.
export async function getSnapshot(token: string): Promise<BillSnapshot | null> {
  const [row] = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.token, token), isNull(shareLinks.revokedAt)));
  if (!row) return null;
  const previousBalances = await availablePreviousBalances(row.previousBalances, tokens =>
    db.select({ token: shareLinks.token }).from(shareLinks)
      .where(and(inArray(shareLinks.token, tokens), isNull(shareLinks.revokedAt))));
  const publicLines = (lines: ShareSnapshotLine[]) => previousBalances?.length ? lines.filter(line => !line.carried) : lines;
  return {
    previousBalances,
    paper: readBillDesign(row.paper),
    personName: row.personName,
    groupedByCategory: row.groupedByCategory,
    createdAt: row.createdAt,
    owedCents: row.totalCents,
    owed: publicLines(row.lines as ShareSnapshotLine[]),
    owingCents: row.owingCents,
    owing: publicLines(row.owingLines as ShareSnapshotLine[]),
    netCents: row.totalCents - row.owingCents,
  };
}
