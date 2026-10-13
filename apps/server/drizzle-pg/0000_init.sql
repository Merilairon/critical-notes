CREATE TABLE "campaign_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_by" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"expires_at" bigint,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"revoked_at" bigint,
	CONSTRAINT "campaign_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "campaign_members" (
	"campaign_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "campaign_members_campaign_id_user_id_pk" PRIMARY KEY("campaign_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_migrations" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"from_ruleset" text NOT NULL,
	"to_ruleset" text NOT NULL,
	"report" jsonb NOT NULL,
	"changed" integer NOT NULL,
	"by_user_id" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_source_overrides" (
	"campaign_id" text NOT NULL,
	"source_id" text NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "campaign_source_overrides_campaign_id_source_id_pk" PRIMARY KEY("campaign_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "campaign_template_defaults" (
	"campaign_id" text NOT NULL,
	"page_type" text NOT NULL,
	"template_id" text NOT NULL,
	CONSTRAINT "campaign_template_defaults_campaign_id_page_type_pk" PRIMARY KEY("campaign_id","page_type")
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"ruleset" text NOT NULL,
	"cross_edition" boolean DEFAULT false NOT NULL,
	"house_rules" jsonb,
	"cover_image" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "character_facets" (
	"page_id" text PRIMARY KEY NOT NULL,
	"player_user_id" text,
	"player_name" text DEFAULT '' NOT NULL,
	"classes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"species_uid" text,
	"background_uid" text,
	"hp_max" integer,
	"hp_current" integer,
	"hp_temp" integer DEFAULT 0 NOT NULL,
	"ac" integer,
	"speed" integer,
	"abilities" jsonb,
	"passive_perception" integer,
	"inspiration" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"campaign_id" text NOT NULL,
	"owner_key" text NOT NULL,
	"cp" integer DEFAULT 0 NOT NULL,
	"sp" integer DEFAULT 0 NOT NULL,
	"ep" integer DEFAULT 0 NOT NULL,
	"gp" integer DEFAULT 0 NOT NULL,
	"pp" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "currencies_campaign_id_owner_key_pk" PRIMARY KEY("campaign_id","owner_key")
);
--> statement-breakpoint
CREATE TABLE "encounters" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"name" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"location_page_id" text,
	"creatures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"party" jsonb NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "entity_references" (
	"page_id" text NOT NULL,
	"uid" text NOT NULL,
	"via" text NOT NULL,
	CONSTRAINT "entity_references_page_id_uid_via_pk" PRIMARY KEY("page_id","uid","via")
);
--> statement-breakpoint
CREATE TABLE "faction_facets" (
	"page_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"attitude" text DEFAULT 'neutral' NOT NULL,
	"headquarters_page_id" text
);
--> statement-breakpoint
CREATE TABLE "homebrew_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"name" text NOT NULL,
	"name_lower" text NOT NULL,
	"data" jsonb NOT NULL,
	"fluff" jsonb,
	"current_revision" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "homebrew_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_id" text NOT NULL,
	"rev_no" integer NOT NULL,
	"data" jsonb NOT NULL,
	"fluff" jsonb,
	"diff" jsonb,
	"author_user_id" text,
	"message" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "homebrew_source_shares" (
	"source_id" text NOT NULL,
	"campaign_id" text NOT NULL,
	CONSTRAINT "homebrew_source_shares_source_id_campaign_id_pk" PRIMARY KEY("source_id","campaign_id")
);
--> statement-breakpoint
CREATE TABLE "homebrew_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"json_id" text NOT NULL,
	"json_id_lower" text NOT NULL,
	"abbreviation" text NOT NULL,
	"full_name" text NOT NULL,
	"authors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"edition" text NOT NULL,
	"color" text,
	"url" text,
	"meta_extra" jsonb,
	"scope" text DEFAULT 'private' NOT NULL,
	"owner_user_id" text,
	"campaign_id" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "homebrew_sources_json_id_lower_unique" UNIQUE("json_id_lower")
);
--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"owner_page_id" text,
	"item_uid" text,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"attuned" boolean DEFAULT false NOT NULL,
	"identified" boolean DEFAULT true NOT NULL,
	"session_page_id" text,
	"notes" text DEFAULT '' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_facets" (
	"page_id" text PRIMARY KEY NOT NULL,
	"item_uid" text,
	"item_homebrew_entity_id" text
);
--> statement-breakpoint
CREATE TABLE "location_facets" (
	"page_id" text PRIMARY KEY NOT NULL,
	"parent_location_page_id" text,
	"kind" text DEFAULT 'site' NOT NULL,
	"map_image" text
);
--> statement-breakpoint
CREATE TABLE "loot_awards" (
	"page_id" text NOT NULL,
	"block_id" text NOT NULL,
	"to_key" text NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "loot_awards_page_id_block_id_pk" PRIMARY KEY("page_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "npc_facets" (
	"page_id" text PRIMARY KEY NOT NULL,
	"statblock_uid" text,
	"statblock_homebrew_entity_id" text,
	"faction_page_id" text,
	"location_page_id" text,
	"status" text DEFAULT 'alive' NOT NULL,
	"attitude" text DEFAULT 'neutral' NOT NULL,
	"role" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_links" (
	"from_page_id" text NOT NULL,
	"to_page_id" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "page_links_from_page_id_to_page_id_kind_pk" PRIMARY KEY("from_page_id","to_page_id","kind")
);
--> statement-breakpoint
CREATE TABLE "page_property_values" (
	"page_id" text NOT NULL,
	"def_id" text NOT NULL,
	"value" jsonb,
	CONSTRAINT "page_property_values_page_id_def_id_pk" PRIMARY KEY("page_id","def_id")
);
--> statement-breakpoint
CREATE TABLE "page_tags" (
	"page_id" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "page_tags_page_id_tag_pk" PRIMARY KEY("page_id","tag")
);
--> statement-breakpoint
CREATE TABLE "page_viewers" (
	"page_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "page_viewers_page_id_user_id_pk" PRIMARY KEY("page_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"parent_id" text,
	"sort_key" text NOT NULL,
	"type" text DEFAULT 'generic' NOT NULL,
	"title" text NOT NULL,
	"icon" text,
	"cover" text,
	"visibility" text DEFAULT 'dm' NOT NULL,
	"body" jsonb,
	"revision" integer DEFAULT 1 NOT NULL,
	"from_template_id" text,
	"from_template_version" integer,
	"created_by" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE TABLE "property_defs" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text NOT NULL,
	"options" jsonb,
	"applies_to" jsonb,
	"dm_only" boolean DEFAULT false NOT NULL,
	"ref_kind" text,
	"sort_key" text DEFAULT 'a0' NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quest_facets" (
	"page_id" text PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'rumor' NOT NULL,
	"giver_page_id" text,
	"priority" text DEFAULT 'normal' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_facets" (
	"page_id" text PRIMARY KEY NOT NULL,
	"number" integer,
	"date" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"summary" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_usage" (
	"template_id" text NOT NULL,
	"page_id" text NOT NULL,
	"block_id" text NOT NULL,
	"version" integer NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "template_usage_template_id_page_id_block_id_pk" PRIMARY KEY("template_id","page_id","block_id")
);
--> statement-breakpoint
CREATE TABLE "template_versions" (
	"template_id" text NOT NULL,
	"version" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "template_versions_template_id_version_pk" PRIMARY KEY("template_id","version")
);
--> statement-breakpoint
CREATE TABLE "templates" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"campaign_id" text,
	"builtin_key" text,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"definition" jsonb NOT NULL,
	"duplicated_from_id" text,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"deleted_at" bigint,
	CONSTRAINT "templates_builtin_key_unique" UNIQUE("builtin_key")
);
--> statement-breakpoint
CREATE TABLE "trackers" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"encounter_id" text,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"state" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"owner_user_id" text,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "campaign_invites" ADD CONSTRAINT "campaign_invites_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_invites" ADD CONSTRAINT "campaign_invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_members" ADD CONSTRAINT "campaign_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_migrations" ADD CONSTRAINT "campaign_migrations_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_migrations" ADD CONSTRAINT "campaign_migrations_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_source_overrides" ADD CONSTRAINT "campaign_source_overrides_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_template_defaults" ADD CONSTRAINT "campaign_template_defaults_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_template_defaults" ADD CONSTRAINT "campaign_template_defaults_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_facets" ADD CONSTRAINT "character_facets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_facets" ADD CONSTRAINT "character_facets_player_user_id_users_id_fk" FOREIGN KEY ("player_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "currencies" ADD CONSTRAINT "currencies_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "encounters" ADD CONSTRAINT "encounters_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_references" ADD CONSTRAINT "entity_references_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faction_facets" ADD CONSTRAINT "faction_facets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faction_facets" ADD CONSTRAINT "faction_facets_headquarters_page_id_pages_id_fk" FOREIGN KEY ("headquarters_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homebrew_entities" ADD CONSTRAINT "homebrew_entities_source_id_homebrew_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."homebrew_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homebrew_entities" ADD CONSTRAINT "homebrew_entities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homebrew_revisions" ADD CONSTRAINT "homebrew_revisions_entity_id_homebrew_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."homebrew_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homebrew_revisions" ADD CONSTRAINT "homebrew_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homebrew_source_shares" ADD CONSTRAINT "homebrew_source_shares_source_id_homebrew_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."homebrew_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homebrew_source_shares" ADD CONSTRAINT "homebrew_source_shares_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homebrew_sources" ADD CONSTRAINT "homebrew_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "homebrew_sources" ADD CONSTRAINT "homebrew_sources_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_owner_page_id_pages_id_fk" FOREIGN KEY ("owner_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_session_page_id_pages_id_fk" FOREIGN KEY ("session_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_facets" ADD CONSTRAINT "item_facets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_facets" ADD CONSTRAINT "location_facets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_facets" ADD CONSTRAINT "location_facets_parent_location_page_id_pages_id_fk" FOREIGN KEY ("parent_location_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loot_awards" ADD CONSTRAINT "loot_awards_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_facets" ADD CONSTRAINT "npc_facets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_facets" ADD CONSTRAINT "npc_facets_faction_page_id_pages_id_fk" FOREIGN KEY ("faction_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "npc_facets" ADD CONSTRAINT "npc_facets_location_page_id_pages_id_fk" FOREIGN KEY ("location_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_links" ADD CONSTRAINT "page_links_from_page_id_pages_id_fk" FOREIGN KEY ("from_page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_property_values" ADD CONSTRAINT "page_property_values_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_property_values" ADD CONSTRAINT "page_property_values_def_id_property_defs_id_fk" FOREIGN KEY ("def_id") REFERENCES "public"."property_defs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tags" ADD CONSTRAINT "page_tags_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_viewers" ADD CONSTRAINT "page_viewers_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_viewers" ADD CONSTRAINT "page_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_parent_id_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_defs" ADD CONSTRAINT "property_defs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_facets" ADD CONSTRAINT "quest_facets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quest_facets" ADD CONSTRAINT "quest_facets_giver_page_id_pages_id_fk" FOREIGN KEY ("giver_page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_facets" ADD CONSTRAINT "session_facets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_usage" ADD CONSTRAINT "template_usage_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_versions" ADD CONSTRAINT "template_versions_template_id_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "templates" ADD CONSTRAINT "templates_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trackers" ADD CONSTRAINT "trackers_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trackers" ADD CONSTRAINT "trackers_encounter_id_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_invites_campaign" ON "campaign_invites" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "members_user" ON "campaign_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "campaign_migrations_campaign" ON "campaign_migrations" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "encounters_campaign" ON "encounters" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "entity_references_uid" ON "entity_references" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "homebrew_entities_source" ON "homebrew_entities" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "homebrew_entities_unique_live" ON "homebrew_entities" USING btree ("source_id","entity_type","name_lower") WHERE "homebrew_entities"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "homebrew_revisions_entity_rev" ON "homebrew_revisions" USING btree ("entity_id","rev_no");--> statement-breakpoint
CREATE INDEX "homebrew_sources_campaign" ON "homebrew_sources" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "inventory_campaign_owner" ON "inventory_items" USING btree ("campaign_id","owner_page_id");--> statement-breakpoint
CREATE INDEX "page_links_to" ON "page_links" USING btree ("to_page_id");--> statement-breakpoint
CREATE INDEX "ppv_def" ON "page_property_values" USING btree ("def_id");--> statement-breakpoint
CREATE INDEX "page_tags_tag" ON "page_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "pages_campaign_parent" ON "pages" USING btree ("campaign_id","parent_id");--> statement-breakpoint
CREATE INDEX "pages_campaign_type" ON "pages" USING btree ("campaign_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "property_defs_key" ON "property_defs" USING btree ("campaign_id","key");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "template_usage_page" ON "template_usage" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX "templates_owner" ON "templates" USING btree ("scope","owner_user_id");--> statement-breakpoint
CREATE INDEX "templates_campaign" ON "templates" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "trackers_campaign" ON "trackers" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "uploads_campaign" ON "uploads" USING btree ("campaign_id");