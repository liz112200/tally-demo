CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "transaction_source" NOT NULL,
	"filename" text,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_count" integer NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill: one synthetic import per existing bank source ("Backfilled
-- Chase" etc. — identified by filename IS NULL), imported_at = migration
-- time, row_count = actual row count including soft-deleted transactions.
-- Manual entries stay import_id NULL.
INSERT INTO "imports" ("source", "filename", "row_count")
SELECT "source", null, count(*)::int
FROM "transactions"
WHERE "source" <> 'manual'
GROUP BY "source";--> statement-breakpoint
UPDATE "transactions" t
SET "import_id" = i."id"
FROM "imports" i
WHERE i."filename" IS NULL
  AND t."source" = i."source"
  AND t."source" <> 'manual'
  AND t."import_id" IS NULL;