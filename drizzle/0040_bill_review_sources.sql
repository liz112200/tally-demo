ALTER TABLE "share_links" ADD COLUMN "review_person_id" uuid;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "review_sources" jsonb;