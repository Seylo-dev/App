CREATE TABLE `service_copies` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text,
	`source_service_id` text,
	`source_name` text NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stop_source` integer DEFAULT true NOT NULL,
	`source_stopped` integer DEFAULT false NOT NULL,
	`volumes` text NOT NULL,
	`bytes_copied` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `service_copies_service_idx` ON `service_copies` (`service_id`);--> statement-breakpoint
CREATE INDEX `service_copies_source_idx` ON `service_copies` (`source_service_id`);--> statement-breakpoint
ALTER TABLE `deployments` ADD `project_move` text;