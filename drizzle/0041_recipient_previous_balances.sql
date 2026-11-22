ALTER TABLE "settlement_allocations" ADD COLUMN "picked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "previous_balances" jsonb;