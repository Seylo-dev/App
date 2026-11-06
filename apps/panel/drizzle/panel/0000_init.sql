CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`credential_id` text,
	`actor_label` text NOT NULL,
	`op_id` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`target_label` text,
	`project_id` text,
	`transport` text DEFAULT 'http' NOT NULL,
	`input` text NOT NULL,
	`outcome` text NOT NULL,
	`error_code` text,
	`duration_ms` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`approval_id` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_actor_idx` ON `audit_log` (`actor_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_target_idx` ON `audit_log` (`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `audit_log_op_idx` ON `audit_log` (`op_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_project_idx` ON `audit_log` (`project_id`,`id`);--> statement-breakpoint
CREATE TABLE `alert_mutes` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`event` text,
	`until` integer,
	`reason` text DEFAULT '' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `alert_mutes_scope_idx` ON `alert_mutes` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `alert_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`event` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`channel_ids` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alert_rules_scope_event_unique` ON `alert_rules` (`scope_type`,`scope_id`,`event`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`event` text NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`project_id` text,
	`service_id` text,
	`node_id` text,
	`link` text,
	`event_key` text NOT NULL,
	`muted` integer DEFAULT false NOT NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_event_key_unique` ON `alerts` (`event_key`);--> statement-breakpoint
CREATE INDEX `alerts_created_idx` ON `alerts` (`created_at`);--> statement-breakpoint
CREATE INDEX `alerts_service_idx` ON `alerts` (`service_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alerts_node_idx` ON `alerts` (`node_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `cron_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`schedule` text NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`command` text NOT NULL,
	`timeout_seconds` integer DEFAULT 3600 NOT NULL,
	`concurrency` text DEFAULT 'forbid' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cron_jobs_service_idx` ON `cron_jobs` (`service_id`);--> statement-breakpoint
CREATE TABLE `cron_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`cron_job_id` text,
	`node_id` text,
	`run_key` text NOT NULL,
	`result` text NOT NULL,
	`manual` integer DEFAULT false NOT NULL,
	`exit_code` integer,
	`output_tail` text DEFAULT '' NOT NULL,
	`output_truncated` integer DEFAULT false NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cron_job_id`) REFERENCES `cron_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cron_runs_run_key_unique` ON `cron_runs` (`service_id`,`run_key`);--> statement-breakpoint
CREATE INDEX `cron_runs_service_idx` ON `cron_runs` (`service_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `cron_runs_job_idx` ON `cron_runs` (`cron_job_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config_sealed` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text,
	`channel_id` text,
	`test` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `notification_channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notification_deliveries_alert_idx` ON `notification_deliveries` (`alert_id`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_channel_idx` ON `notification_deliveries` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `uptime_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`method` text DEFAULT 'GET' NOT NULL,
	`expected_status` integer DEFAULT 200 NOT NULL,
	`interval_seconds` integer DEFAULT 60 NOT NULL,
	`timeout_ms` integer DEFAULT 10000 NOT NULL,
	`failure_threshold` integer DEFAULT 2 NOT NULL,
	`keyword` text,
	`max_latency_ms` integer,
	`enabled` integer DEFAULT true NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`state_since` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_checked_at` integer,
	`last_status_code` integer,
	`last_latency_ms` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `uptime_checks_service_idx` ON `uptime_checks` (`service_id`);--> statement-breakpoint
CREATE TABLE `backup_destinations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`provider` text DEFAULT 's3' NOT NULL,
	`endpoint` text NOT NULL,
	`region` text DEFAULT 'auto' NOT NULL,
	`bucket` text NOT NULL,
	`path_prefix` text DEFAULT '' NOT NULL,
	`path_style` integer DEFAULT false NOT NULL,
	`access_key_id` text NOT NULL,
	`secret_access_key_sealed` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`destination_id` text NOT NULL,
	`target` text NOT NULL,
	`volume_id` text,
	`schedule` text NOT NULL,
	`keep_last` integer DEFAULT 7 NOT NULL,
	`stop_service` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `backup_destinations`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `backup_policies_service_idx` ON `backup_policies` (`service_id`);--> statement-breakpoint
CREATE INDEX `backup_policies_next_run_idx` ON `backup_policies` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'backup' NOT NULL,
	`target` text NOT NULL,
	`volume_id` text,
	`source_run_id` text,
	`policy_id` text,
	`service_id` text NOT NULL,
	`destination_id` text,
	`node_id` text,
	`outbox_id` text,
	`status` text NOT NULL,
	`object_key` text,
	`size_bytes` integer,
	`error` text,
	`deleted_at` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`volume_id`) REFERENCES `volumes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`policy_id`) REFERENCES `backup_policies`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`destination_id`) REFERENCES `backup_destinations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `backup_runs_outbox_unique` ON `backup_runs` (`node_id`,`outbox_id`);--> statement-breakpoint
CREATE INDEX `backup_runs_service_idx` ON `backup_runs` (`service_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `builds` (
	`id` text PRIMARY KEY NOT NULL,
	`deployment_id` text NOT NULL,
	`node_id` text,
	`builder` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`image_size_bytes` integer,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `builds_deployment_idx` ON `builds` (`deployment_id`);--> statement-breakpoint
CREATE TABLE `deploy_triggers` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`hint` text NOT NULL,
	`created_by` text,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deploy_triggers_token_hash_unique` ON `deploy_triggers` (`token_hash`);--> statement-breakpoint
CREATE INDEX `deploy_triggers_service_idx` ON `deploy_triggers` (`service_id`);--> statement-breakpoint
CREATE TABLE `deployment_logs` (
	`deployment_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` integer NOT NULL,
	`step` text NOT NULL,
	`text` text NOT NULL,
	`error` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`deployment_id`, `seq`),
	FOREIGN KEY (`deployment_id`) REFERENCES `deployments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `deployments` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`trigger` text NOT NULL,
	`image_ref` text,
	`image_digest` text,
	`commit_sha` text,
	`commit_message` text,
	`commit_author` text,
	`branch` text,
	`actor` text,
	`steps` text DEFAULT '[]' NOT NULL,
	`target_node_ids` text DEFAULT '[]' NOT NULL,
	`image_size_bytes` integer,
	`shipped_bytes` integer,
	`no_cache` integer DEFAULT false NOT NULL,
	`rollback_of` text,
	`built_on_node_id` text,
	`triggered_by` text,
	`error` text,
	`run_settings` text,
	`env_sealed` text,
	`node_results` text DEFAULT '{}' NOT NULL,
	`image_pruned_at` integer,
	`moved_from_node_id` text,
	`move_copying` integer DEFAULT false NOT NULL,
	`wait_for` text DEFAULT '[]' NOT NULL,
	`upload_id` text,
	`phase_started_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`built_on_node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`triggered_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deployments_service_created_idx` ON `deployments` (`service_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `previews` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`preview_service_id` text,
	`pr_number` integer NOT NULL,
	`pr_title` text DEFAULT '' NOT NULL,
	`branch` text NOT NULL,
	`commit_sha` text,
	`closed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`preview_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `previews_service_pr_unique` ON `previews` (`service_id`,`pr_number`);--> statement-breakpoint
CREATE TABLE `source_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`file_name` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`uploaded_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `source_uploads_service_idx` ON `source_uploads` (`service_id`);--> statement-breakpoint
CREATE TABLE `project_env` (
	`project_id` text PRIMARY KEY NOT NULL,
	`content_sealed` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `service_boxes` (
	`service_id` text PRIMARY KEY NOT NULL,
	`repository` text,
	`idle_minutes` integer DEFAULT 30 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `service_databases` (
	`service_id` text PRIMARY KEY NOT NULL,
	`engine` text NOT NULL,
	`version` text NOT NULL,
	`database_name` text DEFAULT '' NOT NULL,
	`admin_user` text NOT NULL,
	`exposed_user` text NOT NULL,
	`tls_hostname` text,
	`web_ui_idle_minutes` integer DEFAULT 15 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `service_env` (
	`service_id` text PRIMARY KEY NOT NULL,
	`content_sealed` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `service_secrets` (
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`value_sealed` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`service_id`, `name`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `git_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`host` text NOT NULL,
	`username` text,
	`secret_sealed` text NOT NULL,
	`known_hosts` text,
	`public_key` text,
	`fingerprint` text,
	`origin` text DEFAULT 'manual' NOT NULL,
	`github_login` text,
	`scopes` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `github_apps` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` integer NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`html_url` text NOT NULL,
	`owner_login` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_sealed` text NOT NULL,
	`private_key_sealed` text NOT NULL,
	`webhook_secret_sealed` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `github_device_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code_sealed` text NOT NULL,
	`user_code` text NOT NULL,
	`verification_uri` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`created_by` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `github_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`github_app_id` text NOT NULL,
	`installation_id` integer NOT NULL,
	`account_login` text NOT NULL,
	`account_type` text NOT NULL,
	`repository_selection` text DEFAULT 'all' NOT NULL,
	`suspended_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`github_app_id`) REFERENCES `github_apps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installations_installation_unique` ON `github_installations` (`installation_id`);--> statement-breakpoint
CREATE INDEX `github_installations_app_idx` ON `github_installations` (`github_app_id`);--> statement-breakpoint
CREATE TABLE `github_manifest_flows` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`organization` text,
	`created_by` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `registry_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`server` text NOT NULL,
	`username` text NOT NULL,
	`password_sealed` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `source_polls` (
	`service_id` text PRIMARY KEY NOT NULL,
	`branch` text NOT NULL,
	`last_sha` text,
	`etag` text,
	`checked_at` integer,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`delivery_id` text NOT NULL,
	`event` text NOT NULL,
	`service_id` text,
	`outcome` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`deployment_id` text,
	`received_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_source_delivery_service_unique` ON `webhook_deliveries` (`source`,`delivery_id`,`service_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_service_idx` ON `webhook_deliveries` (`service_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_received_idx` ON `webhook_deliveries` (`received_at`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text DEFAULT 'api' NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`refresh_token_hash` text,
	`actions` text NOT NULL,
	`project_ids` text,
	`read_only` integer DEFAULT false NOT NULL,
	`mcp_client_id` text,
	`expires_at` integer,
	`last_used_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mcp_client_id`) REFERENCES `mcp_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_hash_unique` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_refresh_token_hash_unique` ON `api_keys` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_user_idx` ON `api_keys` (`user_id`);--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`user_id` text,
	`token_hash` text NOT NULL,
	`data` text DEFAULT '{}' NOT NULL,
	`secret_sealed` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_challenges_token_hash_unique` ON `auth_challenges` (`token_hash`);--> statement-breakpoint
CREATE INDEX `auth_challenges_expires_idx` ON `auth_challenges` (`expires_at`);--> statement-breakpoint
CREATE TABLE `cli_login_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`user_code` text NOT NULL,
	`device_code_hash` text NOT NULL,
	`client_name` text NOT NULL,
	`requested_from` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`scope` text,
	`key_id` text,
	`last_polled_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cli_login_user_code_unique` ON `cli_login_requests` (`user_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `cli_login_device_code_unique` ON `cli_login_requests` (`device_code_hash`);--> statement-breakpoint
CREATE TABLE `github_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`github_user_id` integer NOT NULL,
	`login` text NOT NULL,
	`access_token_sealed` text NOT NULL,
	`scopes` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_accounts_github_user_unique` ON `github_accounts` (`github_user_id`);--> statement-breakpoint
CREATE INDEX `github_accounts_user_idx` ON `github_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text NOT NULL,
	`actions` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grants_user_scope_unique` ON `grants` (`user_id`,`scope_type`,`scope_id`);--> statement-breakpoint
CREATE INDEX `grants_scope_idx` ON `grants` (`scope_type`,`scope_id`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`grants` text DEFAULT '[]' NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`accepted_by` text,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invites_email_idx` ON `invites` (`email`);--> statement-breakpoint
CREATE TABLE `mcp_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`sign_count` integer DEFAULT 0 NOT NULL,
	`transports` text DEFAULT '[]' NOT NULL,
	`name` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `recovery_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recovery_codes_user_idx` ON `recovery_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`reauth_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `setup_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_tokens_token_hash_unique` ON `setup_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `totp_secrets` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret_sealed` text NOT NULL,
	`confirmed_at` integer,
	`last_used_step` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'member' NOT NULL,
	`disabled_at` integer,
	`last_login_at` integer,
	`failed_logins` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`preferences` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `join_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`created_by` text,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`node_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `join_tokens_token_hash_unique` ON `join_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`location` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`public_key` blob NOT NULL,
	`facts` text,
	`agent_version` text,
	`can_build` integer DEFAULT false NOT NULL,
	`max_parallel_builds` integer DEFAULT 1 NOT NULL,
	`log_max_bytes_per_service` integer DEFAULT 104857600 NOT NULL,
	`log_max_age_days` integer DEFAULT 14 NOT NULL,
	`desired_revision` integer DEFAULT 0 NOT NULL,
	`wildcard_domain` text,
	`public_ipv4` text,
	`public_ipv6` text,
	`public_address` text,
	`is_panel_node` integer DEFAULT false NOT NULL,
	`games_first_cpu` integer DEFAULT false NOT NULL,
	`health_report` text,
	`health_checked_at` integer,
	`disabled_at` integer,
	`last_seen_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_name_unique` ON `nodes` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `nodes_public_key_unique` ON `nodes` (`public_key`);--> statement-breakpoint
CREATE TABLE `update_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`target_version` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`started_by` text,
	`error` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`started_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `update_runs_created_idx` ON `update_runs` (`created_at`);--> statement-breakpoint
CREATE TABLE `update_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`position` integer NOT NULL,
	`target` text NOT NULL,
	`node_id` text,
	`from_version` text,
	`to_version` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `update_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `update_steps_run_idx` ON `update_steps` (`run_id`,`position`);--> statement-breakpoint
CREATE TABLE `mcp_auth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`actions` text NOT NULL,
	`read_only` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `mcp_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_auth_codes_code_hash_unique` ON `mcp_auth_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `mcp_auth_codes_client_idx` ON `mcp_auth_codes` (`client_id`);--> statement-breakpoint
CREATE TABLE `cloudflare_tunnels` (
	`service_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`mode` text DEFAULT 'quick' NOT NULL,
	`token_sealed` text,
	`url` text,
	`target_port` integer NOT NULL,
	`hostname` text,
	`expires_at` integer,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`host` text NOT NULL,
	`path_prefix` text DEFAULT '/' NOT NULL,
	`strip_prefix` integer DEFAULT false NOT NULL,
	`target_port` integer NOT NULL,
	`https` text DEFAULT 'acme' NOT NULL,
	`redirect_to_https` integer DEFAULT true NOT NULL,
	`certificate_sealed` text,
	`auto` integer DEFAULT false NOT NULL,
	`middlewares` text DEFAULT '{}' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`forward` text,
	`cert_status` text DEFAULT 'none' NOT NULL,
	`cert_expires_at` integer,
	`cert_issuer` text,
	`cert_error` text,
	`dns_status` text DEFAULT 'unknown' NOT NULL,
	`dns_checked_at` integer,
	`live_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_host_path_unique` ON `domains` (`host`,`path_prefix`);--> statement-breakpoint
CREATE INDEX `domains_service_idx` ON `domains` (`service_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `domains_service_primary_unique` ON `domains` (`service_id`) WHERE "domains"."is_primary" = 1;--> statement-breakpoint
CREATE TABLE `maintenance_pages` (
	`service_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`html` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `port_exposures` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`node_id` text NOT NULL,
	`kind` text NOT NULL,
	`mode` text DEFAULT 'forward' NOT NULL,
	`redirect_url` text,
	`listen_port` integer NOT NULL,
	`target_port` integer NOT NULL,
	`allowed_cidrs` text DEFAULT '[]' NOT NULL,
	`tls` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`close_at` integer,
	`created_by` text,
	`opened_via` text DEFAULT 'user' NOT NULL,
	`opened_by_label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `port_exposures_service_idx` ON `port_exposures` (`service_id`);--> statement-breakpoint
CREATE INDEX `port_exposures_node_port_idx` ON `port_exposures` (`node_id`,`listen_port`);--> statement-breakpoint
CREATE TABLE `service_access` (
	`service_id` text PRIMARY KEY NOT NULL,
	`close_when_domain_live` integer DEFAULT true NOT NULL,
	`redirect_to_primary` integer DEFAULT true NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ai_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`context` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ai_conversations_user_idx` ON `ai_conversations` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`model` text,
	`parts` text,
	`approval_id` text,
	`status` text DEFAULT 'done' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_messages_conversation_seq_unique` ON `ai_messages` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`conversation_id` text,
	`model` text NOT NULL,
	`model_id` text DEFAULT '' NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micro_usd` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_idx` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`op_id` text NOT NULL,
	`input_sealed` text NOT NULL,
	`input_preview` text NOT NULL,
	`requested_by_type` text NOT NULL,
	`requested_by_id` text,
	`requested_via` text,
	`reason` text DEFAULT '' NOT NULL,
	`target_type` text,
	`target_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`decision_note` text,
	`error` text,
	`result_preview` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`dedupe_key` text,
	`run_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`last_error` text,
	`locked_at` integer,
	`finished_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `jobs` (`status`,`run_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_dedupe_active_unique` ON `jobs` (`dedupe_key`) WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`job_type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`cron` text,
	`interval_seconds` integer,
	`jitter_seconds` integer DEFAULT 0 NOT NULL,
	`missed_run` text DEFAULT 'runOnce' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedules_key_unique` ON `schedules` (`key`);--> statement-breakpoint
CREATE INDEX `schedules_due_idx` ON `schedules` (`enabled`,`next_run_at`);--> statement-breakpoint
CREATE TABLE `project_prefs` (
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`collapsed` integer DEFAULT false NOT NULL,
	`position` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_prefs_project_idx` ON `project_prefs` (`project_id`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`protected` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_name_key_unique` ON `projects` (`name_key`);--> statement-breakpoint
CREATE TABLE `service_placements` (
	`service_id` text NOT NULL,
	`node_id` text NOT NULL,
	`replicas` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`service_id`, `node_id`),
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `service_placements_node_idx` ON `service_placements` (`node_id`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`kind` text NOT NULL,
	`parent_id` text,
	`spec` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`live_deployment_id` text,
	`target_deployment_id` text,
	`stopped` integer DEFAULT false NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`compose_file_sealed` text,
	`protected` integer DEFAULT false NOT NULL,
	`template_slug` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`parent_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_project_name_unique` ON `services` (`project_id`,`name_key`);--> statement-breakpoint
CREATE INDEX `services_project_idx` ON `services` (`project_id`);--> statement-breakpoint
CREATE INDEX `services_parent_idx` ON `services` (`parent_id`);--> statement-breakpoint
CREATE TABLE `volumes` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`name` text NOT NULL,
	`mount_path` text NOT NULL,
	`kind` text DEFAULT 'volume' NOT NULL,
	`read_only` integer DEFAULT false NOT NULL,
	`owner_service_id` text,
	`content_sealed` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `volumes_service_name_unique` ON `volumes` (`service_id`,`name`);--> statement-breakpoint
CREATE TABLE `agent_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`node_id` text NOT NULL,
	`outbox_id` text NOT NULL,
	`kind` text NOT NULL,
	`event` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_reports_outbox_unique` ON `agent_reports` (`node_id`,`outbox_id`);--> statement-breakpoint
CREATE INDEX `agent_reports_created_idx` ON `agent_reports` (`created_at`);--> statement-breakpoint
CREATE TABLE `crash_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`service_id` text NOT NULL,
	`node_id` text,
	`outbox_id` text NOT NULL,
	`generation` integer NOT NULL,
	`container_id` text NOT NULL,
	`exit_code` integer NOT NULL,
	`oom_killed` integer NOT NULL,
	`streak` integer NOT NULL,
	`action` text NOT NULL,
	`last_lines` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `crash_reports_outbox_unique` ON `crash_reports` (`node_id`,`outbox_id`);--> statement-breakpoint
CREATE INDEX `crash_reports_service_idx` ON `crash_reports` (`service_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `custom_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'Other' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`source` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_templates_slug_unique` ON `custom_templates` (`slug`);