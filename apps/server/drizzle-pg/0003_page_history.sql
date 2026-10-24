CREATE TABLE "page_revisions" (
	"page_id" text NOT NULL,
	"revision" integer NOT NULL,
	"campaign_id" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"body" jsonb,
	"details" jsonb,
	"properties" jsonb NOT NULL,
	"author_user_id" text,
	"source" text NOT NULL,
	"token_id" text,
	"cause" text NOT NULL,
	"restored_from" integer,
	"content_hash" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "page_revisions_page_id_revision_pk" PRIMARY KEY("page_id","revision")
);
--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_revisions" ADD CONSTRAINT "page_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_revisions_created" ON "page_revisions" USING btree ("created_at");