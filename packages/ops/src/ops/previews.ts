// PR previews: every open pull request on a GitHub-connected service gets
// its own preview service in the same project, deployed on each push and
// deleted when the PR closes. Previews share the service's environment,
// so they talk to the same database: enabling them needs an explicit
// acknowledgement of that.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { DeploymentStatus } from "./deployments";

export const PreviewSettings = Type.Object({
  enabled: Type.Boolean(),
  /** Domain pattern for previews; {pr} and {service} are replaced. "" = automatic wildcard domain. */
  domainPattern: Type.String({ maxLength: 253 }),
  /** Most open previews at once; older ones are removed first. */
  maxPreviews: Type.Integer({ minimum: 1, maximum: 50 }),
});

export const Preview = Type.Object({
  id: Id,
  prNumber: Type.Integer({ minimum: 1 }),
  prTitle: Type.String(),
  branch: Type.String(),
  commitSha: Type.Union([Type.String(), Type.Null()]),
  /** The preview's own service; null after it was removed. */
  previewServiceId: Type.Union([Id, Type.Null()]),
  url: Type.Union([Type.String(), Type.Null()]),
  /** Status of the preview's latest deployment; null before the first one. */
  status: Type.Union([DeploymentStatus, Type.Null()]),
  closedAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Timestamp,
});

const serviceScope = (input: { serviceId: string }) => input.serviceId;

export const getSettings = defineOp({
  id: "previews.getSettings",
  kind: "query",
  summary: "Get a service's PR preview settings",
  description:
    "Returns whether PR previews are on for a service, their domain pattern and limit, and whether the service can have them at all (only GitHub sources can).",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    settings: PreviewSettings,
    available: Type.Boolean(),
    /** Why previews are unavailable, when they are. */
    unavailableReason: Type.Union([Type.String(), Type.Null()]),
  }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const updateSettings = defineOp({
  id: "previews.updateSettings",
  kind: "mutation",
  summary: "Turn PR previews on or off",
  description:
    "Turns PR previews on or off and sets their domain pattern and limit. Previews use the same environment as the service, so they reach the same database: turning them on requires acknowledgeSharedEnv true. Turning them off removes open previews.",
  input: Type.Object({
    serviceId: Id,
    enabled: Type.Optional(Type.Boolean()),
    domainPattern: Type.Optional(Type.String({ maxLength: 253 })),
    maxPreviews: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    /** Must be true to turn previews on: same environment = same database. */
    acknowledgeSharedEnv: Type.Optional(Type.Boolean()),
  }),
  output: PreviewSettings,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const list = defineOp({
  id: "previews.list",
  kind: "query",
  summary: "List a service's PR previews",
  description: "Lists the PR previews of a service, open ones first, with PR, branch, URL and the status of their latest deploy.",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({ previews: Type.Array(Preview) }),
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const remove = defineOp({
  id: "previews.delete",
  kind: "destructive",
  summary: "Delete a PR preview",
  description:
    "Deletes a PR preview's service with its containers and volumes. The next push to the PR creates it again while previews are on.",
  input: Type.Object({ serviceId: Id, previewId: Id }),
  output: Empty,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});
