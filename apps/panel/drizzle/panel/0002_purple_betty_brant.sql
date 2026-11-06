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
