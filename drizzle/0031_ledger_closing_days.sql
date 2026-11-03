-- Statement closing days per ledger account (STATEMENT-CYCLES.md): set by the
-- owner, one row per change. A new table; writes no existing row.
CREATE TABLE "ledger_closing_days" (
	"ledger_account_id" uuid NOT NULL,
	"effective_from" date NOT NULL,
	"closing_day" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_closing_days_ledger_account_id_effective_from_pk" PRIMARY KEY("ledger_account_id","effective_from"),
	CONSTRAINT "ledger_closing_days_day" CHECK ("ledger_closing_days"."closing_day" between 1 and 31)
);
--> statement-breakpoint
ALTER TABLE "ledger_closing_days" ADD CONSTRAINT "ledger_closing_days_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE cascade ON UPDATE no action;