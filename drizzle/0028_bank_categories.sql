-- Bank categories (BANK-SYNC.md, "Bank categories"). A synced row the
-- owner's rules leave uncategorized takes the owner's category for the bank's
-- own category, recorded as category_source 'bank': visible as the bank's on
-- the row, overwritten by any rule, never written over a manual or rule
-- category. The mapping starts as the owner approved it (2026-10-28), by
-- category name, only where that category exists and counts as spending;
-- nothing maps to Transfers.
--
-- Writes to existing rows: merchant_normalized only, on rows whose derived
-- merchant starts with Plaid's Apple Pay prefix "APLPAY ", which the
-- normalizer now strips (the same function applied to the same description).
-- No amount, date, description, category, split or settlement is written.
ALTER TYPE "public"."category_source" ADD VALUE 'bank';--> statement-breakpoint
CREATE TABLE "bank_category_map" (
	"plaid_category" text PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_category_map" ADD CONSTRAINT "bank_category_map_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "bank_category_map" ("plaid_category", "category_id")
SELECT m.plaid_category, c.id
FROM (VALUES
  ('FOOD_AND_DRINK', 'Dining'),
  ('GENERAL_MERCHANDISE', 'Shopping'),
  ('TRANSPORTATION', 'Transport'),
  ('TRAVEL', 'Travel'),
  ('ENTERTAINMENT', 'Entertainment')
) AS m(plaid_category, category_name)
JOIN "categories" c ON c."name" = m.category_name AND c."counts_as_spending";--> statement-breakpoint
UPDATE "transactions" SET "merchant_normalized" = substr("merchant_normalized", 8)
WHERE "merchant_normalized" LIKE 'APLPAY %';
