CREATE TABLE `campaign_template_defaults` (
	`campaign_id` text NOT NULL,
	`page_type` text NOT NULL,
	`template_id` text NOT NULL,
	PRIMARY KEY(`campaign_id`, `page_type`),
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `template_usage` (
	`template_id` text NOT NULL,
	`page_id` text NOT NULL,
	`block_id` text NOT NULL,
	`version` integer NOT NULL,
	`mode` text NOT NULL,
	PRIMARY KEY(`template_id`, `page_id`, `block_id`),
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `template_usage_page` ON `template_usage` (`page_id`);--> statement-breakpoint
CREATE TABLE `template_versions` (
	`template_id` text NOT NULL,
	`version` integer NOT NULL,
	`definition` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`template_id`, `version`),
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`owner_user_id` text,
	`campaign_id` text,
	`builtin_key` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`definition` text NOT NULL,
	`duplicated_from_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `templates_builtin_key_unique` ON `templates` (`builtin_key`);--> statement-breakpoint
CREATE INDEX `templates_owner` ON `templates` (`scope`,`owner_user_id`);--> statement-breakpoint
CREATE INDEX `templates_campaign` ON `templates` (`campaign_id`);--> statement-breakpoint
ALTER TABLE `pages` ADD `from_template_id` text;--> statement-breakpoint
ALTER TABLE `pages` ADD `from_template_version` integer;