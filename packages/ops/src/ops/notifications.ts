// Notification channels are defined once (Settings > Notifications) and
// picked by alert rules: panel-wide defaults, and per service on its Alerts
// tab. Channel configs hold webhook URLs and tokens, so they are sealed at
// rest and their secret fields are write-only: reads say which are set.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { AlertRuleEvent, alertRuleEvents } from "./alerts";

export const channelKinds = ["smtp", "webhook", "discord", "slack", "telegram", "ntfy", "pushover", "gotify"] as const;
export type ChannelKind = (typeof channelKinds)[number];
export const ChannelKind = Type.Union(channelKinds.map((kind) => Type.Literal(kind)));

const HttpUrl = Type.String({ maxLength: 2048, pattern: "^https?://[^\\s]+$" });
const Email = Type.String({ format: "email", maxLength: 254 });

/**
 * Channel settings per kind. Secret fields are optional here: on create
 * the handler requires the ones the kind needs; on update an omitted
 * secret keeps its stored value.
 */
export const ChannelConfigInput = Type.Union([
  Type.Object({
    kind: Type.Literal("smtp"),
    host: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    security: Type.Union([Type.Literal("starttls"), Type.Literal("tls"), Type.Literal("none")]),
    username: Type.String({ maxLength: 254 }),
    password: Type.Optional(Type.String({ maxLength: 1024 })),
    from: Email,
    to: Type.Array(Email, { minItems: 1, maxItems: 20 }),
  }),
  Type.Object({
    kind: Type.Literal("webhook"),
    url: HttpUrl,
    /** When set, every request carries an HMAC-SHA256 signature header over the body. */
    signingSecret: Type.Optional(Type.String({ maxLength: 256 })),
  }),
  Type.Object({ kind: Type.Literal("discord"), webhookUrl: Type.Optional(HttpUrl) }),
  Type.Object({ kind: Type.Literal("slack"), webhookUrl: Type.Optional(HttpUrl) }),
  Type.Object({
    kind: Type.Literal("telegram"),
    botToken: Type.Optional(Type.String({ maxLength: 256 })),
    chatId: Type.String({ minLength: 1, maxLength: 64 }),
  }),
  Type.Object({
    kind: Type.Literal("ntfy"),
    /** Defaults to https://ntfy.sh when empty. */
    serverUrl: Type.Optional(HttpUrl),
    topic: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
    accessToken: Type.Optional(Type.String({ maxLength: 256 })),
  }),
  Type.Object({
    kind: Type.Literal("pushover"),
    userKey: Type.Optional(Type.String({ maxLength: 64 })),
    appToken: Type.Optional(Type.String({ maxLength: 64 })),
  }),
  Type.Object({ kind: Type.Literal("gotify"), serverUrl: HttpUrl, appToken: Type.Optional(Type.String({ maxLength: 256 })) }),
]);
export type ChannelConfigInput = Static<typeof ChannelConfigInput>;

/** Paths of secret fields inside `config`, for sensitive declarations and for the handler. */
export const channelSecretFields = ["password", "signingSecret", "webhookUrl", "botToken", "accessToken", "userKey", "appToken"] as const;
const configSecretPaths = channelSecretFields.map((field) => `config.${field}`);

/** The config as reads return it: everything except secret fields. */
export const ChannelConfigView = Type.Union([
  Type.Object({
    kind: Type.Literal("smtp"),
    host: Type.String(),
    port: Type.Integer(),
    security: Type.Union([Type.Literal("starttls"), Type.Literal("tls"), Type.Literal("none")]),
    username: Type.String(),
    from: Type.String(),
    to: Type.Array(Type.String()),
  }),
  Type.Object({ kind: Type.Literal("webhook"), url: Type.String() }),
  Type.Object({ kind: Type.Literal("discord") }),
  Type.Object({ kind: Type.Literal("slack") }),
  Type.Object({ kind: Type.Literal("telegram"), chatId: Type.String() }),
  Type.Object({ kind: Type.Literal("ntfy"), serverUrl: Type.String(), topic: Type.String() }),
  Type.Object({ kind: Type.Literal("pushover") }),
  Type.Object({ kind: Type.Literal("gotify"), serverUrl: Type.String() }),
]);

