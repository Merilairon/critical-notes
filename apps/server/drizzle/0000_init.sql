CREATE TABLE `campaign_members` (
	`campaign_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`campaign_id`, `user_id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `members_user` ON `campaign_members` (`user_id`);--> statement-breakpoint
CREATE TABLE `campaign_source_overrides` (
	`campaign_id` text NOT NULL,
	`source_id` text NOT NULL,
	`enabled` integer NOT NULL,
	PRIMARY KEY(`campaign_id`, `source_id`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`ruleset` text NOT NULL,
	`cross_edition` integer DEFAULT false NOT NULL,
	`house_rules` text,
	`cover_image` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `character_facets` (
	`page_id` text PRIMARY KEY NOT NULL,
	`player_user_id` text,
	`player_name` text DEFAULT '' NOT NULL,
	`classes` text DEFAULT '[]' NOT NULL,
	`species_uid` text,
	`background_uid` text,
	`hp_max` integer,
	`hp_current` integer,
	`hp_temp` integer DEFAULT 0 NOT NULL,
	`ac` integer,
	`speed` integer,
	`abilities` text,
	`passive_perception` integer,
	`inspiration` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `faction_facets` (
	`page_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`attitude` text DEFAULT 'neutral' NOT NULL,
	`headquarters_page_id` text,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`headquarters_page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `homebrew_entities` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`name` text NOT NULL,
	`name_lower` text NOT NULL,
	`data` text NOT NULL,
	`fluff` text,
	`current_revision` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `homebrew_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `homebrew_entities_source` ON `homebrew_entities` (`source_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `homebrew_entities_unique_live` ON `homebrew_entities` (`source_id`,`entity_type`,`name_lower`) WHERE "homebrew_entities"."deleted_at" is null;--> statement-breakpoint
CREATE TABLE `homebrew_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_id` text NOT NULL,
	`rev_no` integer NOT NULL,
	`data` text NOT NULL,
	`fluff` text,
	`diff` text,
	`author_user_id` text,
	`message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `homebrew_entities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `homebrew_revisions_entity_rev` ON `homebrew_revisions` (`entity_id`,`rev_no`);--> statement-breakpoint
CREATE TABLE `homebrew_source_shares` (
	`source_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	PRIMARY KEY(`source_id`, `campaign_id`),
	FOREIGN KEY (`source_id`) REFERENCES `homebrew_sources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `homebrew_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`json_id` text NOT NULL,
	`json_id_lower` text NOT NULL,
	`abbreviation` text NOT NULL,
	`full_name` text NOT NULL,
	`authors` text DEFAULT '[]' NOT NULL,
	`version` text DEFAULT '1.0.0' NOT NULL,
	`edition` text NOT NULL,
	`color` text,
	`url` text,
	`meta_extra` text,
	`scope` text DEFAULT 'private' NOT NULL,
	`owner_user_id` text,
	`campaign_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `homebrew_sources_json_id_lower_unique` ON `homebrew_sources` (`json_id_lower`);--> statement-breakpoint
CREATE INDEX `homebrew_sources_campaign` ON `homebrew_sources` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `item_facets` (
	`page_id` text PRIMARY KEY NOT NULL,
	`item_uid` text,
	`item_homebrew_entity_id` text,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `location_facets` (
	`page_id` text PRIMARY KEY NOT NULL,
	`parent_location_page_id` text,
	`kind` text DEFAULT 'site' NOT NULL,
	`map_image` text,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_location_page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `npc_facets` (
	`page_id` text PRIMARY KEY NOT NULL,
	`statblock_uid` text,
	`statblock_homebrew_entity_id` text,
	`faction_page_id` text,
	`location_page_id` text,
	`status` text DEFAULT 'alive' NOT NULL,
	`attitude` text DEFAULT 'neutral' NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`faction_page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`location_page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `page_tags` (
	`page_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`page_id`, `tag`),
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `page_tags_tag` ON `page_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `page_viewers` (
	`page_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`page_id`, `user_id`),
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`parent_id` text,
	`sort_key` text NOT NULL,
	`type` text DEFAULT 'generic' NOT NULL,
	`title` text NOT NULL,
	`icon` text,
	`cover` text,
	`visibility` text DEFAULT 'dm' NOT NULL,
	`body` text,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `pages_campaign_parent` ON `pages` (`campaign_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `pages_campaign_type` ON `pages` (`campaign_id`,`type`);--> statement-breakpoint
CREATE TABLE `quest_facets` (
	`page_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'rumor' NOT NULL,
	`giver_page_id` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`giver_page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `session_facets` (
	`page_id` text PRIMARY KEY NOT NULL,
	`number` integer,
	`date` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);