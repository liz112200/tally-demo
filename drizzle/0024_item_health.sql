-- Slice 4 of bank sync (BANK-SYNC.md): Item health. A connection's status
-- (active, paused, or removed by a deliberate disconnect, which erases its
-- token), the Item's health as Plaid last reported it, and accounts the
-- provider no longer returns. Existing connections become active with their
-- tokens, which satisfies the removed-state CHECK; rows are still never
-- deleted (trigger, migration 0019).
CREATE TYPE "public"."bank_connection_status" AS ENUM('active', 'paused', 'removed');--> statement-breakpoint
ALTER TABLE "bank_connections" ALTER COLUMN "access_token_sealed" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "unshared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "status" "bank_connection_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "item_error_code" text;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "consent_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "health_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_sync_shared_only" CHECK (not "bank_accounts"."sync_enabled" or "bank_accounts"."unshared_at" is null);--> statement-breakpoint
ALTER TABLE "bank_connections" ADD CONSTRAINT "bank_connections_removed_state" CHECK (("bank_connections"."status" = 'removed') = ("bank_connections"."access_token_sealed" is null)
        and ("bank_connections"."status" = 'removed') = ("bank_connections"."removed_at" is not null));