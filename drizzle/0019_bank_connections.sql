CREATE TYPE "public"."bank_provider" AS ENUM('plaid');--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_account_id" text NOT NULL,
	"persistent_account_id" text,
	"name" text NOT NULL,
	"official_name" text,
	"mask" text,
	"type" text NOT NULL,
	"subtype" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "bank_provider" NOT NULL,
	"provider_item_id" text NOT NULL,
	"institution_id" text,
	"institution_name" text,
	"access_token_sealed" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_connection_id_bank_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."bank_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_connection_account_unique" ON "bank_accounts" USING btree ("connection_id","provider_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_connections_provider_item_unique" ON "bank_connections" USING btree ("provider","provider_item_id");--> statement-breakpoint
-- Connections are never hard-deleted: each one is a spent slot of Plaid's
-- Trial Item budget, and these rows are its ledger (CLAUDE.md). Hand-written;
-- drizzle-kit does not model triggers.
CREATE FUNCTION "bank_connections_refuse_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'bank_connections rows are never deleted (Plaid Item budget ledger)';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "bank_connections_no_delete"
BEFORE DELETE ON "bank_connections"
FOR EACH ROW EXECUTE FUNCTION "bank_connections_refuse_delete"();
