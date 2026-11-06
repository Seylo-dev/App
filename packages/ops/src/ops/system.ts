// Panel-wide facts shown on the dashboard and in the sidebar, the build
// version and which optional features are switched on.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Timestamp } from "../schemas";

export const SystemInfo = Type.Object({
  name: Type.String({ description: "Product name, from the brand or white-label settings." }),
  version: Type.String(),
  panelId: Type.String({ description: "Stable id of this panel installation." }),
  startedAt: Timestamp,
  nodes: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    online: Type.Integer({ minimum: 0 }),
  }),
});

export const info = defineOp({
  id: "system.info",
  kind: "query",
  summary: "Get panel information",
  description: "Returns the panel's name, version and id, and how many of its nodes are online.",
  input: Empty,
  output: SystemInfo,
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const SystemVersion = Type.Object({
  /** Panel release, "dev" for local builds. */
  version: Type.String(),
  /** Agent <-> panel protocol major version, for example "v1". */
  protocol: Type.String(),
  /** What the panel runs on, for troubleshooting. */
  runtime: Type.Object({ bun: Type.String(), platform: Type.String(), arch: Type.String() }),
  startedAt: Timestamp,
  uptimeSeconds: Type.Integer({ minimum: 0 }),
});

export const version = defineOp({
  id: "system.version",
  kind: "query",
  summary: "Get the panel version",
  description:
    "Returns the panel release, the agent protocol version and the runtime. Whether an update is available comes from the updates module.",
  input: Empty,
  output: SystemVersion,
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

/**
 * Optional features the web app shows or hides. Each says whether it is
 * usable now and, when it is not, why (shown next to the disabled control).
 */
export const featureNames = ["githubSignIn", "passkeys", "mcp", "ai", "telemetry", "notifications"] as const;
export type FeatureName = (typeof featureNames)[number];

export const FeatureState = Type.Object({
  enabled: Type.Boolean(),
  /** Why it is off, for example "Set a panel domain first." Empty when enabled. */
  reason: Type.String(),
});

export const SystemFeatures = Type.Object({
  githubSignIn: FeatureState,
  passkeys: FeatureState,
  mcp: FeatureState,
  ai: FeatureState,
  telemetry: FeatureState,
  /** At least one enabled notification channel exists. */
  notifications: FeatureState,
});

export const features = defineOp({
  id: "system.features",
  kind: "query",
  summary: "List optional features",
  description:
    "Says which optional features are usable on this panel (GitHub sign-in, passkeys, MCP, AI assistant, telemetry, notification channels) and, for each one that is off, why.",
  input: Empty,
  output: SystemFeatures,
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});
