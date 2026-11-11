CREATE TABLE `service_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`secrets` text NOT NULL,
	`payload_sealed` text,
	`upload_id` text,
	`file_name` text NOT NULL,
	`bytes_sent` integer DEFAULT 0 NOT NULL,
	`zip_sha256` text,
	`entries` text,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `service_exports_service_idx` ON `service_exports` (`service_id`);--> statement-breakpoint
CREATE INDEX `service_exports_status_idx` ON `service_exports` (`status`);--> statement-breakpoint
CREATE TABLE `service_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`service_id` text,
	`status` text DEFAULT 'previewing' NOT NULL,
	`doc_sealed` text,
	`manifest_sha256` text NOT NULL,
	`choices` text NOT NULL,
	`entries` text NOT NULL,
	`panel_version` text NOT NULL,
	`secrets` text NOT NULL,
	`same_panel` integer DEFAULT false NOT NULL,
	`deploy_when_ready` integer DEFAULT false NOT NULL,
	`commit_sha` text,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `service_imports_project_idx` ON `service_imports` (`project_id`);--> statement-breakpoint
CREATE INDEX `service_imports_service_idx` ON `service_imports` (`service_id`);--> statement-breakpoint
CREATE INDEX `service_imports_expires_idx` ON `service_imports` (`expires_at`);