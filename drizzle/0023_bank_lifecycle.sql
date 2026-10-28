-- Slice 3 of bank sync (BANK-SYNC.md): pending rows, and the two flags sync
-- sets instead of touching anything the owner built on. All three columns
-- belong to synced rows only. Existing rows get pending = false and no flags,
-- which is what they are: every stored synced row so far is posted.
ALTER TABLE "transactions" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "bank_amount_before_cents" bigint;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "removed_by_bank_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bank_state_synced_only" CHECK ("transactions"."provider_transaction_id" is not null
        or (not "transactions"."pending" and "transactions"."bank_amount_before_cents" is null and "transactions"."removed_by_bank_at" is null));