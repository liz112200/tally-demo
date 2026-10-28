ALTER TABLE "categories" ADD COLUMN "counts_as_spending" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_splittable_counts_as_spending" CHECK ("categories"."counts_as_spending" or not "categories"."is_splittable");--> statement-breakpoint
-- Hand-written below (drizzle-kit models neither seed rows nor triggers).
-- Money moving between the owner's own accounts: neither spending nor
-- splittable. Left alone if a category of that name already exists.
INSERT INTO "categories" ("name", "is_splittable", "counts_as_spending")
VALUES ('Transfers', false, false)
ON CONFLICT ("name") DO NOTHING;--> statement-breakpoint
-- Deleting a non-spending category while rows reference it would set their
-- category to NULL (on delete set null), and uncategorized rows count as
-- spending: the double count this category exists to remove would quietly
-- come back. Refused instead; recategorize the rows first.
CREATE FUNCTION "categories_refuse_delete_in_use_non_spending"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT OLD.counts_as_spending AND EXISTS (
    SELECT 1 FROM "transactions" WHERE "category_id" = OLD.id
  ) THEN
    RAISE EXCEPTION 'category "%" is not counted as spending and still has transactions; recategorize them before deleting it', OLD.name;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "categories_no_delete_in_use_non_spending"
BEFORE DELETE ON "categories"
FOR EACH ROW EXECUTE FUNCTION "categories_refuse_delete_in_use_non_spending"();
