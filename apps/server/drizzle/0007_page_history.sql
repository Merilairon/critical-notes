CREATE TABLE `page_revisions` (
	`page_id` text NOT NULL,
	`revision` integer NOT NULL,
	`campaign_id` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`body` text,
	`details` text,
	`properties` text NOT NULL,
	`author_user_id` text,
	`source` text NOT NULL,
	`token_id` text,
	`cause` text NOT NULL,
	`restored_from` integer,
	`content_hash` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`page_id`, `revision`),
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `page_revisions_created` ON `page_revisions` (`created_at`);