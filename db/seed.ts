import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import { categories, categorizationRules, persons } from './schema';

config({ path: '.env.local' });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

// Standalone script with its own short-lived connection that it opens and
// closes, so it does not import the server-only app singleton in db/index.ts.
const STARTER_CATEGORIES = [
  'Groceries',
  'Dining',
  'Transport',
  'Utilities',
  'Entertainment',
  'Shopping',
  'Health',
  'Travel',
  'Other',
  // Added in phase 3 for later phases (not rule-matched yet).
  'Income',
  'Rent',
];

// Seed categorization rules, keyed by category name (resolved to ids below).
// Grounded in the bank exports (tests/fixtures). Deliberately no
// rules for payroll, rent, Zelle, or transfer rows — those stay uncategorized
// for a later not-splittable filter. Income/Rent categories are intentionally
// unused here.
type SeedRule = {
  matchPattern: string;
  matchType: 'substring' | 'regex';
  category: string;
  priority: number;
};

const SEED_RULES: SeedRule[] = [
  { matchPattern: 'UBER|LYFT', matchType: 'regex', category: 'Transport', priority: 100 },
  { matchPattern: 'MARATHON', matchType: 'substring', category: 'Transport', priority: 100 },
  { matchPattern: 'HERTZ', matchType: 'substring', category: 'Travel', priority: 100 },
  { matchPattern: 'AMAZON', matchType: 'substring', category: 'Shopping', priority: 100 },
  { matchPattern: 'WALMART', matchType: 'substring', category: 'Shopping', priority: 100 },
  { matchPattern: 'WEEE', matchType: 'substring', category: 'Groceries', priority: 100 },
  { matchPattern: 'TST*', matchType: 'substring', category: 'Dining', priority: 100 },
];

async function main() {
  const client = postgres(connectionString!, { prepare: false });
  const db = drizzle(client);

  const insertedCats = await db
    .insert(categories)
    .values(STARTER_CATEGORIES.map((name) => ({ name })))
    .onConflictDoNothing({ target: categories.name })
    .returning({ name: categories.name });

  // Resolve category ids for the rule seeds.
  const ruleCategoryNames = [...new Set(SEED_RULES.map((r) => r.category))];
  const rows = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(inArray(categories.name, ruleCategoryNames));
  const idByName = new Map(rows.map((r) => [r.name, r.id]));

  const insertedRules = await db
    .insert(categorizationRules)
    .values(
      SEED_RULES.map((r) => ({
        matchPattern: r.matchPattern,
        matchType: r.matchType,
        categoryId: idByName.get(r.category)!,
        priority: r.priority,
      })),
    )
    .onConflictDoNothing({
      target: [categorizationRules.matchPattern, categorizationRules.matchType],
    })
    .returning({ pattern: categorizationRules.matchPattern });

  // Rent and Income never make sense to split; everything else stays
  // splittable (the column defaults to true).
  const nonSplittable = await db
    .update(categories)
    .set({ isSplittable: false })
    .where(inArray(categories.name, ['Rent', 'Income']))
    .returning({ name: categories.name });

  // The owner Person. The partial unique index on is_owner makes a second
  // owner row impossible, but check first so re-seeding stays a clean no-op
  // instead of a conflict error.
  const ownerName = process.env.NEXT_PUBLIC_OWNER_NAME ?? 'Me';
  const existingOwner = await db
    .select({ id: persons.id, name: persons.name })
    .from(persons)
    .where(eq(persons.isOwner, true));
  if (existingOwner.length === 0) {
    await db.insert(persons).values({ name: ownerName, isOwner: true });
    console.log(`Seeded owner person "${ownerName}".`);
  } else {
    console.log(`Owner person already present ("${existingOwner[0].name}").`);
  }

  await client.end();
  console.log(
    `Marked ${nonSplittable.map((c) => c.name).join(', ') || 'no categories'} not splittable.`,
  );
  console.log(
    `Seeded ${insertedCats.length} categories ` +
      `(skipped ${STARTER_CATEGORIES.length - insertedCats.length} already present).`,
  );
  console.log(
    `Seeded ${insertedRules.length} rules ` +
      `(skipped ${SEED_RULES.length - insertedRules.length} already present).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
