-- Reviews, point-out rules and closed accounts (ACCOUNTS-BOARD.md). Two new
-- append-only tables and two columns. It writes one value into existing
-- rows: every categorization rule gets mode 'apply', which is what each
-- already does; no rule changes behaviour. ledger_accounts.closed_on starts
-- NULL on every account. No transaction, split, share, settlement or
-- allocation is written.
CREATE TABLE "raised_row_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"note" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raised_row_reviews_note" CHECK (length(trim("raised_row_reviews"."note")) > 0)
);
--> statement-breakpoint
CREATE TABLE "statement_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"closing_date" date NOT NULL,
	"charges_diff_cents" bigint NOT NULL,
	"credits_diff_cents" bigint NOT NULL,
	"note" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_reviews_note" CHECK (length(trim("statement_reviews"."note")) > 0),
	CONSTRAINT "statement_reviews_differs" CHECK ("statement_reviews"."charges_diff_cents" <> 0 or "statement_reviews"."credits_diff_cents" <> 0)
);
--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD COLUMN "mode" text DEFAULT 'apply' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD COLUMN "closed_on" date;--> statement-breakpoint
ALTER TABLE "raised_row_reviews" ADD CONSTRAINT "raised_row_reviews_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_reviews" ADD CONSTRAINT "statement_reviews_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "raised_row_reviews_transaction" ON "raised_row_reviews" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "statement_reviews_statement" ON "statement_reviews" USING btree ("ledger_account_id","closing_date");--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_mode" CHECK ("categorization_rules"."mode" in ('apply', 'point_out'));