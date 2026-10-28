ALTER TABLE "imports" ADD COLUMN "display_name" text;--> statement-breakpoint
-- Backfill display names. Synthetic backfill imports (filename IS NULL) get
-- "<Source> (backfilled)"; real uploads get "<Source> <MM/DD> – <MM/DD>"
-- from the min/max transaction date in the batch. Real imports whose rows
-- were all deleted keep display_name NULL and fall back to filename.
UPDATE "imports"
SET "display_name" = initcap("source"::text) || ' (backfilled)'
WHERE "filename" IS NULL;--> statement-breakpoint
UPDATE "imports" i
SET "display_name" =
  initcap(i."source"::text) || ' ' ||
  to_char(dr.min_date, 'MM/DD') || ' – ' || to_char(dr.max_date, 'MM/DD')
FROM (
  SELECT "import_id", min("date") AS min_date, max("date") AS max_date
  FROM "transactions"
  WHERE "import_id" IS NOT NULL
  GROUP BY "import_id"
) dr
WHERE i."filename" IS NOT NULL AND dr."import_id" = i."id";