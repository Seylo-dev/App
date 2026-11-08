// The panel on the owner's tailnet (added in 0.2.1). The panel uses the
// Tailscale already on its server: the owner's own tailscaled, signed in to
// the owner's tailnet. The panel node's agent reads it over the LocalAPI
// socket and keeps one Tailscale Serve entry that sends
// https://<machine>.<tailnet>.ts.net to the panel's unix socket. Seylo
// stores no Tailscale key. Serve only adds a way in: public access closes
// through settings.updatePanelAccess, from a request on the tailnet.
//
// Turning Serve on, signing in and changing Tailscale DNS need the owner,
// from a browser session that signed in or confirmed it is them in the last
// 15 minutes (FORBIDDEN details.reason "reauth" otherwise). None of these
// ops is offered to models.

import { type Static, Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Empty, Timestamp } from "../schemas";
import { Nullable } from "./nodes";

/** The oldest tailscaled the panel serves through: unix socket Serve targets and the TS-2026-014 fixes. */
export const minTailscaleVersion = "1.104.4";

/** What the Install button types into the panel node's Shell tab (never sent with Enter). */
export const tailscaleInstallCommand = "curl -fsSL https://tailscale.com/install.sh | sh";

/** How long a sign-in link from tailscale.signIn is kept (in memory only). */
export const signInLinkSeconds = 10 * 60;

/** The state of the panel's Serve entry, as the agent reports it (TailnetServeState). */
export const TailscaleServeState = Type.Union([
  Type.Literal("off"),
  Type.Literal("applying"),
  Type.Literal("active"),
  Type.Literal("conflict"),
  Type.Literal("error"),
  Type.Literal("unsupported"),
]);
export type TailscaleServeState = Static<typeof TailscaleServeState>;

/**
 * Why tailscale.setServe cannot turn Serve on: CONFLICT with details.reason
 * set to one of these.
 */
export const serveBlockedReasons = [
  /** No tailscaled socket on the panel server. */
  "notInstalled",
  /** tailscaled runs but is not signed in (NeedsLogin), or is signed in and stopped (Stopped, `tailscale down`). */
  "notSignedIn",
  /** The tailnet admin has to approve the machine (NeedsMachineAuth). */
  "needsApproval",
  /** tailscaled is older than minTailscaleVersion. */
  "tooOld",
  /** MagicDNS is off for the tailnet. */
  "magicDnsOff",
  /** The panel node's agent does not serve the panel on a tailnet (before 0.2.1: no tailnet.serve.v1). */
  "agentTooOld",
  /** The panel node's agent is offline. */
  "offline",
  /** config.yml on the panel server sets no_tailnet: true (`seylo panel tailscale off`). */
  "disabledOnServer",
] as const;
export type ServeBlockedReason = (typeof serveBlockedReasons)[number];
export const ServeBlockedReason = Type.Union(serveBlockedReasons.map((reason) => Type.Literal(reason)));

export const TailscaleStatus = Type.Object({
  /** The panel node's agent found tailscaled's socket. False also while nothing was reported yet. */
  detected: Type.Boolean(),
  /** The panel node's agent is connected. When false, the fields below are what it reported last. */
  agentOnline: Type.Boolean(),
  /** The panel node's agent reads Tailscale (it advertised tailnet.serve.v1). */
  agentSupported: Type.Boolean(),
  /** tailscaled's version, for example "1.104.5". */
  version: Nullable(Type.String()),
  minVersion: Type.String(),
  versionOk: Type.Boolean(),
  /** tailscaled's BackendState: "NeedsLogin", "NeedsMachineAuth", "Stopped", "Starting", "Running" and so on. */
  backendState: Nullable(Type.String()),
  /** The tailnet the server is signed in to. */
  tailnet: Nullable(Type.String()),
  /** The server's MagicDNS name, for example "panel.tail1234.ts.net". */
  dnsName: Nullable(Type.String()),
  /** Its tailnet addresses (100.x and fd7a:115c:a1e0::). */
  addresses: Type.Array(Type.String()),
  /** The login of the machine's owner; null for a tagged machine. */
  loginName: Nullable(Type.String()),
  /** ACL tags of a tagged machine. */
  tags: Type.Array(Type.String()),
  magicDns: Type.Boolean(),
  /** The tailnet issues HTTPS certificates; without them the panel is served over HTTP inside the tailnet. */
  https: Type.Boolean(),
  /** The server uses Tailscale DNS (--accept-dns); setDns turns it off. */
  acceptDns: Type.Boolean(),
  exitNodeInUse: Type.Boolean(),
  advertisesRoutes: Type.Boolean(),
  /** When the machine's key expires; null when key expiry is disabled. */
  keyExpiry: Nullable(Timestamp),
  /** The server's config.yml sets no_tailnet: true; only `seylo panel tailscale on` there undoes it. */
  disabledOnServer: Type.Boolean(),
  serve: Type.Object({
    /** The owner turned "Serve the panel on my tailnet" on. */
    wanted: Type.Boolean(),
    /** The tailnet Serve was turned on for; null while it is off. The panel is served on no other. */
    tailnet: Nullable(Type.String()),
    /**
     * The server is signed in to another tailnet than `tailnet` now. The panel
     * is not served there, and its entry is removed, until the owner turns
     * Serve on again for the new tailnet (setServe with serve: true).
     */
    onOtherTailnet: Type.Boolean(),
    state: TailscaleServeState,
    /** "https://<dnsName>" (or http:// without HTTPS certificates) while active; null otherwise. */
    url: Nullable(Type.String()),
    /** The agent's words for a conflict or an error; empty otherwise. */
    message: Type.String(),
    /** The agent's last request through the socket reached the panel. */
    panelAnswers: Type.Boolean(),
  }),
  /** The exact Serve entry Seylo owns in tailscaled's config; null when it has none. */
  owned: Nullable(
    Type.Object({
      /** For example "panel.tail1234.ts.net:443". */
      hostPort: Type.String(),
      path: Type.String(),
      /** For example "unix:/var/lib/seylo/panel/tailnet.sock". */
      proxy: Type.String(),
    }),
  ),
  /** This request came over the tailnet (the panel's tailnet listener). */
  viaTailnet: Type.Boolean(),
  /** The caller may turn Serve on, sign in and change DNS: the owner, from a browser session. */
  canManage: Type.Boolean(),
  installCommand: Type.String(),
  /** An access rule for the tailnet policy that lets only the owner reach tcp:443 on this machine. */
  grantSnippet: Type.String(),
  /** The sign-in link from tailscale.signIn while it is fresh; owner only, never stored. */
  signInUrl: Nullable(Type.String()),
});
export type TailscaleStatus = Static<typeof TailscaleStatus>;

