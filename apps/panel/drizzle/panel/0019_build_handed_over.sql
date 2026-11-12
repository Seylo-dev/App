ALTER TABLE `builds` ADD `handed_over_at` integer;--> statement-breakpoint
UPDATE `builds` SET `handed_over_at` = `created_at` WHERE `status` IN ('queued', 'running');