CREATE TABLE `node_metrics` (
	`node_id` text NOT NULL,
	`resolution` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`cpu_percent` real NOT NULL,
	`cpu_percent_max` real NOT NULL,
	`memory_bytes` integer NOT NULL,
	`memory_bytes_max` integer NOT NULL,
	`network_rx_bytes_per_sec` real NOT NULL,
	`network_tx_bytes_per_sec` real NOT NULL,
	`memory_total_bytes` integer NOT NULL,
	`disk_used_bytes` integer NOT NULL,
	`disk_total_bytes` integer NOT NULL,
	PRIMARY KEY(`node_id`, `resolution`, `bucket_start`)
);
--> statement-breakpoint
CREATE TABLE `service_metrics` (
	`service_id` text NOT NULL,
	`node_id` text NOT NULL,
	`resolution` text NOT NULL,
	`bucket_start` integer NOT NULL,
	`cpu_percent` real NOT NULL,
	`cpu_percent_max` real NOT NULL,
	`memory_bytes` integer NOT NULL,
	`memory_bytes_max` integer NOT NULL,
	`network_rx_bytes_per_sec` real NOT NULL,
	`network_tx_bytes_per_sec` real NOT NULL,
	PRIMARY KEY(`service_id`, `node_id`, `resolution`, `bucket_start`)
);
--> statement-breakpoint
CREATE TABLE `uptime_samples` (
	`check_id` text NOT NULL,
	`at` integer NOT NULL,
	`ok` integer NOT NULL,
	`status_code` integer,
	`latency_ms` integer,
	PRIMARY KEY(`check_id`, `at`)
);
--> statement-breakpoint
CREATE INDEX `uptime_samples_at_idx` ON `uptime_samples` (`at`);