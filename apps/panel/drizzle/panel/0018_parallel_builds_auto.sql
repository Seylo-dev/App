ALTER TABLE `nodes` ADD `parallel_builds_auto` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `nodes` SET `parallel_builds_auto` = false;
