// Channel storage: the whole config (secrets included) is sealed in one
// column; reads return the config without secrets plus the names of the
// secrets that are set. Updates keep stored secrets the caller left out.

import { notifications as notificationOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, sql } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { alertRules, notificationChannels, notificationDeliveries } from "../../db/schema";
import type { SecretBox } from "../../security/secret-box";
import type { ChannelConfig } from "./senders";

type ChannelRow = typeof notificationChannels.$inferSelect;
type ChannelView = Static<typeof notificationOps.Channel>;
type ConfigView = Static<typeof notificationOps.ChannelConfigView>;

const secretFields = notificationOps.channelSecretFields;

/** Secrets each kind cannot work without; checked on create and before a test send. */
const requiredSecrets: Partial<Record<ChannelConfig["kind"], readonly (typeof secretFields)[number][]>> = {
  discord: ["webhookUrl"],
  slack: ["webhookUrl"],
  telegram: ["botToken"],
  pushover: ["userKey", "appToken"],
  gotify: ["appToken"],
};

export function sealConfig(secrets: SecretBox, config: ChannelConfig): string {
  return secrets.seal(JSON.stringify(config), "notification.channel");
}

export function openConfig(secrets: SecretBox, row: Pick<ChannelRow, "configSealed">): ChannelConfig {
  const plain = secrets.open(row.configSealed, "notification.channel");
  if (!plain) throw new OpError("INTERNAL", "This channel's settings cannot be read. Delete it and add it again.");
  return JSON.parse(plain) as ChannelConfig;
}

/** Fills secrets the caller left out from the stored config of the same kind. */
export function mergeSecrets(next: ChannelConfig, stored: ChannelConfig | null): ChannelConfig {
  if (!stored || stored.kind !== next.kind) return next;
  const merged: Record<string, unknown> = { ...next };
  for (const field of secretFields) {
    if (merged[field] === undefined && field in stored) merged[field] = (stored as Record<string, unknown>)[field];
  }
  return merged as ChannelConfig;
}

export function checkComplete(config: ChannelConfig): void {
  for (const field of requiredSecrets[config.kind] ?? []) {
    if (!(config as Record<string, unknown>)[field]) {
      throw new OpError("BAD_REQUEST", `A ${config.kind} channel needs ${field}.`, { field: `config.${field}` });
    }
  }
  if (config.kind === "smtp" && config.username && config.password === undefined) {
    throw new OpError("BAD_REQUEST", "Set the SMTP password, or leave the username empty for a server without sign-in.", {
      field: "config.password",
    });
  }
}

export function configView(config: ChannelConfig): ConfigView {
  switch (config.kind) {
    case "smtp":
      return {
        kind: "smtp",
        host: config.host,
        port: config.port,
        security: config.security,
        username: config.username,
        from: config.from,
        to: config.to,
      };
    case "webhook":
      return { kind: "webhook", url: redactUrl(config.url) };
    case "discord":
    case "slack":
    case "pushover":
      return { kind: config.kind };
    case "telegram":
      return { kind: "telegram", chatId: config.chatId };
    case "ntfy":
      return { kind: "ntfy", serverUrl: config.serverUrl || "https://ntfy.sh", topic: config.topic };
    case "gotify":
      return { kind: "gotify", serverUrl: config.serverUrl };
  }
}

/**
 * Keeps scheme and host only. Credentials, the query and the path go: catch
 * hooks (Zapier, Make, n8n, chat bridges) carry their secret in the path.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname && parsed.pathname !== "/" ? "/..." : "";
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return "";
  }
}

/**
 * What a person without notifications.manage sees of a channel config: the
 * kind and, for URLs, the host. An ntfy topic is the whole credential of a
 * public topic; recipients, accounts and chat ids are not theirs to read.
 */
export function publicConfigView(config: ChannelConfig): ConfigView {
  switch (config.kind) {
    case "smtp":
      return { kind: "smtp", host: "", port: 0, security: config.security, username: "", from: "", to: [] };
    case "webhook":
      return { kind: "webhook", url: redactUrl(config.url) };
    case "telegram":
      return { kind: "telegram", chatId: "" };
    case "ntfy":
      return { kind: "ntfy", serverUrl: redactUrl(config.serverUrl || "https://ntfy.sh"), topic: "" };
    case "gotify":
      return { kind: "gotify", serverUrl: redactUrl(config.serverUrl) };
    default:
      return configView(config);
  }
}

export function targetSummary(config: ChannelConfig): string {
  switch (config.kind) {
    case "smtp":
      return `${config.host} -> ${config.to.join(", ")}`;
    case "webhook":
      return redactUrl(config.url);
    case "discord":
      return "Discord webhook";
    case "slack":
      return "Slack webhook";
    case "telegram":
      return `Telegram chat ${config.chatId}`;
    case "ntfy":
      return `${redactUrl(config.serverUrl || "https://ntfy.sh")} topic ${config.topic}`;
    case "pushover":
      return "Pushover";
    case "gotify":
      return redactUrl(config.serverUrl);
  }
}

export function secretsSet(config: ChannelConfig): string[] {
  return secretFields.filter((field) => Boolean((config as Record<string, unknown>)[field]));
}

/** Rows referencing a channel: how many services use it, and whether the panel defaults do. */
function usage(db: PanelDb, channelId: string): { services: number; defaults: boolean } {
  const rows = db
    .select({ scopeType: alertRules.scopeType, scopeId: alertRules.scopeId })
    .from(alertRules)
    .where(sql`exists (select 1 from json_each(${alertRules.channelIds}) where value = ${channelId})`)
    .all();
  const services = new Set(rows.filter((r) => r.scopeType === "service").map((r) => r.scopeId));
  return { services: services.size, defaults: rows.some((r) => r.scopeType === "global") };
}

/** `full` for people who manage channels; others get names and kinds for their alert rules only. */
export function toChannelView(db: PanelDb, secrets: SecretBox, row: ChannelRow, full = true): ChannelView {
  const config = openConfig(secrets, row);
  if (!full) {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      enabled: row.enabled,
      isDefault: row.isDefault,
      config: publicConfigView(config),
      secretsSet: [],
      target: "",
      usedBy: usage(db, row.id),
      lastDelivery: null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  const last = db
    .select({ status: notificationDeliveries.status, at: notificationDeliveries.createdAt, error: notificationDeliveries.error })
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.channelId, row.id))
    .orderBy(desc(notificationDeliveries.createdAt))
    .limit(1)
    .get();
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    isDefault: row.isDefault,
    config: configView(config),
    secretsSet: secretsSet(config),
    target: targetSummary(config),
    usedBy: usage(db, row.id),
    lastDelivery: last ? { status: last.status, at: last.at.toISOString(), error: last.error ?? null } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function getChannelRow(db: PanelDb, channelId: string): ChannelRow {
  const row = db.select().from(notificationChannels).where(eq(notificationChannels.id, channelId)).get();
  if (!row) throw new OpError("NOT_FOUND", "There is no such notification channel.");
  return row;
}

/** Keeps at most one default channel. Call inside the transaction that sets `channelId` as default. */
export function clearOtherDefaults(db: PanelDb, channelId: string): void {
  db.update(notificationChannels)
    .set({ isDefault: false })
    .where(and(eq(notificationChannels.isDefault, true), sql`${notificationChannels.id} != ${channelId}`))
    .run();
}
