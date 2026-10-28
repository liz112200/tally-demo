-- Bank sync slice 7 (REAL-ACCOUNTS.md): ledger accounts, the cutover that
-- keeps a purchase from arriving from both a CSV and a bank, sign
-- verification, synced rows not inserted (before the cutover, or held as a
-- possible duplicate of a CSV row), and re-issued account ids. No
-- transactions row is written. CSV imports are mapped onto ledger accounts
-- separately (db/ledger-backfill.ts), with the owner naming them.
CREATE TYPE "public"."ledger_cutover_basis" AS ENUM('posted', 'transaction');--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"csv_source" "transaction_source",
	"csv_account_label" text,
	"cutover_basis" "ledger_cutover_basis" DEFAULT 'transaction' NOT NULL,
	"cutover_date" date,
	"cutover_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_skipped_rows" (
	"bank_account_id" uuid NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"date" date NOT NULL,
	"posted_date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description_raw" text NOT NULL,
	"pending" boolean NOT NULL,
	"reason" text NOT NULL,
	"resolution" text,
	"provider_raw" jsonb NOT NULL,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_skipped_rows_bank_account_id_provider_transaction_id_pk" PRIMARY KEY("bank_account_id","provider_transaction_id"),
	CONSTRAINT "sync_skipped_rows_reason" CHECK ("sync_skipped_rows"."reason" in ('before_cutover', 'possible_duplicate')),
	CONSTRAINT "sync_skipped_rows_resolution" CHECK ("sync_skipped_rows"."resolution" is null or ("sync_skipped_rows"."reason" = 'possible_duplicate' and "sync_skipped_rows"."resolution" in ('same', 'released')))
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "ledger_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "verification" jsonb;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "boundary_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "replaces_account_id" uuid;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "ledger_account_id" uuid;--> statement-breakpoint
-- Plaid accounts that synced before this slice (Sandbox ones on dev;
-- production has none) each get a ledger account of their own with no CSV
-- history: confirmed, no cutover, full history, as they synced until now.
-- Accounts that never synced stay unmapped, and are set up like new ones.
INSERT INTO "ledger_accounts" ("id", "display_name", "cutover_confirmed_at")
SELECT b."id", b."name" || coalesce(' ••' || b."mask", ''), now() FROM "bank_accounts" b
WHERE b."sync_enabled" OR exists (select 1 from "transactions" t where t."bank_account_id" = b."id");--> statement-breakpoint
UPDATE "bank_accounts" SET "ledger_account_id" = "id" WHERE "id" IN (SELECT "id" FROM "ledger_accounts");--> statement-breakpoint
ALTER TABLE "sync_skipped_rows" ADD CONSTRAINT "sync_skipped_rows_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_csv_unique" ON "ledger_accounts" USING btree ("csv_source",coalesce("csv_account_label", '')) WHERE "ledger_accounts"."csv_source" is not null;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_replaces_account_id_bank_accounts_id_fk" FOREIGN KEY ("replaces_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_one_syncing_per_ledger" ON "bank_accounts" USING btree ("ledger_account_id") WHERE "bank_accounts"."sync_enabled";--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_sync_needs_ledger" CHECK (not "bank_accounts"."sync_enabled" or "bank_accounts"."ledger_account_id" is not null);