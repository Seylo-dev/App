ALTER TABLE `backup_policies` ADD `selection` text;--> statement-breakpoint
ALTER TABLE `backup_runs` ADD `selection` text;--> statement-breakpoint
ALTER TABLE `backup_runs` ADD `contents` text;--> statement-breakpoint
ALTER TABLE `backup_runs` ADD `warnings` text;