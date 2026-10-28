-- Which rows an import's Undo deleted, recorded on the rows (ACTION-RESULTS.md).
-- Until now Restore found them as the rows whose deleted_at equals the
-- import's, which failed twice: comparing through a JS Date lost microseconds,
-- and a second Undo re-stamped the import so nothing matched. The backfill
-- makes that inference one last time, inside Postgres where the timestamps
-- compare exactly, for imports undone today; nothing reads it afterwards.
ALTER TABLE "transactions" ADD COLUMN "deleted_by_undo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "transactions" t SET "deleted_by_undo" = true
FROM "imports" i
WHERE i."deleted_at" IS NOT NULL AND t."import_id" = i."id" AND t."deleted_at" = i."deleted_at";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_undo_marks_deleted_import_rows" CHECK (not "transactions"."deleted_by_undo" or ("transactions"."deleted_at" is not null and "transactions"."import_id" is not null));
