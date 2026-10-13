CREATE TABLE `entity_references` (
	`page_id` text NOT NULL,
	`uid` text NOT NULL,
	`via` text NOT NULL,
	PRIMARY KEY(`page_id`, `uid`, `via`),
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `entity_references_uid` ON `entity_references` (`uid`);--> statement-breakpoint
CREATE TABLE `page_links` (
	`from_page_id` text NOT NULL,
	`to_page_id` text NOT NULL,
	`kind` text NOT NULL,
	PRIMARY KEY(`from_page_id`, `to_page_id`, `kind`),
	FOREIGN KEY (`from_page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `page_links_to` ON `page_links` (`to_page_id`);--> statement-breakpoint
CREATE TABLE `page_property_values` (
	`page_id` text NOT NULL,
	`def_id` text NOT NULL,
	`value` text,
	PRIMARY KEY(`page_id`, `def_id`),
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`def_id`) REFERENCES `property_defs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ppv_def` ON `page_property_values` (`def_id`);--> statement-breakpoint
CREATE TABLE `property_defs` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text NOT NULL,
	`options` text,
	`applies_to` text,
	`dm_only` integer DEFAULT false NOT NULL,
	`ref_kind` text,
	`sort_key` text DEFAULT 'a0' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `property_defs_key` ON `property_defs` (`campaign_id`,`key`);--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`owner_user_id` text,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `uploads_campaign` ON `uploads` (`campaign_id`);