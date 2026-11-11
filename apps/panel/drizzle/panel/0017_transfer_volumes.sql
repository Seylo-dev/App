ALTER TABLE `service_exports` ADD `volumes` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `service_exports` ADD `node_id` text;--> statement-breakpoint
ALTER TABLE `service_exports` ADD `stop_service` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `service_exports` ADD `source_stopped` integer DEFAULT false NOT NULL;