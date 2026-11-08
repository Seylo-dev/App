CREATE TABLE `report_totals` (
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`byte_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`node_id`, `kind`),
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `builds_in_flight_idx` ON `builds` (`node_id`) WHERE "builds"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX `deployments_in_flight_idx` ON `deployments` (`status`) WHERE "deployments"."status" in ('queued', 'building', 'deploying');--> statement-breakpoint
CREATE INDEX `crash_reports_occurred_idx` ON `crash_reports` (`occurred_at`);--> statement-breakpoint
-- report_totals: rows and bytes per node and kind, kept by the triggers below (db/schema/runtime.ts).
INSERT INTO `report_totals` (`node_id`, `kind`, `row_count`, `byte_count`)
	SELECT `node_id`, `kind`, count(*), coalesce(sum(length(`event`)), 0) FROM `agent_reports` GROUP BY `node_id`, `kind`;--> statement-breakpoint
INSERT INTO `report_totals` (`node_id`, `kind`, `row_count`, `byte_count`)
	SELECT `node_id`, 'crash', count(*), coalesce(sum(length(`last_lines`) + length(`container_id`)), 0) FROM `crash_reports`
	WHERE `node_id` IS NOT NULL GROUP BY `node_id`;--> statement-breakpoint
CREATE TRIGGER `agent_reports_totals_insert` AFTER INSERT ON `agent_reports` BEGIN
	INSERT INTO `report_totals` (`node_id`, `kind`, `row_count`, `byte_count`) VALUES (new.`node_id`, new.`kind`, 1, length(new.`event`))
		ON CONFLICT (`node_id`, `kind`) DO UPDATE SET `row_count` = `row_count` + 1, `byte_count` = `byte_count` + excluded.`byte_count`;
END;--> statement-breakpoint
CREATE TRIGGER `agent_reports_totals_delete` AFTER DELETE ON `agent_reports` BEGIN
	UPDATE `report_totals` SET `row_count` = `row_count` - 1, `byte_count` = `byte_count` - length(old.`event`)
		WHERE `node_id` = old.`node_id` AND `kind` = old.`kind`;
END;--> statement-breakpoint
CREATE TRIGGER `agent_reports_totals_update` AFTER UPDATE OF `node_id`, `kind`, `event` ON `agent_reports` BEGIN
	UPDATE `report_totals` SET `row_count` = `row_count` - 1, `byte_count` = `byte_count` - length(old.`event`)
		WHERE `node_id` = old.`node_id` AND `kind` = old.`kind`;
	INSERT INTO `report_totals` (`node_id`, `kind`, `row_count`, `byte_count`) VALUES (new.`node_id`, new.`kind`, 1, length(new.`event`))
		ON CONFLICT (`node_id`, `kind`) DO UPDATE SET `row_count` = `row_count` + 1, `byte_count` = `byte_count` + excluded.`byte_count`;
END;--> statement-breakpoint
CREATE TRIGGER `crash_reports_totals_insert` AFTER INSERT ON `crash_reports` WHEN new.`node_id` IS NOT NULL BEGIN
	INSERT INTO `report_totals` (`node_id`, `kind`, `row_count`, `byte_count`)
		VALUES (new.`node_id`, 'crash', 1, length(new.`last_lines`) + length(new.`container_id`))
		ON CONFLICT (`node_id`, `kind`) DO UPDATE SET `row_count` = `row_count` + 1, `byte_count` = `byte_count` + excluded.`byte_count`;
END;--> statement-breakpoint
CREATE TRIGGER `crash_reports_totals_delete` AFTER DELETE ON `crash_reports` WHEN old.`node_id` IS NOT NULL BEGIN
	UPDATE `report_totals` SET `row_count` = `row_count` - 1, `byte_count` = `byte_count` - (length(old.`last_lines`) + length(old.`container_id`))
		WHERE `node_id` = old.`node_id` AND `kind` = 'crash';
END;--> statement-breakpoint
CREATE TRIGGER `crash_reports_totals_update` AFTER UPDATE OF `node_id`, `last_lines`, `container_id` ON `crash_reports` BEGIN
	UPDATE `report_totals` SET `row_count` = `row_count` - 1, `byte_count` = `byte_count` - (length(old.`last_lines`) + length(old.`container_id`))
		WHERE `node_id` = old.`node_id` AND `kind` = 'crash';
	INSERT INTO `report_totals` (`node_id`, `kind`, `row_count`, `byte_count`)
		SELECT new.`node_id`, 'crash', 1, length(new.`last_lines`) + length(new.`container_id`) WHERE new.`node_id` IS NOT NULL
		ON CONFLICT (`node_id`, `kind`) DO UPDATE SET `row_count` = `row_count` + 1, `byte_count` = `byte_count` + excluded.`byte_count`;
END;
