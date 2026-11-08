ALTER TABLE `update_runs` ADD `manifest` text;--> statement-breakpoint
ALTER TABLE `update_runs` ADD `manifest_signature` text;--> statement-breakpoint
ALTER TABLE `update_steps` ADD `retry` text;--> statement-breakpoint
ALTER TABLE `update_steps` ADD `retry_run_id` text;--> statement-breakpoint
ALTER TABLE `update_steps` ADD `retry_at` integer;--> statement-breakpoint
CREATE INDEX `update_steps_node_retry_idx` ON `update_steps` (`node_id`,`retry`);