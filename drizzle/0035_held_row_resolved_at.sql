-- When a held possible duplicate was answered: one nullable column, and a
-- CHECK that an answer and its time come together. No row is written; it
-- holds as added because no held row has been answered (2026-11-04).
ALTER TABLE "sync_skipped_rows" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_skipped_rows" ADD CONSTRAINT "sync_skipped_rows_resolved_at" CHECK (("sync_skipped_rows"."resolution" is null) = ("sync_skipped_rows"."resolved_at" is null));