ALTER TABLE `users` ADD `ai_auto_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `approvals` ADD `source_label` text DEFAULT '' NOT NULL;