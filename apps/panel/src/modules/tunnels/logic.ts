// Cloudflare Tunnel rows: the view the contract returns (state comes from
// what the agent reports: a running quick tunnel has a URL) and which token
// a token-mode tunnel uses.

import type { tunnels as tunnelOps } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { eq } from "drizzle-orm";
import type { PanelDb } from "../../db/client";
import { cloudflareTunnels, users } from "../../db/schema";
import type { Deps } from "../../deps";
import { getSetting } from "../../settings";
import { getService, mainPort } from "../domains/lookup";
import "./settings";

export type TunnelRow = typeof cloudflareTunnels.$inferSelect;
export type Tunnel = Static<typeof tunnelOps.Tunnel>;

/** Quick tunnels default to two hours. */
export const quickTunnelMinutes = 120;

export function tunnelRow(db: PanelDb, serviceId: string): TunnelRow | undefined {
  return db.select().from(cloudflareTunnels).where(eq(cloudflareTunnels.serviceId, serviceId)).get();
}

/**
 * The token a token-mode tunnel runs with: the service's own, else the
 * global one, but the global one only for a tunnel an owner or admin turned
 * on (`updatedBy`). Every cloudflared started with a tunnel token joins that
 * one tunnel and takes a share of its hostname's traffic, resolving the
 * targets on its own project network: a member must not be able to start
 * one on the owner's token from their project.
 */
export function effectiveToken(
  deps: Pick<Deps, "db" | "secrets">,
  row: Pick<TunnelRow, "tokenSealed"> & Partial<Pick<TunnelRow, "updatedBy">>,
  options: { mayUseGlobal?: boolean } = {},
): { token: string | null; source: "service" | "global" | "none" } {
  if (row.tokenSealed) {
    const token = deps.secrets.open(row.tokenSealed, "cloudflare.tunnel");
    if (token) return { token, source: "service" };
  }
  const global = getSetting(deps.db, "cloudflareTunnelToken");
  const token = global ? deps.secrets.open(global.tokenSealed, "cloudflare.tunnel") : null;
  if (!token) return { token: null, source: "none" };
  const allowed = options.mayUseGlobal ?? isAdmin(deps.db, row.updatedBy ?? null);
  return allowed ? { token, source: "global" } : { token: null, source: "none" };
}

function isAdmin(db: PanelDb, userId: string | null): boolean {
  if (!userId) return false;
  const role = db.select({ role: users.role }).from(users).where(eq(users.id, userId)).get()?.role;
  return role === "owner" || role === "admin";
}

/** Whether the tunnel should run now: on, not past its end, and token mode has a token. */
export function tunnelActive(deps: Pick<Deps, "db" | "secrets">, row: TunnelRow, now = new Date()): boolean {
  if (!row.enabled) return false;
  if (row.expiresAt && row.expiresAt <= now) return false;
  return row.mode === "quick" || effectiveToken(deps, row).token !== null;
}

export function tunnelView(deps: Pick<Deps, "db" | "secrets" | "agents">, serviceId: string, now = new Date()): Tunnel {
  const service = getService(deps.db, serviceId);
  const row = tunnelRow(deps.db, serviceId);
  const port = row?.targetPort ?? mainPort(service) ?? 80;
  if (!row) {
    return {
      serviceId,
      enabled: false,
      mode: "quick",
      state: "off",
      targetPort: port,
      url: null,
      hostname: null,
      tokenSource: effectiveToken(deps, { tokenSealed: null } as TunnelRow).source,
      expiresAt: null,
      error: null,
    };
  }
  const token = effectiveToken(deps, row);
  const active = tunnelActive(deps, row, now);
  // The agent reports a quick tunnel's URL in ServiceStatus.tunnel_url once cloudflared connected.
  const reported = deps.agents.state
    .serviceStatuses(serviceId)
    .map((s) => s.status.tunnelUrl)
    .find((url) => url !== "");
  const url = !active ? null : row.mode === "token" ? (row.hostname ? `https://${row.hostname}` : null) : (reported ?? row.url ?? null);
  let state: Tunnel["state"] = "off";
  let error: string | null = null;
  if (row.enabled && row.mode === "token" && token.token === null) {
    state = "failed";
    error = "No tunnel token: add one here or a global one in Settings.";
  } else if (active) {
    state = row.mode === "token" || reported ? "running" : "starting";
  }
  return {
    serviceId,
    enabled: row.enabled && (!row.expiresAt || row.expiresAt > now),
    mode: row.mode,
    state,
    targetPort: row.targetPort,
    url,
    hostname: row.hostname,
    tokenSource: token.source,
    expiresAt: row.mode === "quick" ? (row.expiresAt?.toISOString() ?? null) : null,
    error,
  };
}
