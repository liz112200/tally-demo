-- Statements as the bank issued them (STATEMENT-CYCLES.md). A new table,
-- filled from each passed statement check already recorded (one per bank
-- account: its period's first and last day). Reads bank_accounts; writes no
-- existing row.
CREATE TABLE "ledger_statements" (
	"ledger_account_id" uuid NOT NULL,
	"closing_date" date NOT NULL,
	"period_start" date,
	"next_closing_date" date,
	"starts_new_cycle" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_statements_ledger_account_id_closing_date_pk" PRIMARY KEY("ledger_account_id","closing_date"),
	CONSTRAINT "ledger_statements_source" CHECK ("ledger_statements"."source" in ('verification', 'owner')),
	CONSTRAINT "ledger_statements_period" CHECK ("ledger_statements"."period_start" is null or "ledger_statements"."period_start" <= "ledger_statements"."closing_date"),
	CONSTRAINT "ledger_statements_next" CHECK ("ledger_statements"."next_closing_date" is null or "ledger_statements"."next_closing_date" > "ledger_statements"."closing_date")
);
--> statement-breakpoint
ALTER TABLE "ledger_statements" ADD CONSTRAINT "ledger_statements_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
INSERT INTO "ledger_statements" ("ledger_account_id", "closing_date", "period_start", "source")
SELECT b."ledger_account_id", (b."verification"->'statement'->>'to')::date, (b."verification"->'statement'->>'from')::date, 'verification'
FROM "bank_accounts" b
WHERE b."ledger_account_id" IS NOT NULL
  AND b."verified_at" IS NOT NULL
  AND b."verification"->>'outcome' = 'pass'
  AND b."verification"->'statement'->>'to' IS NOT NULL
ON CONFLICT DO NOTHING;