DROP INDEX "transactions_dedup_hash_unique";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "dedup_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_dedup_hash_unique" ON "transactions" USING btree ("dedup_hash") WHERE "transactions"."dedup_hash" is not null and "transactions"."dedup_exempt" = false;