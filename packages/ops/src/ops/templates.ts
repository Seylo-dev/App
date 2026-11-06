// One-click templates in Easypanel's format (meta.yaml + index.ts with a
// generate() function). Template code runs only in the QuickJS sandbox;
// its output is validated and shown as the list of services it creates
// before anything is made. The result is normal services people can
// change afterwards.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id } from "../schemas";
import { ServiceKind, ServiceName, ServiceSummary } from "./services";

export const TemplateSlug = Type.String({ minLength: 1, maxLength: 60, pattern: "^[a-z0-9][a-z0-9-]*$" });

export const TemplateSummary = Type.Object({
  slug: TemplateSlug,
  name: Type.String(),
  /** One line for the card. */
  description: Type.String(),
  /** "Automation", "Analytics", "Monitoring", "Storage", "CMS", "Developer tools", ... */
  category: Type.String(),
  tags: Type.Array(Type.String()),
  /** Logo served by the panel: the template's own SVG, or a generated monogram. Never null; the type keeps null for older clients. */
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  /** What installing creates, for the card: "App + Postgres", "Compose · 3 services". */
  creates: Type.String(),
  /** Shipped with the panel (true) or added on this panel (false). */
  builtIn: Type.Boolean(),
});

/** A value a person fills in on the install form. Values are strings, numbers or booleans. */
export const FormValue = Type.Union([Type.String({ maxLength: 10_000 }), Type.Number(), Type.Boolean()]);

export const FormField = Type.Object({
  key: Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }),
  label: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  /** "domain" offers the node's automatic domain; "password" is generated when left empty. */
  type: Type.Union([
    Type.Literal("string"),
    Type.Literal("password"),
    Type.Literal("number"),
    Type.Literal("boolean"),
    Type.Literal("select"),
    Type.Literal("domain"),
  ]),
  required: Type.Boolean(),
  default: Type.Union([FormValue, Type.Null()]),
  /** For select: the choices, for example image versions with "(latest)" first. */
  options: Type.Array(Type.Object({ value: Type.String(), label: Type.String() })),
});

export const TemplateDetail = Type.Object({
  ...TemplateSummary.properties,
  /** Longer Markdown description for the install dialog. */
  body: Type.String(),
  links: Type.Array(Type.Object({ label: Type.String(), url: Type.String() })),
  /** The install form. The service name and node are always asked for and are not listed here. */
  fields: Type.Array(FormField),
});

/** One service the template would create, as the "This creates" list shows it. */
export const PlannedService = Type.Object({
  name: ServiceName,
  kind: ServiceKind,
  /** "n8nio/n8n:2.21.0", "postgres:17", or the repo for source builds. */
  image: Type.String(),
  ports: Type.Array(Type.Integer({ minimum: 1, maximum: 65535 })),
  /** No domain and no IP:port: only reachable on the project network. */
  internalOnly: Type.Boolean(),
  domains: Type.Array(Type.String()),
  /** Variable names only; generated passwords and keys are never echoed. */
  envKeys: Type.Array(Type.String()),
  volumes: Type.Array(Type.Object({ name: Type.String(), mountPath: Type.String() })),
  /** A service with this name already exists in the project; creating would fail. */
  conflict: Type.Boolean(),
});

const InstallInput = {
  projectId: Id,
  slug: TemplateSlug,
  /** Prefix for the created services' names ("n8n" -> "n8n", "n8n-db"). */
  name: ServiceName,
  nodeId: Id,
  values: Type.Record(Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }), FormValue),
};

const projectScope = (input: { projectId: string }) => input.projectId;

export const list = defineOp({
  id: "templates.list",
  kind: "query",
  summary: "List templates",
  description:
    "Lists the template catalog (built-in and added on this panel), optionally filtered by category or a search text, with the categories for the filter chips.",
  input: Type.Object({
    category: Type.Optional(Type.String({ maxLength: 60 })),
    query: Type.Optional(Type.String({ maxLength: 100 })),
  }),
  output: Type.Object({ templates: Type.Array(TemplateSummary), categories: Type.Array(Type.String()) }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const get = defineOp({
  id: "templates.get",
  kind: "query",
  summary: "Get a template",
  description: "Returns one template with its description, links and the install form fields.",
  input: Type.Object({ slug: TemplateSlug }),
  output: TemplateDetail,
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const preview = defineOp({
  id: "templates.preview",
  kind: "mutation",
  summary: "Preview what a template creates",
  description:
    "Runs the template's generate() in the sandbox with the form values and returns the services it would create in the project, with conflicts and warnings. Creates nothing. It is a POST (mutation) only because the form values do not fit a query string.",
  input: Type.Object(InstallInput),
  output: Type.Object({ services: Type.Array(PlannedService), warnings: Type.Array(Type.String()) }),
  permission: permission.project("services.create", projectScope),
  // Form values can be passwords the person typed.
  sensitive: { input: ["values.*"] },
  mcp: true,
  audit: true,
});

export const create = defineOp({
  id: "templates.create",
  kind: "mutation",
  summary: "Install a template",
  description:
    "Runs the template and creates its services in the project on one node, with generated passwords stored as secrets, then deploys them unless deployNow is false. Fails without creating anything when a name conflicts.",
  input: Type.Object({ ...InstallInput, deployNow: Type.Optional(Type.Boolean({ default: true })) }),
  output: Type.Object({ services: Type.Array(ServiceSummary) }),
  permission: permission.project("services.create", projectScope),
  sensitive: { input: ["values.*"] },
  mcp: true,
  audit: true,
});

export const source = defineOp({
  id: "templates.source",
  kind: "query",
  summary: "Read a template's files",
  description: "Returns a template's meta.yaml and index.ts, for reading a built-in template or editing one added on this panel.",
  input: Type.Object({ slug: TemplateSlug }),
  output: Type.Object({ metaYaml: Type.String(), source: Type.String(), builtIn: Type.Boolean() }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const saveCustom = defineOp({
  id: "templates.saveCustom",
  kind: "mutation",
  summary: "Add or change a custom template",
  description:
    "Saves a template on this panel from its meta.yaml and index.ts (Easypanel's format). The files are checked first: the form must parse and generate() must run in the sandbox with the form's defaults. Built-in slugs cannot be used.",
  input: Type.Object({
    slug: TemplateSlug,
    metaYaml: Type.String({ minLength: 1, maxLength: 50_000 }),
    source: Type.String({ minLength: 1, maxLength: 200_000 }),
  }),
  output: TemplateDetail,
  permission: permission.global("templates.manage"),
  mcp: false,
  audit: true,
});

export const deleteCustom = defineOp({
  id: "templates.deleteCustom",
  kind: "destructive",
  summary: "Delete a custom template",
  description: "Deletes a template added on this panel. Services created from it stay.",
  input: Type.Object({ slug: TemplateSlug }),
  output: Type.Object({}),
  permission: permission.global("templates.manage"),
  mcp: false,
  audit: true,
});
