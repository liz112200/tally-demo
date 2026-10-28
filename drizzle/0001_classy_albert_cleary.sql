ALTER TABLE "transactions" ADD COLUMN "account_label" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "dedup_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_dedup_hash_unique" ON "transactions" USING btree ("dedup_hash") WHERE "transactions"."dedup_hash" is not null;