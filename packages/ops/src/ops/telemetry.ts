// Anonymous usage reports, opt-in (settings.updateTelemetry). The preview
// shows the exact payload the next report would carry, so people can read
// what leaves their panel before they switch it on.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Timestamp } from "../schemas";

/**
 * One report, exactly the shape the collector accepts (it drops anything
 * else): a random install id, the panel version and two counts. No names,
 * hostnames, IPs, emails or ids of things.
 */
export const TelemetryPayload = Type.Object({
  /** Random per-install id (settings.telemetry installId), 16-64 of [A-Za-z0-9_-]. */
  installId: Type.String({ minLength: 16, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" }),
  /** Panel version. */
  version: Type.String(),
  /** Nodes the panel manages. */
  nodes: Type.Integer({ minimum: 0 }),
  /** Services in total. */
  services: Type.Integer({ minimum: 0 }),
});
export type TelemetryPayload = Static<typeof TelemetryPayload>;

export const preview = defineOp({
  id: "telemetry.preview",
  kind: "query",
  summary: "Preview the telemetry report",
  description:
    "Returns the exact JSON the next anonymous usage report would send, where it goes and how often, whether or not telemetry is on.",
  input: Empty,
  output: Type.Object({
    enabled: Type.Boolean(),
    /** Collector URL, from the brand's site. */
    endpoint: Type.String(),
    intervalHours: Type.Integer({ minimum: 1 }),
    nextSendAt: Type.Union([Timestamp, Type.Null()]),
    payload: TelemetryPayload,
  }),
  permission: permission.global("settings.view"),
  mcp: false,
  audit: false,
});
