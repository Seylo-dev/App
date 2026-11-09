// The per-panel GitHub App (created with the manifest flow, so every panel
// has its own App, keys and webhook secret), its installations, picking a
// repo and branch, and connecting a repo to a service. Also the opt-in
// connected GitHub account (a device login like gh auth login, or a pasted
// personal access token) whose token lists, clones and watches private
// repos the App does not reach. GitHub's webhook endpoints are HTTP routes
// of this module (POST /api/hooks/github for the App, POST
// /api/hooks/github-repo/<id> for repository webhooks the account
// created), not ops.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Id, Timestamp } from "../schemas";
import { RepoPath } from "./builds";
import { GitBranch, ServiceDetail } from "./services";

export const GithubApp = Type.Object({
  id: Id,
  appId: Type.Integer(),
  slug: Type.String(),
  name: Type.String(),
  /** User or organization that owns the App. */
  ownerLogin: Type.String(),
  /** github.com page of the App. */
  htmlUrl: Type.String(),
  /** Where people install the App on more accounts. */
  installUrl: Type.String(),
  createdAt: Timestamp,
});

export const Installation = Type.Object({
  id: Id,
  installationId: Type.Integer(),
  accountLogin: Type.String(),
  accountType: Type.Union([Type.Literal("User"), Type.Literal("Organization")]),
  /** "all" repositories or only "selected" ones. */
  repositorySelection: Type.Union([Type.Literal("all"), Type.Literal("selected")]),
  suspended: Type.Boolean(),
  /** github.com page to change which repos the App can read. */
  manageUrl: Type.String(),
  createdAt: Timestamp,
});

export const Repo = Type.Object({
  /** "owner/name". */
  fullName: Type.String(),
  private: Type.Boolean(),
  defaultBranch: Type.String(),
  /** Last push, for sorting the picker. */
  pushedAt: Type.Union([Timestamp, Type.Null()]),
});

/**
 * The panel's connected GitHub account (one per panel, Settings > GitHub):
 * its token reads repositories the App does not reach.
 */
export const GithubAccount = Type.Object({
  /** git_credentials.id of the account's token; services name it in their source (accountId). */
  id: Id,
  login: Type.String(),
  /** "device": connected with the device flow; "token": a pasted personal access token. */
  method: Type.Union([Type.Literal("device"), Type.Literal("token")]),
  /** Scopes of a classic token or a device login; empty for a fine-grained token (its repositories and permissions are set on GitHub). */
  scopes: Type.Array(Type.String()),
  /** "classic": a device login or a classic token (ghp_); "fineGrained": a fine-grained token (github_pat_). */
  tokenKind: Type.Union([Type.Literal("classic"), Type.Literal("fineGrained")]),
  connectedAt: Timestamp,
});

/** The connected account as people who may pick a source see it: who it is, nothing about its token. */
export const AccountRef = Type.Object({ id: Id, login: Type.String() });

/** A repository's GitHub webhook created with the connected account (push-to-deploy without the App). */
export const RepoWebhook = Type.Object({
  /** Whether the service's source is a GitHub repository read through the connected account. */
  configured: Type.Boolean(),
  repo: Type.Union([Type.String(), Type.Null()]),
  /** The URL GitHub posts to; null when no hook exists. */
  url: Type.Union([Type.String(), Type.Null()]),
  /** Whether the hook exists on GitHub. */
  created: Type.Boolean(),
  /** Why it was not created (no panel domain, a token that may not create webhooks); pushes are then polled every minute. */
  error: Type.Union([Type.String(), Type.Null()]),
  lastDeliveryAt: Type.Union([Timestamp, Type.Null()]),
});

export const DeviceFlowStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("done"),
  Type.Literal("expired"),
  Type.Literal("denied"),
]);

const projectScope = (input: { projectId: string }) => input.projectId;

