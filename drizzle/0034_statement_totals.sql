-- Statement totals (STATEMENT-CYCLES.md, the period view): two nullable
-- columns. Then it MODIFIES existing ledger_statements rows: those a passed
-- statement check recorded get that check's two figures in the new columns
-- (their dates are untouched). No other table is written.
ALTER TABLE "ledger_statements" ADD COLUMN "charges_cents" bigint;--> statement-breakpoint
ALTER TABLE "ledger_statements" ADD COLUMN "credits_cents" bigint;--> statement-breakpoint
ALTER TABLE "ledger_statements" ADD CONSTRAINT "ledger_statements_totals" CHECK (("ledger_statements"."charges_cents" is null or "ledger_statements"."charges_cents" >= 0) and ("ledger_statements"."credits_cents" is null or "ledger_statements"."credits_cents" >= 0));--> statement-breakpoint
UPDATE "ledger_statements" s
SET "charges_cents" = (b."verification"->'statement'->>'chargesCents')::bigint,
    "credits_cents" = (b."verification"->'statement'->>'creditsCents')::bigint
FROM "bank_accounts" b
WHERE b."ledger_account_id" = s."ledger_account_id"
  AND s."source" = 'verification'
  AND b."verification"->>'outcome' = 'pass'
  AND (b."verification"->'statement'->>'to')::date = s."closing_date"
  AND b."verification"->'statement'->>'chargesCents' IS NOT NULL;