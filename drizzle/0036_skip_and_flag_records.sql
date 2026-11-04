-- Records of what used to vanish (CLAUDE.md: a default that destroys
-- information or hides an omission is not acceptable). Two new tables, one
-- trigger. No existing row is written: import_skipped_rows starts empty (no
-- past import kept its skips), and bank_flag_resolutions fills only when a
-- flag is cleared from now on.
CREATE TABLE "bank_flag_resolutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"flag" text NOT NULL,
	"bank_amount_before_cents" bigint,
	"amount_cents" bigint NOT NULL,
	"removed_by_bank_at" timestamp with time zone,
	"resolution" text NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_flag_resolutions_flag" CHECK ("bank_flag_resolutions"."flag" in ('amount', 'removed')),
	CONSTRAINT "bank_flag_resolutions_fields" CHECK (("bank_flag_resolutions"."flag" = 'amount') = ("bank_flag_resolutions"."bank_amount_before_cents" is not null) and ("bank_flag_resolutions"."flag" = 'removed') = ("bank_flag_resolutions"."removed_by_bank_at" is not null)),
	CONSTRAINT "bank_flag_resolutions_resolution" CHECK ("bank_flag_resolutions"."resolution" in ('kept', 'split_resaved', 'split_removed', 'row_deleted', 'moved_to_replacement', 'bank_reverted', 'unlabelled'))
);
--> statement-breakpoint
CREATE TABLE "import_skipped_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_id" uuid,
	"confirm_id" uuid NOT NULL,
	"filename" text,
	"source" "transaction_source" NOT NULL,
	"account_label" text,
	"date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description_raw" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_skipped_rows_reason" CHECK ("import_skipped_rows"."reason" in ('duplicate', 'duplicate_of_deleted', 'covered', 'collision'))
);
--> statement-breakpoint
ALTER TABLE "bank_flag_resolutions" ADD CONSTRAINT "bank_flag_resolutions_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_skipped_rows" ADD CONSTRAINT "import_skipped_rows_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_flag_resolutions_transaction" ON "bank_flag_resolutions" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "import_skipped_rows_confirm" ON "import_skipped_rows" USING btree ("confirm_id");--> statement-breakpoint
CREATE FUNCTION "transactions_record_flag_resolution"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- Set for the transaction by the path clearing the flag; '' once a
  -- transaction that set it has ended.
  label text := nullif(current_setting('tally.flag_resolution', true), '');
BEGIN
  IF label IS NULL THEN
    label := CASE WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN 'row_deleted' ELSE 'unlabelled' END;
  END IF;
  IF OLD.bank_amount_before_cents IS NOT NULL AND NEW.bank_amount_before_cents IS NULL THEN
    INSERT INTO "bank_flag_resolutions" ("transaction_id", "flag", "bank_amount_before_cents", "amount_cents", "resolution")
    VALUES (NEW.id, 'amount', OLD.bank_amount_before_cents, NEW.amount_cents, label);
  END IF;
  IF OLD.removed_by_bank_at IS NOT NULL AND NEW.removed_by_bank_at IS NULL THEN
    INSERT INTO "bank_flag_resolutions" ("transaction_id", "flag", "removed_by_bank_at", "amount_cents", "resolution")
    VALUES (NEW.id, 'removed', OLD.removed_by_bank_at, NEW.amount_cents, label);
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "transactions_record_flag_resolution" AFTER UPDATE OF "bank_amount_before_cents", "removed_by_bank_at" ON "transactions"
FOR EACH ROW EXECUTE FUNCTION "transactions_record_flag_resolution"();
