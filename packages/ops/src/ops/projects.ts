// Projects group services and own a private network on every node they use.
// Collapsed state (in the sidebar and on the home page, each on its own) and
// the order are per person.

import { Type } from "@sinclair/typebox";
import { avatarMaxBytes } from "../avatars";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";

export const ProjectName = Type.String({
  minLength: 1,
  maxLength: 40,
  pattern: "^[A-Za-z0-9][A-Za-z0-9 ._-]*$",
  description: "Shown in the sidebar; unique, case-insensitive.",
});

export const Project = Type.Object({
  id: Id,
  name: ProjectName,
  description: Type.String({ maxLength: 500 }),
  /** The Panel project runs the panel itself and cannot be deleted. */
  protected: Type.Boolean(),
  serviceCount: Type.Integer({ minimum: 0 }),
  /** Distinct nodes its services run on. */
  nodeCount: Type.Integer({ minimum: 0 }),
  /** People with a grant on the project or one of its services. */
  guestCount: Type.Integer({ minimum: 0 }),
  /** Docker network of the project on each node, for example "seylo-p-<id>". */
  networkName: Type.String(),
  /** Collapsed in the caller's sidebar. Before 0.2.16 it also folded the project on the home page. */
  collapsed: Type.Boolean(),
  /**
   * Collapsed on the caller's home page (the dashboard's Cards and List
   * views), apart from the sidebar. New in 0.2.16; the update copied
   * `collapsed` into it.
   */
  dashboardCollapsed: Type.Boolean(),
  /** Place in the caller's sidebar order; null = not ordered yet (sorted by name after the ordered ones). */
  position: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  /** The project's uploaded image (/api/avatars/project/...); null shows its initial. New in 0.2.6. */
  imageUrl: Type.Union([Type.String({ maxLength: 200 }), Type.Null()]),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const list = defineOp({
  id: "projects.list",
  kind: "query",
  summary: "List projects",
  description:
    "Lists the projects the caller can see in the caller's own order (then by name), with service, node and guest counts and whether each is collapsed in the caller's sidebar (collapsed) and on their home page (dashboardCollapsed).",
  input: Empty,
  output: Type.Object({ projects: Type.Array(Project) }),
  // Signed-in is enough to call it: the handler only returns projects the
  // caller holds projects.view on.
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const get = defineOp({
  id: "projects.get",
  kind: "query",
  summary: "Get a project",
  description: "Returns one project by id.",
  input: Type.Object({ projectId: Id }),
  output: Project,
  permission: permission.project("projects.view", (input: { projectId: string }) => input.projectId),
  mcp: true,
  audit: false,
});

export const create = defineOp({
  id: "projects.create",
  kind: "mutation",
  summary: "Create a project",
  description: "Creates an empty project. Services are added to it afterwards.",
  input: Type.Object({
    name: ProjectName,
    description: Type.Optional(Type.String({ maxLength: 500 })),
  }),
  output: Project,
  permission: permission.global("projects.create"),
  mcp: true,
  audit: true,
});

export const remove = defineOp({
  id: "projects.delete",
  kind: "destructive",
  summary: "Delete a project",
  description:
    "Deletes an empty project. Fails while the project still has services, and for the protected Panel project. The caller repeats the project name to confirm.",
  input: Type.Object({
    projectId: Id,
    confirmName: Type.String({ description: "Must equal the project's name." }),
  }),
  output: Empty,
  permission: permission.project("projects.delete", (input: { projectId: string }) => input.projectId),
  mcp: true,
  audit: true,
});

export const update = defineOp({
  id: "projects.update",
  kind: "mutation",
  summary: "Rename or describe a project",
  description:
    "Changes a project's name or description. Omitted fields keep their value. The protected Panel project can be described but not renamed.",
  input: Type.Object({
    projectId: Id,
    name: Type.Optional(ProjectName),
    description: Type.Optional(Type.String({ maxLength: 500 })),
  }),
  output: Project,
  permission: permission.project("projects.update", (input: { projectId: string }) => input.projectId),
  mcp: true,
  audit: true,
});

/** About 1 MiB as base64, plus the data URL's head (the same rule as avatars.upload). */
const imageDataUrlMaxLength = Math.ceil((avatarMaxBytes * 4) / 3) + 64;

export const setImage = defineOp({
  id: "projects.setImage",
  kind: "mutation",
  summary: "Set a project's image",
  description:
    "Shows an image instead of the project's initial, for everyone who sees the project. The file travels as a base64 data URL: PNG, JPEG or WebP, at most 1 MiB (the web app crops it to a square of 256 pixels first). SVG is refused. A new image replaces the old one.",
  input: Type.Object({
    projectId: Id,
    dataUrl: Type.String({
      maxLength: imageDataUrlMaxLength,
      pattern: "^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$",
      errorMessage: "must be a PNG, JPEG or WebP image as a base64 data URL",
    }),
  }),
  output: Project,
  permission: permission.project("projects.update", (input: { projectId: string }) => input.projectId),
  // The image itself stays out of the audit log; the row says the image changed.
  sensitive: { input: ["dataUrl"] },
  mcp: false,
  audit: true,
  maxBodyBytes: 2 * 1024 * 1024,
});

export const removeImage = defineOp({
  id: "projects.removeImage",
  kind: "mutation",
  summary: "Remove a project's image",
  description: "Deletes the project's uploaded image, so its initial shows again.",
  input: Type.Object({ projectId: Id }),
  output: Project,
  permission: permission.project("projects.update", (input: { projectId: string }) => input.projectId),
  mcp: false,
  audit: true,
});

/** Where a project is collapsed: the sidebar's projects tree or the home page's project sections. */
export const CollapseWhere = Type.Union([Type.Literal("sidebar"), Type.Literal("dashboard")], {
  description:
    'Which of the caller\'s views: "sidebar" (the projects tree, Project.collapsed) or "dashboard" (the home page, Project.dashboardCollapsed). Left out: "sidebar", the one flag callers before 0.2.16 set.',
});

export const setCollapsed = defineOp({
  id: "projects.setCollapsed",
  kind: "mutation",
  summary: "Collapse or expand a project",
  description:
    "Collapses or expands a project in the caller's own sidebar or on their own home page (where; the sidebar when left out). The two are separate: collapsing in one leaves the other as it was. Other people's views do not change.",
  input: Type.Object({ projectId: Id, collapsed: Type.Boolean(), where: Type.Optional(CollapseWhere) }),
  output: Type.Object({ projectId: Id, collapsed: Type.Boolean(), where: CollapseWhere }),
  permission: permission.project("projects.view", (input: { projectId: string }) => input.projectId),
  mcp: false,
  audit: true,
});

export const reorder = defineOp({
  id: "projects.reorder",
  kind: "mutation",
  summary: "Reorder projects",
  description:
    "Sets the order of projects in the caller's own sidebar. projectIds lists projects top to bottom; ids the caller cannot see are ignored and unlisted projects follow by name.",
  input: Type.Object({ projectIds: Type.Array(Id, { maxItems: 1000, uniqueItems: true }) }),
  output: Type.Object({ projectIds: Type.Array(Id) }),
  // Only the caller's own order changes; the handler skips projects without projects.view.
  permission: permission.signedIn(),
  mcp: false,
  audit: true,
});
