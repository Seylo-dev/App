// Cloudflare Tunnel per service. quick: a temporary trycloudflare.com URL
// that needs no account and turns itself off. token: a permanent hostname
// through a scoped tunnel token, set per service or once in settings.

import { Type } from "@sinclair/typebox";
import { defineOp } from "../define";
import { permission } from "../permission";
import { Id, Timestamp } from "../schemas";
import { ContainerPort, Hostname } from "./domains";

export const TunnelMode = Type.Union([Type.Literal("quick"), Type.Literal("token")]);

export const TunnelState = Type.Union([Type.Literal("off"), Type.Literal("starting"), Type.Literal("running"), Type.Literal("failed")]);

export const Tunnel = Type.Object({
  serviceId: Id,
  enabled: Type.Boolean(),
  mode: TunnelMode,
  state: TunnelState,
  targetPort: ContainerPort,
  /** Public URL: the trycloudflare.com address the agent reported, or https://<hostname>. Null while off. */
  url: Type.Union([Type.String(), Type.Null()]),
  /** Permanent hostname configured in Cloudflare for token mode. */
  hostname: Type.Union([Hostname, Type.Null()]),
  /** Which token token mode uses: this service's own, the global one from settings, or none yet. */
  tokenSource: Type.Union([Type.Literal("service"), Type.Literal("global"), Type.Literal("none")]),
  /** Quick tunnels turn off at this time. */
  expiresAt: Type.Union([Timestamp, Type.Null()]),
  /** Last error from cloudflared, safe to show. */
  error: Type.Union([Type.String(), Type.Null()]),
});

export const get = defineOp({
  id: "tunnels.get",
  kind: "query",
  summary: "Get a service's Cloudflare tunnel",
  description: "Returns the Cloudflare tunnel of a service: on or off, quick or token mode, its public URL and state.",
  input: Type.Object({ serviceId: Id }),
  output: Tunnel,
  permission: permission.service("tunnels.view", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: false,
});

export const set = defineOp({
  id: "tunnels.set",
  kind: "mutation",
  summary: "Turn a Cloudflare tunnel on or off",
  description:
    "Turns the service's Cloudflare tunnel on or off. quick mode starts a temporary trycloudflare.com URL (default 2 hours, at most 24). token mode uses this service's tunnel token, or the global one from settings, for a permanent hostname. Fields left out keep their value; token null removes the service's own token.",
  input: Type.Object({
    serviceId: Id,
    enabled: Type.Boolean(),
    mode: Type.Optional(TunnelMode),
    /** Defaults to the service's main port. */
    targetPort: Type.Optional(ContainerPort),
    /** quick mode: minutes until it turns off. */
    durationMinutes: Type.Optional(Type.Integer({ minimum: 5, maximum: 1440 })),
    /** token mode: a scoped Cloudflare tunnel token for this service only. */
    token: Type.Optional(Type.Union([Type.String({ minLength: 20, maxLength: 4096 }), Type.Null()])),
    /** token mode: hostname routed to this tunnel in Cloudflare, shown in the UI. */
    hostname: Type.Optional(Type.Union([Hostname, Type.Null()])),
  }),
  output: Tunnel,
  sensitive: { input: ["token"] },
  permission: permission.service("tunnels.edit", (input: { serviceId: string }) => input.serviceId),
  mcp: true,
  audit: true,
});

export const getSettings = defineOp({
  id: "tunnels.getSettings",
  kind: "query",
  summary: "Get Cloudflare tunnel settings",
  description:
    "Says whether a global Cloudflare tunnel token is set (services in token mode without their own token use it). The token itself is never returned.",
  input: Type.Object({}),
  output: Type.Object({ tokenSet: Type.Boolean(), updatedAt: Type.Union([Timestamp, Type.Null()]) }),
  permission: permission.global("settings.view"),
  mcp: false,
  audit: false,
});

export const setSettings = defineOp({
  id: "tunnels.setSettings",
  kind: "mutation",
  summary: "Set the global Cloudflare tunnel token",
  description:
    "Sets or removes (null) the global Cloudflare tunnel token. Running token-mode tunnels that use it restart with the new token.",
  input: Type.Object({ token: Type.Union([Type.String({ minLength: 20, maxLength: 4096 }), Type.Null()]) }),
  output: Type.Object({ tokenSet: Type.Boolean(), updatedAt: Type.Union([Timestamp, Type.Null()]) }),
  sensitive: { input: ["token"] },
  permission: permission.global("settings.edit"),
  mcp: false,
  audit: true,
});