export const get = defineOp({
  id: "tailscale.get",
  kind: "query",
  summary: "Get Tailscale on the panel server",
  description:
    "Returns what the panel node's agent sees of the server's own Tailscale: installed or not, signed in, the tailnet and machine name, HTTPS and MagicDNS, key expiry, and the panel's Serve entry with its URL.",
  input: Empty,
  output: TailscaleStatus,
  permission: permission.global("settings.view"),
  sensitive: { output: ["signInUrl"] },
  mcp: false,
  audit: false,
});

export const setServe = defineOp({
  id: "tailscale.setServe",
  kind: "mutation",
  summary: "Serve the panel on the tailnet",
  description:
    'Adds or removes the one Tailscale Serve entry that sends https://<machine>.<tailnet>.ts.net to the panel. Nothing restarts and nothing closes. Turning it on needs the owner from a browser session with a fresh sign-in, and a server that is signed in, new enough and has MagicDNS on (CONFLICT details.reason one of serveBlockedReasons otherwise). It serves the panel on the tailnet the server is signed in to then, and on no other: when the server signs in to another tailnet the entry goes until the owner turns Serve on again for that one. Turning it off while it is the only working way in and IP access is closed reopens IP access ("reopen" mode, reopenedUrl says where), or is CONFLICT in "stayClosed" mode unless reopenIpAccess is true.',
  input: Type.Object({
    serve: Type.Boolean(),
    /** Turning Serve off in "stayClosed" mode: reopen IP access as well. */
    reopenIpAccess: Type.Optional(Type.Boolean()),
  }),
  output: Type.Object({
    tailscale: TailscaleStatus,
    /** Set when turning Serve off reopened IP access: the http://<ip>:<port> address that answers again. */
    reopenedUrl: Nullable(Type.String()),
  }),
  permission: permission.global("settings.manage"),
  sensitive: { output: ["tailscale.signInUrl"] },
  mcp: false,
  audit: true,
});

export const signIn = defineOp({
  id: "tailscale.signIn",
  kind: "mutation",
  summary: "Get a Tailscale sign-in link for the server",
  description:
    "Asks the server's tailscaled for an interactive sign-in link. Whoever opens it puts the server on their tailnet, so only the owner gets it, from a browser session with a fresh sign-in, and only while the server is not signed in (a stopped server is signed in: CONFLICT details.reason 'stopped', start it on the server). The first sign-in from the panel turns Tailscale DNS off on the server. The link is kept in memory for 10 minutes and never stored or audited.",
  input: Empty,
  output: Type.Object({
    url: Type.String(),
    expiresAt: Timestamp,
  }),
  permission: permission.global("settings.manage"),
  sensitive: { output: ["url"] },
  mcp: false,
  audit: true,
});

export const setDns = defineOp({
  id: "tailscale.setDns",
  kind: "mutation",
  summary: "Turn off Tailscale DNS on the server",
  description:
    "Makes the server stop using Tailscale DNS (like `tailscale set --accept-dns=false`), so MagicDNS and the tailnet's resolvers no longer answer the server's own lookups. Only the owner, from a browser session with a fresh sign-in. Nothing else in the server's Tailscale settings changes.",
  input: Type.Object({
    /** Only false: the panel never turns Tailscale DNS on. */
    acceptDns: Type.Literal(false),
  }),
  output: TailscaleStatus,
  permission: permission.global("settings.manage"),
  sensitive: { output: ["signInUrl"] },
  mcp: false,
  audit: true,
});
