// Native connections to git hosts other than GitHub: GitLab (gitlab.com or
// self-managed), Gitea and Forgejo (any URL) and Bitbucket Cloud. A
// connection holds one token, sealed; with it the panel lists
// repositories and branches, clones private ones (the token only goes to
// the connection's host), creates a webhook on each connected repository
// (removed again when the service is deleted or its source changes), opens
// merge/pull request previews and, optionally, posts commit statuses. The
// webhook endpoints are HTTP routes of the module
// (POST /api/hooks/<kind>/<webhook id>), not ops.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { RepoPath } from "./builds";
import { GitBranch, GitProviderKind, RepoFullPath, ServiceDetail } from "./services";

export { GitProviderKind, RepoFullPath };

/** How a connection signs in: an access token, or (Bitbucket) a user name with an app password. */
export const ProviderAuth = Type.Union([Type.Literal("token"), Type.Literal("appPassword")]);

/** https:// address of a self-managed GitLab or a Gitea/Forgejo, optionally with a path ("https://example.com/gitlab"). */
export const ProviderUrl = Type.String({
  minLength: 9,
  maxLength: 300,
  pattern: "^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$",
});

const ProviderName = Type.String({ minLength: 1, maxLength: 60 });
const Token = Type.String({ minLength: 1, maxLength: 2000 });
const Workspace = Type.String({ minLength: 1, maxLength: 100, pattern: "^(?!\\.{1,2}$)[A-Za-z0-9_.-]+$" });
const Username = Type.String({ minLength: 1, maxLength: 100, pattern: "^\\S+$" });

