ALTER TABLE `domains` ADD `acme_released_at` integer;--> statement-breakpoint
UPDATE `domains` SET `acme_released_at` = `updated_at` WHERE `dns_status` NOT IN ('missing', 'wrongTarget');
