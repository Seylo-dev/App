// Grants: what a member may do on one project (which covers its services)
// or one service, as a list of permission actions. Owners and admins need
// no grants. Someone holding grants.manage on a project or service can
// share it, but only with actions they hold there themselves.
//
// Set and remove come per scope kind, because a permission names one
// resource kind and the pipeline checks it before the handler runs.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { ActionList, Grant } from "../people";
import { permission } from "../permission";
import { Empty, Id } from "../schemas";

/** A grant with the person it belongs to, for the project and service sharing lists. */
export const GrantWithUser = Type.Object({
  grant: Grant,
  user: Type.Object({ id: Id, email: Type.String(), name: Type.String() }),
});

export const listByProject = defineOp({
  id: "grants.listByProject",
  kind: "query",
  summary: "List who has access to a project",
  description:
    "Lists the grants on a project and on each of its services, with the person each belongs to. Owners and admins are not listed; they always have access.",
  input: Type.Object({ projectId: Id }),
  output: Type.Object({ grants: Type.Array(GrantWithUser) }),
  permission: permission.project("grants.view", (input: { projectId: string }) => input.projectId),
  mcp: true,
  audit: false,
});

export const listByService = defineOp({
  id: "grants.listByService",
  kind: "query",
  summary: "List who has access to a service",
  description: "Lists the grants on a service and the project grants that also cover it (inherited is true for those).",
  input: Type.Object({ serviceId: Id }),
  output: Type.Object({
    grants: Type.Array(Type.Composite([GrantWithUser, Type.Object({ inherited: Type.Boolean() })])),
  }),
  permission: permission.service("grants.view", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: false,
});

export const listByUser = defineOp({
  id: "grants.listByUser",
  kind: "query",
  summary: "List a person's grants",
  description: "Lists every grant one person holds, with project and service names.",
  input: Type.Object({ userId: Id }),
  output: Type.Object({ grants: Type.Array(Grant) }),
  permission: permission.global("users.view"),
  mcp: true,
  audit: false,
});

export const mine = defineOp({
  id: "grants.mine",
  kind: "query",
  summary: "List your own grants",
  description: "Lists the signed-in person's grants, so the web app can hide what they cannot do. Empty for owners and admins.",
  input: Empty,
  output: Type.Object({ grants: Type.Array(Grant) }),
  permission: permission.signedIn(),
  mcp: false,
  audit: false,
});

export const setOnProject = defineOp({
  id: "grants.setOnProject",
  kind: "mutation",
  summary: "Set a person's access to a project",
  description:
    "Creates or replaces one member's grant on a project with the given actions (it covers the project's services). Only actions you hold on the project yourself.",
  input: Type.Object({ projectId: Id, userId: Id, actions: ActionList }),
  output: Grant,
  permission: permission.project("grants.manage", (input: { projectId: string }) => input.projectId),
  mcp: false,
  audit: true,
});

export const setOnService = defineOp({
  id: "grants.setOnService",
  kind: "mutation",
  summary: "Set a person's access to a service",
  description:
    "Creates or replaces one member's grant on a single service with the given actions. Only actions you hold on the service yourself.",
  input: Type.Object({ serviceId: Id, userId: Id, actions: ActionList }),
  output: Grant,
  permission: permission.service("grants.manage", (input: { serviceId: string }) => input.serviceId),
  mcp: false,
  audit: true,
});

export const removeFromProject = defineOp({
  id: "grants.removeFromProject",
  kind: "mutation",
  summary: "Remove a person's access to a project",
  description: "Deletes one member's grant on a project. Their grants on single services in it stay.",
  input: Type.Object({ projectId: Id, userId: Id }),
  output: Empty,
  permission: permission.project("grants.manage", (input: { projectId: string }) => input.projectId),
  mcp: false,
  audit: true,
});

export const removeFromService = defineOp({
  id: "grants.removeFromService",
  kind: "mutation",
  summary: "Remove a person's access to a service",
  description: "Deletes one member's grant on a single service. A grant on the whole project still covers it.",
  input: Type.Object({ serviceId: Id, userId: Id }),
  output: Empty,
  permission: permission.service("grants.manage", (input: { serviceId: string }) => input.serviceId),
  mcp: false,
  audit: true,
});
