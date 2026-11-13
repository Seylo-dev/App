ALTER TABLE `project_prefs` ADD `dashboard_collapsed` integer DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE `project_prefs` SET `dashboard_collapsed` = `collapsed`;
