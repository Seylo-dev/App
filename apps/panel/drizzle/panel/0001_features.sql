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
