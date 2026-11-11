// Uptime checks: the panel requests a URL on an interval (status code,
// optional keyword in the body, optional latency limit) and alerts
// "uptime_down" after failureThreshold misses in a row. Every check
// belongs to a service (its domains are the usual targets), so service
// grants cover them. Samples are kept in metrics.db.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

export const UptimeStatus = Type.Union([
  Type.Literal("up"),
  Type.Literal("down"),
  /** Created or re-enabled, no result yet. */
  Type.Literal("pending"),
  Type.Literal("paused"),
]);
export type UptimeStatus = Static<typeof UptimeStatus>;

export const CheckName = Type.String({ minLength: 1, maxLength: 60 });
export const CheckUrl = Type.String({ maxLength: 2048, pattern: "^https?://[^\\s]+$" });
export const Method = Type.Union([Type.Literal("GET"), Type.Literal("HEAD")]);
/** Text the response body must contain (GET only); null skips the check. */
export const Keyword = Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]);
/** Answers slower than this count as failures; null means only the timeout applies. */
export const MaxLatency = Type.Union([Type.Integer({ minimum: 1, maximum: 60_000 }), Type.Null()]);

export const CheckSettings = {
  name: CheckName,
  url: CheckUrl,
  method: Method,
  /** Expected HTTP status; 0 accepts any 2xx or 3xx. */
  expectedStatus: Type.Integer({ minimum: 0, maximum: 599 }),
  intervalSeconds: Type.Integer({ minimum: 30, maximum: 86_400 }),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 60_000 }),
  failureThreshold: Type.Integer({ minimum: 1, maximum: 10 }),
  keyword: Keyword,
  maxLatencyMs: MaxLatency,
  enabled: Type.Boolean(),
};

export const UptimeCheck = Type.Object({
  id: Id,
  serviceId: Id,
  projectId: Id,
  ...CheckSettings,
  status: UptimeStatus,
  /** When the current up or down streak started; null while pending. */
  statusSince: Type.Union([Timestamp, Type.Null()]),
  lastCheckedAt: Type.Union([Timestamp, Type.Null()]),
  lastStatusCode: Type.Union([Type.Integer(), Type.Null()]),
  lastLatencyMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /** Last failure reason, for example "timeout after 10000 ms" or "status 502". */
  lastError: Type.Union([Type.String(), Type.Null()]),
  /** Share of successful samples in the last 24 hours, 0-100; null with no samples. */
  uptime24h: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type UptimeCheck = Static<typeof UptimeCheck>;

const byService = (input: { serviceId: string }) => input.serviceId;

export const list = defineOp({
  id: "uptime.list",
  kind: "query",
  summary: "List uptime checks",
  description:
    "Lists uptime checks with their current status and 24-hour uptime. With serviceId, only that service's checks; without, every check the caller can see.",
  input: Type.Object({ serviceId: Type.Optional(Id) }),
  output: Type.Object({ checks: Type.Array(UptimeCheck) }),
  // Filtered by services.view in the handler, since serviceId is optional.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const status = defineOp({
  id: "uptime.status",
  kind: "query",
  summary: "Count uptime checks by status",
  description: "Returns how many of the checks the caller can see are up, down, pending and paused, for the dashboard.",
  input: Empty,
  output: Type.Object({
    up: Type.Integer({ minimum: 0 }),
    down: Type.Integer({ minimum: 0 }),
    pending: Type.Integer({ minimum: 0 }),
    paused: Type.Integer({ minimum: 0 }),
  }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const create = defineOp({
  id: "uptime.create",
  kind: "mutation",
  summary: "Create an uptime check",
  description: "Adds an uptime check to a service. The first request runs right away.",
  input: Type.Object({
    serviceId: Id,
    name: CheckName,
    url: CheckUrl,
    method: Type.Optional(Method),
    expectedStatus: Type.Optional(CheckSettings.expectedStatus),
    intervalSeconds: Type.Optional(CheckSettings.intervalSeconds),
    timeoutMs: Type.Optional(CheckSettings.timeoutMs),
    failureThreshold: Type.Optional(CheckSettings.failureThreshold),
    keyword: Type.Optional(Keyword),
    maxLatencyMs: Type.Optional(MaxLatency),
    enabled: Type.Optional(Type.Boolean()),
  }),
  output: UptimeCheck,
  permission: permission.service("services.alerts", byService),
  mcp: true,
  audit: true,
});

export const update = defineOp({
  id: "uptime.update",
  kind: "mutation",
  summary: "Update an uptime check",
  description: "Changes an uptime check's settings or pauses it (enabled false). Omitted fields keep their value.",
  input: Type.Object({
    serviceId: Id,
    checkId: Id,
    name: Type.Optional(CheckName),
    url: Type.Optional(CheckUrl),
    method: Type.Optional(Method),
    expectedStatus: Type.Optional(CheckSettings.expectedStatus),
    intervalSeconds: Type.Optional(CheckSettings.intervalSeconds),
    timeoutMs: Type.Optional(CheckSettings.timeoutMs),
    failureThreshold: Type.Optional(CheckSettings.failureThreshold),
    keyword: Type.Optional(Keyword),
    maxLatencyMs: Type.Optional(MaxLatency),
    enabled: Type.Optional(Type.Boolean()),
  }),
  output: UptimeCheck,
  permission: permission.service("services.alerts", byService),
  mcp: true,
  audit: true,
});

export const remove = defineOp({
  id: "uptime.delete",
  kind: "destructive",
  summary: "Delete an uptime check",
  description: "Deletes an uptime check and its history.",
  input: Type.Object({ serviceId: Id, checkId: Id }),
  output: Empty,
  permission: permission.service("services.alerts", byService),
  mcp: true,
  audit: true,
});

export const UptimeRange = Type.Union([Type.Literal("1h"), Type.Literal("24h"), Type.Literal("7d"), Type.Literal("30d")]);

export const history = defineOp({
  id: "uptime.history",
  kind: "query",
  summary: "Get uptime history",
  description:
    "Returns a check's samples for a range as a series for the chart (raw samples for 1h and 24h, hourly buckets for 7d and 30d), plus uptime percent, average latency and the down periods.",
  input: Type.Object({ serviceId: Id, checkId: Id, range: UptimeRange }),
  output: Type.Object({
    range: UptimeRange,
    /** Bucket width in seconds; 0 for raw samples. */
    bucketSeconds: Type.Integer({ minimum: 0 }),
    points: Type.Array(
      Type.Object({
        at: Timestamp,
        /** Raw samples: 1 or 0. Buckets: share of successful samples, 0-1. */
        ok: Type.Number({ minimum: 0, maximum: 1 }),
        latencyMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
        statusCode: Type.Union([Type.Integer(), Type.Null()]),
      }),
    ),
    uptimePercent: Type.Union([Type.Number({ minimum: 0, maximum: 100 }), Type.Null()]),
    avgLatencyMs: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
    incidents: Type.Array(Type.Object({ from: Timestamp, to: Type.Union([Timestamp, Type.Null()]), error: Type.String() })),
  }),
  permission: permission.service("services.view", byService),
  mcp: true,
  audit: false,
});