export const Channel = Type.Object({
  id: Id,
  name: Type.String(),
  kind: ChannelKind,
  enabled: Type.Boolean(),
  /** Picked for new alert rules unless the person chooses otherwise. At most one channel is the default. */
  isDefault: Type.Boolean(),
  config: ChannelConfigView,
  /** Names of the secret fields that hold a value (from channelSecretFields). */
  secretsSet: Type.Array(Type.String()),
  /** Redacted one-line summary for the card, for example "smtp.example.com -> ops@example.com". */
  target: Type.String(),
  /** Services whose own rules use it, and whether the panel defaults use it. */
  usedBy: Type.Object({ services: Type.Integer({ minimum: 0 }), defaults: Type.Boolean() }),
  lastDelivery: Type.Union([
    Type.Object({
      status: Type.Union([Type.Literal("sent"), Type.Literal("failed")]),
      at: Timestamp,
      error: Type.Union([Type.String(), Type.Null()]),
    }),
    Type.Null(),
  ]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type Channel = Static<typeof Channel>;

const ChannelName = Type.String({ minLength: 1, maxLength: 60 });

export const channels = defineOp({
  id: "notifications.channels",
  kind: "query",
  summary: "List notification channels",
  description:
    "Lists every notification channel with a redacted target, which services use it and its last delivery. Secrets are never returned.",
  input: Empty,
  output: Type.Object({ channels: Type.Array(Channel) }),
  // Members pick channels on their services' Alerts tab, so any signed-in person may list them.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const createChannel = defineOp({
  id: "notifications.createChannel",
  kind: "mutation",
  summary: "Create a notification channel",
  description: "Adds a channel (email, webhook, Discord, Slack, Telegram, ntfy, Pushover or Gotify) that alert rules can then use.",
  input: Type.Object({
    name: ChannelName,
    config: ChannelConfigInput,
    enabled: Type.Optional(Type.Boolean()),
    isDefault: Type.Optional(Type.Boolean()),
  }),
  output: Channel,
  permission: permission.global("notifications.manage"),
  sensitive: { input: configSecretPaths },
  mcp: true,
  audit: true,
});

export const updateChannel = defineOp({
  id: "notifications.updateChannel",
  kind: "mutation",
  summary: "Update a notification channel",
  description:
    "Changes a channel's name, settings, enabled flag or default flag. The kind cannot change. Secret fields left out of config keep their stored value.",
  input: Type.Object({
    channelId: Id,
    name: Type.Optional(ChannelName),
    config: Type.Optional(ChannelConfigInput),
    enabled: Type.Optional(Type.Boolean()),
    isDefault: Type.Optional(Type.Boolean()),
  }),
  output: Channel,
  permission: permission.global("notifications.manage"),
  sensitive: { input: configSecretPaths },
  mcp: true,
  audit: true,
});

export const deleteChannel = defineOp({
  id: "notifications.deleteChannel",
  kind: "destructive",
  summary: "Delete a notification channel",
  description: "Deletes a channel and removes it from every alert rule that used it.",
  input: Type.Object({ channelId: Id }),
  output: Empty,
  permission: permission.global("notifications.manage"),
  mcp: true,
  audit: true,
});

export const testChannel = defineOp({
  id: "notifications.testChannel",
  kind: "mutation",
  summary: "Send a test notification",
  description:
    "Sends a test message. Pass channelId to test a saved channel, config to test unsaved settings, or both to test edits (secrets left out come from the saved channel).",
  input: Type.Object({
    channelId: Type.Optional(Id),
    config: Type.Optional(ChannelConfigInput),
  }),
  output: Type.Object({
    ok: Type.Boolean(),
    /** What the receiving service said, safe to show. Null on success. */
    error: Type.Union([Type.String(), Type.Null()]),
    durationMs: Type.Integer({ minimum: 0 }),
  }),
  permission: permission.global("notifications.manage"),
  sensitive: { input: configSecretPaths },
  rateLimit: "strict",
  mcp: true,
  audit: true,
});

// ---------------------------------------------------------------- rules

export const AlertRule = Type.Object({
  event: AlertRuleEvent,
  enabled: Type.Boolean(),
  /** Channels notified for this event; empty with enabled true means feed only. */
  channelIds: Type.Array(Id, { maxItems: 20 }),
});
export type AlertRule = Static<typeof AlertRule>;

/** Every event appears once; events left out of an update are turned off. */
const RuleList = Type.Array(AlertRule, { maxItems: alertRuleEvents.length });

export const defaults = defineOp({
  id: "notifications.defaults",
  kind: "query",
  summary: "Get the default alert rules",
  description:
    "Returns the panel-wide alert rules: which events notify which channels. Services use these unless they set their own; node, update and approval events are only configured here.",
  input: Empty,
  output: Type.Object({ rules: RuleList }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const updateDefaults = defineOp({
  id: "notifications.updateDefaults",
  kind: "mutation",
  summary: "Update the default alert rules",
  description: "Replaces the panel-wide alert rules. Each event appears at most once; events left out are turned off.",
  input: Type.Object({ rules: RuleList }),
  output: Type.Object({ rules: RuleList }),
  permission: permission.global("notifications.manage"),
  mcp: true,
  audit: true,
});

export const serviceAlerts = defineOp({
  id: "notifications.serviceAlerts",
  kind: "query",
  summary: "Get a service's alert rules",
  description:
    "Returns whether a service uses the default alert rules or its own, the rules in effect and the defaults for comparison. Only service events (serviceAlertEvents) apply here.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    useDefaults: Type.Boolean(),
    rules: RuleList,
    defaults: RuleList,
  }),
  permission: permission.service("services.view", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: false,
});

export const updateServiceAlerts = defineOp({
  id: "notifications.updateServiceAlerts",
  kind: "mutation",
  summary: "Set a service's alert rules",
  description:
    "Makes a service follow the default alert rules (useDefaults true) or use its own (useDefaults false with rules). Rules for non-service events are refused.",
  input: Type.Object({
    serviceId: Id,
    useDefaults: Type.Boolean(),
    rules: Type.Optional(RuleList),
  }),
  output: Type.Object({ useDefaults: Type.Boolean(), rules: RuleList, defaults: RuleList }),
  permission: permission.service("services.alerts", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: true,
});
