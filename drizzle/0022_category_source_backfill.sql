-- Rows given a category before category_source existed (phase 1 manual
-- entries) carry a category and a NULL source, which reads as "never
-- categorized": a future rule matching them would overwrite the owner's
-- choice. Every such category was set by hand (rules did not exist yet), so
-- it is recorded as manual. Hand-written; must run before the CHECK below.
UPDATE "transactions" SET "category_source" = 'manual'
WHERE "category_id" IS NOT NULL AND "category_source" IS NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_has_source" CHECK ("transactions"."category_id" is null or "transactions"."category_source" is not null);