export const status = defineOp({
  id: "github.status",
  kind: "query",
  summary: "Get the GitHub connection",
  description:
    "Returns the panel's GitHub App (null before it is created, and for people who neither manage it nor may create or update a service anywhere), the webhook URL GitHub calls, and the connected GitHub account (a device login or a pasted token) used for private repos the App does not reach, if one is connected (only for people with github.manage).",
  input: Type.Object({}),
  output: Type.Object({
    app: Type.Union([GithubApp, Type.Null()]),
    /** Public URL GitHub posts webhooks to; null while the panel has no public address. */
    webhookUrl: Type.Union([Type.String(), Type.Null()]),
    /** The device flow needs the OAuth App client id in the brand file; false while it is a placeholder. */
    deviceFlowAvailable: Type.Boolean(),
    account: Type.Union([GithubAccount, Type.Null()]),
  }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const startManifest = defineOp({
  id: "github.startManifest",
  kind: "mutation",
  summary: "Start creating the GitHub App",
  description:
    "Starts the manifest flow that creates this panel's GitHub App. The browser POSTs `manifest` as a form field to `postUrl`; GitHub then redirects back to the panel's /settings/github page with `code` and `state`, which github.finishManifest exchanges. Set organization to create the App under an organization instead of the signed-in GitHub user.",
  input: Type.Object({
    organization: Type.Optional(Type.String({ minLength: 1, maxLength: 39, pattern: "^[A-Za-z0-9-]+$" })),
    /**
     * The address people open the panel at (the browser's origin, for
     * example "http://203.0.113.7:3000"). Used for GitHub's redirect while
     * the panel has no domain; then GitHub cannot send webhooks and the
     * panel polls branches instead.
     */
    panelUrl: Type.Optional(Type.String({ maxLength: 300, pattern: "^https?://[^/\\s]+$" })),
  }),
  output: Type.Object({
    postUrl: Type.String(),
    /** JSON manifest (name, URLs, permissions, events) to post as the "manifest" form field. */
    manifest: Type.String(),
    /** Single-use, expires in 1 hour; GitHub returns it on the redirect. */
    state: Type.String(),
  }),
  permission: permission.global("github.manage"),
  mcp: false,
  audit: true,
});

export const finishManifest = defineOp({
  id: "github.finishManifest",
  kind: "mutation",
  summary: "Finish creating the GitHub App",
  description:
    "Exchanges the code GitHub returned after the manifest flow for the new App's id, keys and webhook secret, and stores them sealed. Fails if state is unknown or expired, or an App already exists.",
  input: Type.Object({ code: Type.String({ minLength: 1, maxLength: 200 }), state: Type.String({ minLength: 1, maxLength: 200 }) }),
  output: GithubApp,
  permission: permission.global("github.manage"),
  sensitive: { input: ["code"] },
  mcp: false,
  audit: true,
});

export const deleteApp = defineOp({
  id: "github.deleteApp",
  kind: "destructive",
  summary: "Forget the GitHub App",
  description:
    "Removes the GitHub App's keys and installations from the panel. Services connected through it stop deploying on push until they are reconnected. The App itself must be deleted on github.com.",
  input: Type.Object({ confirm: Type.Literal(true) }),
  output: Empty,
  permission: permission.global("github.manage"),
  mcp: false,
  audit: true,
});

export const installations = defineOp({
  id: "github.installations",
  kind: "query",
  summary: "List GitHub App installations",
  description:
    "Lists the accounts and organizations the panel's GitHub App is installed on, the link to install it on another one, and the panel's connected GitHub account (its repositories are listed with accountId instead of installationId). Empty, with hidden true, for people who neither manage the App nor may create or update a service anywhere.",
  input: Type.Object({}),
  output: Type.Object({
    installations: Type.Array(Installation),
    installUrl: Type.Union([Type.String(), Type.Null()]),
    /** The connected GitHub account (Settings > GitHub); null when there is none or the list is hidden. */
    account: Type.Union([AccountRef, Type.Null()]),
    hidden: Type.Boolean({
      description:
        "True when the caller may not see the App or its installations: the list is then empty whatever is installed, and says nothing about whether there is an App.",
    }),
  }),
  permission: permission.signedIn(),
  mcp: true,
  audit: false,
});

export const syncInstallations = defineOp({
  id: "github.syncInstallations",
  kind: "mutation",
  summary: "Refresh GitHub App installations",
  description: "Reads the App's installations from GitHub again, for when a webhook about a new or removed installation was missed.",
  input: Type.Object({}),
  output: Type.Object({ installations: Type.Array(Installation) }),
  permission: permission.global("github.manage"),
  mcp: true,
  audit: true,
});

export const repos = defineOp({
  id: "github.repos",
  kind: "query",
  summary: "List repositories",
  description:
    "Lists the repositories an installation lets the App read (installationId), or the connected GitHub account can read (accountId: its own, ones it collaborates on and its organizations', GET /user/repos), most recently pushed first, optionally filtered by name. Pass one of installationId and accountId. Needs the right to create services in the project the repo is picked for; people without github.manage see only the repositories the installation or account is already used for in that project.",
  input: Type.Object({
    projectId: Id,
    installationId: Type.Optional(Id),
    /** github.installations account.id: the connected account's repositories instead of an installation's. */
    accountId: Type.Optional(Id),
    query: Type.Optional(Type.String({ maxLength: 100 })),
    page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 1 })),
  }),
  output: Type.Object({ repos: Type.Array(Repo), hasMore: Type.Boolean() }),
  permission: permission.project("services.create", projectScope),
  mcp: true,
  audit: false,
});

