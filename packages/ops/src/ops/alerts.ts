// The alert feed (dashboard "Alerts" card, service Alerts tab) and mutes.
// An alert is one thing that happened; notifications.* decides who hears
// about it. Event names are shared with the alert rules.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

/**
 * Events people can route to channels (notifications rules). Stored in
 * rows: never rename one.
 */
export const alertRuleEvents = [
  "crash",
  "crash_limit",
  "deploy_failed",
  "deploy_succeeded",
  "build_failed",
  "health_unhealthy",
  "certificate_failed",
  "uptime_down",
  "backup_failed",
  "cron_failed",
  "node_offline",
  "node_health_check_failed",
  "disk_low",
  "cleanup_ran",
  "cleanup_failed",
  "update_available",
  "update_failed",
  "approval_requested",
  "security_change",
] as const;

/** Events that only appear in the feed, as the good news after a problem. */
export const alertFeedOnlyEvents = ["node_online", "uptime_up", "health_recovered", "domain_live"] as const;

export const alertEvents = [...alertRuleEvents, ...alertFeedOnlyEvents] as const;
export type AlertEventName = (typeof alertEvents)[number];
export type AlertRuleEventName = (typeof alertRuleEvents)[number];

export const AlertEvent = Type.Union(alertEvents.map((event) => Type.Literal(event)));
export const AlertRuleEvent = Type.Union(alertRuleEvents.map((event) => Type.Literal(event)));

/** Events a service can set its own rules for; the rest are panel-wide (nodes, updates, approvals). */
export const serviceAlertEvents = [
  "crash",
  "crash_limit",
  "deploy_failed",
  "deploy_succeeded",
  "build_failed",
  "health_unhealthy",
  "certificate_failed",
  "uptime_down",
  "backup_failed",
  "cron_failed",
] as const satisfies readonly AlertRuleEventName[];

/** Dot color on the dashboard: error red, warning amber, info blue, ok green. */
export const AlertSeverity = Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info"), Type.Literal("ok")]);
export type AlertSeverity = Static<typeof AlertSeverity>;

export const Alert = Type.Object({
  id: Id,
  event: AlertEvent,
  severity: AlertSeverity,
  /** Short line, for example "worker crashed". */
  title: Type.String(),
  /** One line of detail, for example "Exit 137, out of memory - restarted after 5s". */
  message: Type.String(),
  projectId: Type.Union([Id, Type.Null()]),
  serviceId: Type.Union([Id, Type.Null()]),
  nodeId: Type.Union([Id, Type.Null()]),
  /** Where "open" goes in the web app, for example the crash report or the deploy. */
  link: Type.Union([Type.String(), Type.Null()]),
  /** Set when a later event closed the incident (node back online, uptime up). */
  resolvedAt: Type.Union([Timestamp, Type.Null()]),
  /** True when a mute matched, so no channel was notified. */
  muted: Type.Boolean(),
  createdAt: Timestamp,
});
export type Alert = Static<typeof Alert>;

export const list = defineOp({
  id: "alerts.list",
  kind: "query",
  summary: "List recent alerts",
  description:
    "Lists alerts newest first, limited to the projects, services and nodes the caller can see. Filter by project, service or node; page with the nextCursor of the previous call.",
  input: Type.Object({
    projectId: Type.Optional(Id),
    serviceId: Type.Optional(Id),
    nodeId: Type.Optional(Id),
    unresolvedOnly: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    cursor: Type.Optional(Type.String({ maxLength: 64 })),
  }),
  output: Type.Object({ alerts: Type.Array(Alert), nextCursor: Type.Union([Type.String(), Type.Null()]) }),
  // The handler filters to what the caller holds services.view / nodes.view on.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const MuteScope = Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("service"), Type.Literal("node")]);

export const Mute = Type.Object({
  id: Id,
  scopeType: MuteScope,
  /** Null for global mutes. */
  scopeId: Type.Union([Id, Type.Null()]),
  /** Null mutes every event in the scope. */
  event: Type.Union([AlertEvent, Type.Null()]),
  /** Null mutes until someone unmutes. */
  until: Type.Union([Timestamp, Type.Null()]),
  reason: Type.String(),
  createdBy: Type.Union([Id, Type.Null()]),
  createdAt: Timestamp,
});

export const mutes = defineOp({
  id: "alerts.mutes",
  kind: "query",
  summary: "List alert mutes",
  description: "Lists the mutes that are still in effect. Muted alerts still appear in the feed, marked muted, but no channel is notified.",
  input: Empty,
  output: Type.Object({ mutes: Type.Array(Mute) }),
  permission: permission.global("alerts.manage"),
  mcp: true,
  audit: false,
});

export const mute = defineOp({
  id: "alerts.mute",
  kind: "mutation",
  summary: "Mute alerts",
  description:
    "Stops notifications for a scope (everything, a project, a service or a node), optionally for one event only and until a time. Alerts keep being recorded in the feed.",
  input: Type.Object({
    scopeType: MuteScope,
    scopeId: Type.Optional(Id),
    event: Type.Optional(AlertEvent),
    until: Type.Optional(Timestamp),
    reason: Type.Optional(Type.String({ maxLength: 200 })),
  }),
  output: Mute,
  permission: permission.global("alerts.manage"),
  mcp: true,
  audit: true,
});

export const unmute = defineOp({
  id: "alerts.unmute",
  kind: "mutation",
  summary: "Remove a mute",
  description: "Ends a mute now so its scope notifies again.",
  input: Type.Object({ muteId: Id }),
  output: Empty,
  permission: permission.global("alerts.manage"),
  mcp: true,
  audit: true,
});
