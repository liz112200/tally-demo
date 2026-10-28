ALTER TYPE "public"."transaction_source" ADD VALUE 'plaid';--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "dedup_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "sync_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "sync_cursor" text;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "provider_transaction_id" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "provider_raw" jsonb;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_provider_unique" ON "transactions" USING btree ("bank_account_id","provider_transaction_id") WHERE "transactions"."provider_transaction_id" is not null;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_sync_expense_types" CHECK (not "bank_accounts"."sync_enabled" or "bank_accounts"."type" in ('depository', 'credit'));--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_one_identity" CHECK (("transactions"."dedup_hash" is not null and "transactions"."provider_transaction_id" is null and "transactions"."bank_account_id" is null)
        or ("transactions"."dedup_hash" is null and "transactions"."provider_transaction_id" is not null and "transactions"."bank_account_id" is not null));