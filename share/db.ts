import { and, eq, isNull } from 'drizzle-orm';
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

export type SnapshotLine = {
  date: string;
  description: string;
  outstandingCents: number;
  category: string | null;
};

export type Snapshot = {
  personName: string;
  groupedByCategory: boolean;
  createdAt: Date;
  owedCents: number;
  owed: SnapshotLine[];
  owingCents: number;
  owing: SnapshotLine[];
  netCents: number;
};

// A revoked link reads as missing, so the page treats null as "not found"
// without a second case.
export async function getSnapshot(token: string): Promise<Snapshot | null> {
  const [row] = await db
    .select()
    .from(shareLinks)
    .where(and(eq(shareLinks.token, token), isNull(shareLinks.revokedAt)));
  if (!row) return null;
  return {
    personName: row.personName,
    groupedByCategory: row.groupedByCategory,
    createdAt: row.createdAt,
    owedCents: row.totalCents,
    owed: row.lines as SnapshotLine[],
    owingCents: row.owingCents,
    owing: row.owingLines as SnapshotLine[],
    netCents: row.totalCents - row.owingCents,
  };
}
