// Panel-wide key/value settings (panel id, domain, auto-update, telemetry,
// branding, theme, AI). Read and write them through src/settings.ts, which
// types every key; modules declare their own keys there by augmenting
// SettingValues. Secrets in a value are sealed strings, never plaintext.

import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { json, updatedAt } from "./columns";

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: updatedAt(),
});
