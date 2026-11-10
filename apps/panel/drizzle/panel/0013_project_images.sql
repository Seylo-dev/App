CREATE TABLE `project_images` (
	`project_id` text PRIMARY KEY NOT NULL,
	`content_type` text NOT NULL,
	`hash` text NOT NULL,
	`bytes` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
