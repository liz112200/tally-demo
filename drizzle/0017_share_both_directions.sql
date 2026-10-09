ALTER TABLE "share_links" ADD COLUMN "owing_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "owing_lines" jsonb DEFAULT '[]'::jsonb NOT NULL;