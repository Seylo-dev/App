CREATE TABLE `push_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`endpoint_hash` text NOT NULL,
	`subscription_sealed` text NOT NULL,
	`service` text NOT NULL,
	`origin` text NOT NULL,
	`label` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_sent_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`window_start` integer DEFAULT 0 NOT NULL,
	`window_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_devices_endpoint_unique` ON `push_devices` (`endpoint_hash`);--> statement-breakpoint
CREATE INDEX `push_devices_user_idx` ON `push_devices` (`user_id`);--> statement-breakpoint
CREATE TABLE `push_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`events` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
