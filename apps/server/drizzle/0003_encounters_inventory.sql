CREATE TABLE `currencies` (
	`campaign_id` text NOT NULL,
	`owner_key` text NOT NULL,
	`cp` integer DEFAULT 0 NOT NULL,
	`sp` integer DEFAULT 0 NOT NULL,
	`ep` integer DEFAULT 0 NOT NULL,
	`gp` integer DEFAULT 0 NOT NULL,
	`pp` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`campaign_id`, `owner_key`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `encounters` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`name` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`location_page_id` text,
	`creatures` text DEFAULT '[]' NOT NULL,
	`party` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `encounters_campaign` ON `encounters` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `inventory_items` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`owner_page_id` text,
	`item_uid` text,
	`name` text NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`attuned` integer DEFAULT false NOT NULL,
	`identified` integer DEFAULT true NOT NULL,
	`session_page_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inventory_campaign_owner` ON `inventory_items` (`campaign_id`,`owner_page_id`);--> statement-breakpoint
CREATE TABLE `loot_awards` (
	`page_id` text NOT NULL,
	`block_id` text NOT NULL,
	`to_key` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`page_id`, `block_id`),
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trackers` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`encounter_id` text,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`state` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`encounter_id`) REFERENCES `encounters`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `trackers_campaign` ON `trackers` (`campaign_id`);