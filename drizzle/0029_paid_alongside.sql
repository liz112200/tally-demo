-- Paid alongside (PAID-ALONGSIDE.md): a manual row the owner paid off-card
-- next to another transaction links to it. Context only; manual rows only.
-- Adds a nullable column and two constraints; writes no existing row.
ALTER TABLE "transactions" ADD COLUMN "alongside_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_alongside_transaction_id_transactions_id_fk" FOREIGN KEY ("alongside_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_alongside_is_manual" CHECK ("transactions"."alongside_transaction_id" is null or "transactions"."source" = 'manual');