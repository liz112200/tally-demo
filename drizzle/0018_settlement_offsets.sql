ALTER TABLE "settlements" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "is_offset" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "settlements_group_id_idx" ON "settlements" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_offset_has_group" CHECK (NOT "settlements"."is_offset" OR "settlements"."group_id" IS NOT NULL);