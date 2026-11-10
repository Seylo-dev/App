CREATE TABLE `user_avatars` (
	`user_id` text PRIMARY KEY NOT NULL,
	`content_type` text NOT NULL,
	`hash` text NOT NULL,
	`bytes` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `users` ADD `avatar` text;