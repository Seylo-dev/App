CREATE TABLE `git_provider_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`repo` text NOT NULL,
	`secret_sealed` text NOT NULL,
	`remote_id` text,
	`url` text,
	`error` text,
	`last_delivery_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `git_providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `git_provider_webhooks_service_unique` ON `git_provider_webhooks` (`service_id`);--> statement-breakpoint
CREATE INDEX `git_provider_webhooks_provider_idx` ON `git_provider_webhooks` (`provider_id`);--> statement-breakpoint
CREATE TABLE `git_providers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`workspace` text,
	`auth_kind` text DEFAULT 'token' NOT NULL,
	`username` text,
	`token_sealed` text NOT NULL,
	`account` text,
	`status_notes` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
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
CREATE TABLE `host_shell_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`node_name` text NOT NULL,
	`user_id` text NOT NULL,
	`auth_session_id` text NOT NULL,
	`opened_by` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`opened_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `nodes` ADD `cleanup_schedule` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `host_shell` integer DEFAULT false NOT NULL;