CREATE TYPE "public"."category_source" AS ENUM('manual', 'rule');--> statement-breakpoint
CREATE TYPE "public"."match_type" AS ENUM('substring', 'regex');--> statement-breakpoint
CREATE TABLE "categorization_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match_pattern" text NOT NULL,
	"match_type" "match_type" NOT NULL,
	"category_id" uuid NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "merchant_normalized" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "category_source" "category_source";--> statement-breakpoint
ALTER TABLE "categorization_rules" ADD CONSTRAINT "categorization_rules_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "categorization_rules_pattern_type_unique" ON "categorization_rules" USING btree ("match_pattern","match_type");