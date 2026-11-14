// One-click templates in Easypanel's format (meta.yaml + index.ts with a
// generate() function). Template code runs only in the QuickJS sandbox;
// its output is validated and shown as the list of services it creates
// before anything is made. The result is normal services people can
// change afterwards.
//
// The official templates come from a signed catalog the Templates
// repository (<githubOrg>/<templatesRepo>, release "catalog") publishes,
// which the panel checks for every few hours and keeps on disk; a copy
// ships with the panel for panels without internet access. The owner can
// add one private catalog next to it (setCatalogSource).

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { Nullable } from "./nodes";
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
  /** The app's logo, served by the panel (`/api/templates/<slug>/logo.svg`, `.webp` or `.png`, with `?v=` from its sha256 since 0.2.17) for catalog templates that have one; null otherwise (the web shows a letter tile). */
  logoUrl: Type.Union([Type.String(), Type.Null()]),
  /** What installing creates, for the card: "App + Postgres", "Compose · 3 services". */
  creates: Type.String(),
  /** From a catalog, read only (true: the official one or the owner's private one), or added on this panel (false). */
  builtIn: Type.Boolean(),
  /** Where it comes from: the official catalog, the owner's private catalog, or added on this panel. added in 0.2.17 */
  catalog: Type.Union([Type.Literal("official"), Type.Literal("private"), Type.Literal("custom")]),
  /** From a private catalog the panel takes without a signature. added in 0.2.17 */
  unsigned: Type.Boolean(),
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
    "Runs the template and creates its services in the project on one node, with generated passwords stored as secrets, then deploys them unless deployNow is false. Fails without creating anything when a name conflicts. Beyond services.create it needs env.edit for the template's env, files.write for file mounts, domains.edit for custom domains and services.deploy to deploy (a template with a database always starts it).",
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

/** Where the catalog comes from (setCatalogSource, owner only). added in 0.2.17 */
export const CatalogSource = Type.Object({
  /** Check the official catalog on GitHub. false: only the copy that ships with the panel (panels without internet access). */
  official: Type.Boolean(),
  /**
   * One more catalog in the same format, added to the official one (an
   * official slug wins over one of its own). The panel fetches `url` and
   * `url` + ".minisig" and checks the signature with publicKey; without a
   * key it takes the catalog only with allowUnsigned.
   */
  extra: Nullable(
    Type.Object({
      url: Type.String({ minLength: 9, maxLength: 2000, pattern: "^https://\\S+$" }),
      /** minisign public key (the "RW..." line), or null for an unsigned catalog. */
      publicKey: Nullable(Type.String({ maxLength: 100 })),
      allowUnsigned: Type.Boolean(),
    }),
  ),
});

/** One catalog as the panel holds it. added in 0.2.17 */
export const CatalogInfo = Type.Object({
  /** The copy in use: the one that ships with this panel ("bundled"), one downloaded since ("downloaded"), or none yet (null). */
  origin: Nullable(Type.Union([Type.Literal("bundled"), Type.Literal("downloaded")])),
  /** Grows with every publish; the panel never goes back to a lower one. */
  sequence: Nullable(Type.Integer({ minimum: 0 })),
  /** Commit of the catalog's repository it was built from. */
  commit: Nullable(Type.String()),
  generatedAt: Nullable(Timestamp),
  /** Templates from it that this panel lists. */
  templates: Type.Integer({ minimum: 0 }),
  /** Last successful download (null: never). */
  fetchedAt: Nullable(Timestamp),
  lastTriedAt: Nullable(Timestamp),
  /** Why the last try failed, safe to show; null when it worked. The panel keeps the catalog it had. */
  lastError: Nullable(Type.String()),
});

export const CatalogStatus = Type.Object({
  official: Type.Object({
    ...CatalogInfo.properties,
    /** The owner's switch (CatalogSource.official). */
    enabled: Type.Boolean(),
    /** This build has the catalog's signing key (the release key); without it the panel only uses the copy it ships with. */
    signingKey: Type.Boolean(),
    /**
     * The last check found no official catalog: GitHub answered 404 for
     * catalog.json, so none is published yet. Not an error (lastError stays
     * null): the panel keeps the catalog it has and checks again on its
     * 6-hour schedule. False while downloads are off or without the key.
     */
    notPublished: Type.Boolean(),
    /** The panel version whose copy ships here. */
    bundledWith: Type.String(),
  }),
  /** The private catalog, when the owner set one. */
  extra: Nullable(
    Type.Object({
      ...CatalogInfo.properties,
      /** Host of its URL (the full URL is in `source`, for the owner). */
      host: Type.String(),
      /** Checked against a public key; false when the owner allowed it unsigned. */
      signed: Type.Boolean(),
    }),
  ),
  /** Slugs a catalog update brought since someone with templates.manage last opened the Templates page. */
  newSlugs: Type.Array(TemplateSlug),
  /** Templates left out because they need a newer panel (their minPanel). */
  needNewerPanel: Type.Integer({ minimum: 0 }),
  /** Templates a catalog has but this panel could not read, each left out alone. */
  skipped: Type.Array(
    Type.Object({
      slug: Type.String(),
      catalog: Type.Union([Type.Literal("official"), Type.Literal("private")]),
      reason: Type.String(),
    }),
  ),
  /** The caller holds templates.manage ("Check for new templates"). */
  canRefresh: Type.Boolean(),
  /** The caller is the owner and may change the source. */
  canChangeSource: Type.Boolean(),
  /** The source setting, for the owner; null for everyone else. */
  source: Nullable(CatalogSource),
});

export const catalogStatus = defineOp({
  id: "templates.catalogStatus",
  kind: "query",
  summary: "Get the template catalog's status",
  description:
    "Says where the template catalog comes from: the official catalog (the copy that ships with the panel or a newer signed download), its date and commit, the last check and its error or that none is published yet, the owner's private catalog if any, which templates are new, and how many need a newer panel. added in 0.2.17",
  input: Empty,
  output: CatalogStatus,
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const refreshCatalog = defineOp({
  id: "templates.refreshCatalog",
  kind: "mutation",
  summary: "Check for new templates",
  description:
    "Downloads the official catalog (and the private one, if set) now instead of at the next check (every 6 hours), verifies it and switches to it when it is newer. On any failure the panel keeps the catalog it has and returns the reason. A 404 for the official catalog (none published yet) is no failure: official.notPublished is true and lastError null. One check runs at a time. added in 0.2.17",
  input: Empty,
  output: CatalogStatus,
  permission: permission.global("templates.manage"),
  mcp: false,
  audit: true,
});

export const setCatalogSource = defineOp({
  id: "templates.setCatalogSource",
  kind: "mutation",
  summary: "Set where templates come from",
  description:
    "Owner only. Turns the official catalog's downloads on or off (off: only the copy that ships with the panel) and sets or removes a private catalog that is added to the official one, signed with its own minisign key or, when allowed, unsigned. A changed private catalog is fetched right away. added in 0.2.17",
  input: CatalogSource,
  output: CatalogStatus,
  permission: permission.global("templates.manage"),
  mcp: false,
  audit: true,
});

export const markCatalogSeen = defineOp({
  id: "templates.markCatalogSeen",
  kind: "mutation",
  summary: "Mark new templates as seen",
  description:
    "Clears the New tag of the templates a catalog update brought. The Templates page calls it when someone with templates.manage opens it. added in 0.2.17",
  input: Empty,
  output: Empty,
  permission: permission.global("templates.manage"),
  mcp: false,
  audit: true,
});