export const Provider = Type.Object({
  id: Id,
  kind: GitProviderKind,
  name: ProviderName,
  /** Web address: "https://gitlab.com", "https://git.example.com", "https://bitbucket.org". */
  url: Type.String(),
  /** Host clones and API calls go to; the token is never sent anywhere else. */
  host: Type.String(),
  /** Bitbucket: the workspace whose repositories it lists. */
  workspace: Type.Union([Type.String(), Type.Null()]),
  authKind: ProviderAuth,
  /** Who the token acts as; null for people without gitProviders.manage. */
  account: Type.Union([Type.String(), Type.Null()]),
  /** Bitbucket app passwords: the user name; null for people without gitProviders.manage. */
  username: Type.Union([Type.String(), Type.Null()]),
  /** Post a commit status for each push deploy and preview (shown on the merge or pull request). */
  statusNotes: Type.Boolean(),
  /** Services whose source uses it. */
  usedBy: Type.Integer({ minimum: 0 }),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const ProviderRepo = Type.Object({
  /** "group/sub/project", "owner/name" or "workspace/slug". */
  fullName: Type.String(),
  private: Type.Boolean(),
  /** null for an empty repository. */
  defaultBranch: Type.Union([Type.String(), Type.Null()]),
  /** Last activity, for sorting the picker. */
  updatedAt: Type.Union([Timestamp, Type.Null()]),
});

export const ProviderWebhook = Type.Object({
  /** Whether the service's source is a provider repository at all. */
  configured: Type.Boolean(),
  kind: Type.Union([GitProviderKind, Type.Null()]),
  repo: Type.Union([Type.String(), Type.Null()]),
  /** The URL the provider posts to; null when no hook exists. */
  url: Type.Union([Type.String(), Type.Null()]),
  /** Whether the hook exists at the provider. */
  created: Type.Boolean(),
  /** Why it could not be created; push-to-deploy then falls back to polling. */
  error: Type.Union([Type.String(), Type.Null()]),
  /** The URL is plain http: the provider sends its deliveries unencrypted. */
  insecure: Type.Boolean(),
  lastDeliveryAt: Type.Union([Timestamp, Type.Null()]),
  createdAt: Type.Union([Timestamp, Type.Null()]),
});

const projectScope = (input: { projectId: string }) => input.projectId;
const serviceScope = (input: { serviceId: string }) => input.serviceId;

export const list = defineOp({
  id: "gitProviders.list",
  kind: "query",
  summary: "List git provider connections",
  description:
    "Lists the panel's GitLab, Gitea/Forgejo and Bitbucket connections by name, kind and host (never the token), so people can pick one for a service's source. The account and user name are shown to people who manage connections only. Empty, with hidden true, for callers who may create or edit services nowhere.",
  input: Type.Object({}),
  output: Type.Object({
    items: Type.Array(Provider),
    hidden: Type.Boolean({
      description:
        "True when the caller may not see the connections: the list is then empty whatever is connected, and a provider source shows its repository and branch read-only.",
    }),
  }),
  // Names and hosts only, for people who may set a source somewhere (services.create or services.update).
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const create = defineOp({
  id: "gitProviders.create",
  kind: "mutation",
  summary: "Connect a git provider",
  description:
    'Stores a GitLab, Gitea/Forgejo or Bitbucket connection after checking the token with the provider. GitLab: a personal, group or project access token with the api scope (url defaults to https://gitlab.com). Gitea/Forgejo: an access token with repository read and write (webhooks) for the instance at url. Bitbucket Cloud: a workspace access token (authKind token) or a user name and app password (authKind appPassword) with repository and webhook scopes, for one workspace. The token is sealed and never returned. From a browser session it needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise); API keys need none.',
  input: Type.Object({
    kind: GitProviderKind,
    name: ProviderName,
    /** GitLab and Gitea/Forgejo; Bitbucket is always https://bitbucket.org. */
    url: Type.Optional(ProviderUrl),
    /** Bitbucket only. */
    workspace: Type.Optional(Workspace),
    authKind: Type.Optional(ProviderAuth),
    /** Bitbucket app passwords only. */
    username: Type.Optional(Username),
    token: Token,
    statusNotes: Type.Optional(Type.Boolean()),
  }),
  output: Provider,
  permission: permission.global("gitProviders.manage"),
  sensitive: { input: ["token"] },
  mcp: false,
  audit: true,
});

export const update = defineOp({
  id: "gitProviders.update",
  kind: "mutation",
  summary: "Change a git provider connection",
  description:
    'Renames a connection, replaces its token (checked with the provider first) or turns commit statuses on or off. Omitted fields keep their value; the kind, address and workspace cannot change. A new token or user name from a browser session needs a sign-in or auth.reauth from the last 15 minutes (FORBIDDEN details.reason "reauth" otherwise); API keys need none.',
  input: Type.Object({
    providerId: Id,
    name: Type.Optional(ProviderName),
    username: Type.Optional(Username),
    token: Type.Optional(Token),
    statusNotes: Type.Optional(Type.Boolean()),
  }),
  output: Provider,
  permission: permission.global("gitProviders.manage"),
  sensitive: { input: ["token"] },
  mcp: false,
  audit: true,
});

export const remove = defineOp({
  id: "gitProviders.delete",
  kind: "destructive",
  summary: "Delete a git provider connection",
  description: "Deletes a connection and its token. Fails while a service's source still uses it.",
  input: Type.Object({ providerId: Id }),
  output: Empty,
  permission: permission.global("gitProviders.manage"),
  mcp: true,
  audit: true,
});

export const check = defineOp({
  id: "gitProviders.check",
  kind: "query",
  summary: "Check a git provider connection",
  description: "Asks the provider whether the stored token still works and who it acts as.",
  input: Type.Object({ providerId: Id }),
  output: Type.Object({ ok: Type.Boolean(), account: Type.Union([Type.String(), Type.Null()]), message: Type.String() }),
  permission: permission.global("gitProviders.manage"),
  mcp: true,
  audit: false,
});

export const repos = defineOp({
  id: "gitProviders.repos",
  kind: "query",
  summary: "List a provider's repositories",
  description:
    "Lists the repositories a connection's token can read, most recently active first, optionally filtered by name. Needs the right to create services in the project the repository is picked for; people without gitProviders.manage see only the repositories the connection is already used for in that project.",
  input: Type.Object({
    projectId: Id,
    providerId: Id,
    query: Type.Optional(Type.String({ maxLength: 100 })),
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 1 })),
  }),
  output: Type.Object({ repos: Type.Array(ProviderRepo), hasMore: Type.Boolean() }),
  permission: permission.project("services.create", projectScope),
  mcp: true,
  audit: false,
});

export const branches = defineOp({
  id: "gitProviders.branches",
  kind: "query",
  summary: "List a provider repository's branches",
  description: "Lists the branches of a repository through a connection, default branch first.",
  input: Type.Object({
    projectId: Id,
    providerId: Id,
    repo: RepoFullPath,
    query: Type.Optional(Type.String({ maxLength: 100 })),
  }),
  output: Type.Object({ branches: Type.Array(Type.String()), defaultBranch: Type.Union([Type.String(), Type.Null()]) }),
  permission: permission.project("services.create", projectScope),
  mcp: true,
  audit: false,
});

export const connectRepo = defineOp({
  id: "gitProviders.connectRepo",
  kind: "mutation",
  summary: "Connect a provider repository to a service",
  description:
    "Sets a service's source to a GitLab, Gitea/Forgejo or Bitbucket repository and branch read through a connection, after checking the connection can read it, and creates a webhook on the repository (pushes, and merge or pull requests for previews) with its own secret. With deployOnPush, pushes to the branch deploy the service. rootDir is the folder to build. A webhook of the service's previous repository is removed.",
  input: Type.Object({
    serviceId: Id,
    providerId: Id,
    repo: RepoFullPath,
    branch: GitBranch,
    rootDir: Type.Optional(RepoPath),
    deployOnPush: Type.Boolean(),
  }),
  output: ServiceDetail,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});

export const webhook = defineOp({
  id: "gitProviders.webhook",
  kind: "query",
  summary: "Get a service's repository webhook",
  description:
    "Says whether the webhook the panel created on a provider repository exists, where it points and when it last delivered. Without a hook, push-to-deploy falls back to polling the branch.",
  input: Type.Object({ serviceId: Id }),
  output: ProviderWebhook,
  permission: permission.service("services.view", serviceScope),
  mcp: true,
  audit: false,
});

export const repairWebhook = defineOp({
  id: "gitProviders.repairWebhook",
  kind: "mutation",
  summary: "Create a service's repository webhook again",
  description:
    "Removes the service's webhook from the provider repository and creates a new one with a new secret, pointing at the panel's current address (its domain, else the address this call reached the panel at).",
  input: Type.Object({ serviceId: Id }),
  output: ProviderWebhook,
  permission: permission.service("services.update", serviceScope),
  mcp: true,
  audit: true,
});
