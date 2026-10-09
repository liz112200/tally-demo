CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"person_name" text NOT NULL,
	"direction" text NOT NULL,
	"total_cents" integer NOT NULL,
	"lines" jsonb NOT NULL,
	"grouped_by_category" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "share_links_token_unique" UNIQUE("token")
);
