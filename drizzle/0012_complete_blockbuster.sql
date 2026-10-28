CREATE TABLE "receipt_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"receipt_id" uuid NOT NULL,
	"blob_url" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "receipt_images" ADD CONSTRAINT "receipt_images_receipt_id_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Backfill: every existing receipt's single image becomes its position-0
-- image row, so display/delete can read images uniformly from this table.
INSERT INTO "receipt_images" ("receipt_id", "blob_url", "position")
SELECT "id", "blob_url", 0 FROM "receipts";