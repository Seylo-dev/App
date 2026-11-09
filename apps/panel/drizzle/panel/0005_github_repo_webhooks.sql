CREATE TABLE `github_repo_webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`credential_id` text,
	`repo` text NOT NULL,
	`secret_sealed` text NOT NULL,
	`remote_id` text,
	`url` text,
	`error` text,
	`last_delivery_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `git_credentials`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_repo_webhooks_service_unique` ON `github_repo_webhooks` (`service_id`);