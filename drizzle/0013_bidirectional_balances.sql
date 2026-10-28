CREATE TYPE "public"."settlement_direction" AS ENUM('incoming', 'outgoing');--> statement-breakpoint
CREATE TABLE "settlement_allocations" (
	"settlement_id" uuid NOT NULL,
	"split_share_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_allocations_settlement_id_split_share_id_pk" PRIMARY KEY("settlement_id","split_share_id")
);
--> statement-breakpoint
ALTER TABLE "splits" ALTER COLUMN "transaction_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "direction" "settlement_direction" DEFAULT 'incoming' NOT NULL;--> statement-breakpoint
-- payer_person_id is NOT NULL, but existing splits predate the column, so add
-- it nullable, backfill every existing (owner-paid) split to the owner Person,
-- then tighten to NOT NULL. On a fresh DB there are no splits (and possibly no
-- owner yet), so the UPDATE touches nothing and SET NOT NULL still succeeds.
ALTER TABLE "splits" ADD COLUMN "payer_person_id" uuid;--> statement-breakpoint
UPDATE "splits"
SET "payer_person_id" = (SELECT "id" FROM "persons" WHERE "is_owner" = true LIMIT 1)
WHERE "payer_person_id" IS NULL;--> statement-breakpoint
ALTER TABLE "splits" ALTER COLUMN "payer_person_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_settlement_id_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_allocations" ADD CONSTRAINT "settlement_allocations_split_share_id_split_shares_id_fk" FOREIGN KEY ("split_share_id") REFERENCES "public"."split_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "splits" ADD CONSTRAINT "splits_payer_person_id_persons_id_fk" FOREIGN KEY ("payer_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- FIFO backfill of existing settlements (all now direction='incoming') against
-- existing owner-paid shares, per person, ordered by transaction date. This is
-- the interval-intersection form of FIFO: each settlement occupies the payment
-- interval [cum_start, cum_end) in that person's running settlement total, each
-- share occupies the debt interval [share_start, share_end) in that person's
-- running share total, and the allocated amount is the overlap. Existing data
-- has zero external splits, so only incoming↔incoming is backfilled (fork 8).
INSERT INTO "settlement_allocations" ("settlement_id", "split_share_id", "amount_cents")
SELECT
	sa."settlement_id",
	sh."share_id",
	LEAST(sa."cum_end", sh."share_end") - GREATEST(sa."cum_start", sh."share_start")
FROM (
	SELECT
		s."id" AS "settlement_id",
		s."person_id",
		COALESCE(SUM(s."amount_cents") OVER (
			PARTITION BY s."person_id"
			ORDER BY s."date", s."created_at", s."id"
			ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS "cum_start",
		SUM(s."amount_cents") OVER (
			PARTITION BY s."person_id"
			ORDER BY s."date", s."created_at", s."id"
			ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "cum_end"
	FROM "settlements" s
	WHERE s."direction" = 'incoming'
) sa
JOIN (
	SELECT
		ss."id" AS "share_id",
		ss."person_id",
		COALESCE(SUM(ss."amount_cents") OVER (
			PARTITION BY ss."person_id"
			ORDER BY t."date", t."created_at", ss."id"
			ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS "share_start",
		SUM(ss."amount_cents") OVER (
			PARTITION BY ss."person_id"
			ORDER BY t."date", t."created_at", ss."id"
			ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "share_end"
	FROM "split_shares" ss
	JOIN "splits" sp ON sp."id" = ss."split_id"
	JOIN "transactions" t ON t."id" = sp."transaction_id"
	JOIN "persons" owner ON owner."is_owner" = true
	WHERE sp."payer_person_id" = owner."id"
		AND ss."person_id" <> owner."id"
		AND t."deleted_at" IS NULL
) sh ON sh."person_id" = sa."person_id"
WHERE LEAST(sa."cum_end", sh."share_end") > GREATEST(sa."cum_start", sh."share_start");