export const branches = defineOp({
  id: "github.branches",
  kind: "query",
  summary: "List a repository's branches",
  description:
    "Lists the branches of a repository through the App (installationId) or the connected GitHub account (accountId), default branch first. Pass one of the two. Fails with NOT_FOUND (details.field repo) when it cannot read the repository or there is none, or, through the account, when it is a public repository that is not the account's (not private, no push or admin access, not in its list: details.reason notOwned; use its git URL instead), and UNAVAILABLE when GitHub does not answer or rate limits the token (details.reason rateLimited).",
  input: Type.Object({
    projectId: Id,
    installationId: Type.Optional(Id),
    accountId: Type.Optional(Id),
    repo: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    query: Type.Optional(Type.String({ maxLength: 100 })),
  }),
  output: Type.Object({ branches: Type.Array(Type.String()), defaultBranch: Type.String() }),
  permission: permission.project("services.create", projectScope),
  mcp: true,
  audit: false,
});

export const connectRepo = defineOp({
  id: "github.connectRepo",
  kind: "mutation",
  summary: "Connect a GitHub repository to a service",
  description:
    "Sets a service's source to a GitHub repository and branch read through the App (installationId) or the connected GitHub account (accountId), after checking it can read it (through the account: one of the account's, the github.branches rule; UNAVAILABLE while GitHub rate limits the token). Pass one of the two. With deployOnPush, pushes to the branch deploy the service: through the App's webhook, or for the account through a repository webhook the panel creates with its token when the token may and the panel has a domain, else by polling the branch every minute. rootDir is the folder to build.",
  input: Type.Object({
    serviceId: Id,
    installationId: Type.Optional(Id),
    accountId: Type.Optional(Id),
    repo: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }),
    branch: GitBranch,
    rootDir: Type.Optional(RepoPath),
    deployOnPush: Type.Boolean(),
  }),
  output: ServiceDetail,
  permission: permission.service("services.update", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: true,
});

export const repoWebhook = defineOp({
  id: "github.repoWebhook",
  kind: "query",
  summary: "Get a service's GitHub repository webhook",
  description:
    "For a service whose GitHub repository is read through the connected account: whether the repository webhook the panel created exists, where it points and when it last delivered. Without one, pushes are picked up by polling the branch every minute.",
  input: Type.Object({ serviceId: Id }),
  output: RepoWebhook,
  permission: permission.service("services.view", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: false,
});

export const tokenConnect = defineOp({
  id: "github.tokenConnect",
  kind: "mutation",
  summary: "Connect a GitHub account with a token",
  description:
    "Connects the panel's GitHub account with a pasted personal access token instead of the device flow: fine-grained with Contents: Read and Metadata: Read on the chosen repositories, or classic with the repo scope. The token is checked against api.github.com/user (and its scopes, or the repositories a fine-grained one reaches) before it is stored sealed; it replaces a connected account, and services that use the account keep it. The App stays the recommended way.",
  input: Type.Object({ token: Type.String({ minLength: 20, maxLength: 255, pattern: "^\\S+$" }) }),
  output: GithubAccount,
  permission: permission.global("github.manage"),
  sensitive: { input: ["token"] },
  mcp: false,
  audit: true,
});

export const deviceStart = defineOp({
  id: "github.deviceStart",
  kind: "mutation",
  summary: "Connect a GitHub account for private repos",
  description:
    "Starts the GitHub device flow (like gh auth login) to get a token with the repo scope, so the panel can clone private repositories without the App. Show userCode and open verificationUri, then poll github.devicePoll every intervalSeconds. Opt-in; the App stays the recommended way.",
  input: Type.Object({}),
  output: Type.Object({
    flowId: Id,
    userCode: Type.String(),
    verificationUri: Type.String(),
    intervalSeconds: Type.Integer({ minimum: 1 }),
    expiresAt: Timestamp,
  }),
  permission: permission.global("github.manage"),
  mcp: false,
  audit: true,
});

export const devicePoll = defineOp({
  id: "github.devicePoll",
  kind: "mutation",
  summary: "Check the GitHub device flow",
  description:
    "Checks whether the person entered the code on GitHub. Once done, the token is stored sealed as the panel's connected GitHub account (a git credential for github.com, replacing a pasted token; services that use the account keep it) and the login is returned. A mutation because finishing it stores the credential.",
  input: Type.Object({ flowId: Id }),
  output: Type.Object({
    status: DeviceFlowStatus,
    login: Type.Union([Type.String(), Type.Null()]),
    gitCredentialId: Type.Union([Id, Type.Null()]),
  }),
  permission: permission.global("github.manage"),
  mcp: false,
  audit: true,
});

export const deviceDisconnect = defineOp({
  id: "github.deviceDisconnect",
  kind: "destructive",
  summary: "Disconnect the GitHub account",
  description:
    "Deletes the connected GitHub account's token (device login or pasted token) and removes the repository webhooks it created. Services that read their repository through it fail to deploy until an account is connected again or they get another source. Revoke the token on github.com too.",
  input: Type.Object({}),
  output: Empty,
  permission: permission.global("github.manage"),
  mcp: false,
  audit: true,
});
