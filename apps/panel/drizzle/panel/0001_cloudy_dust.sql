CREATE TABLE `cleanup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`run_id` text,
	`trigger` text NOT NULL,
	`error` text,
	`bytes_freed` integer DEFAULT 0 NOT NULL,
	`removed_count` integer DEFAULT 0 NOT NULL,
	`lines` text DEFAULT '[]' NOT NULL,
	`disk_percent` integer,
	`started_by` text,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cleanup_runs_node_idx` ON `cleanup_runs` (`node_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `cleanup_runs_node_run_unique` ON `cleanup_runs` (`node_id`,`run_id`);--> statement-breakpoint
ALTER TABLE `nodes` ADD `cleanup_schedule` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `host_shell` integer DEFAULT false NOT NULL;