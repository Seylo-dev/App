// Private paths: the ways into the panel that keep working when IP access is
// closed (added in 0.2.1). Closing IP access is allowed only while one works
// and the caller came in over it (settings.updatePanelAccess), and IP
// access reopens when none works (ip-access.ts). The panel domain is
// defined here; the tailnet registers itself from modules/tailscale.
// Contract shape: settings.ts PrivatePath.

import type { settings as settingOps } from "@seylo/ops";
import type { Deps } from "../../deps";
import type { OpContext } from "../../ops/implement";
import { getSetting } from "../../settings";
import { domainWorking } from "./domain";
import "./keys";

export interface PrivatePathState {
  /** "https://panel.example.com"; null while the path has no address (no domain set, tailnet name not known yet). */
  url: string | null;
  /** After the path's own debounce (2 failed domain checks in a row; 5 minutes of tailnet reports). */
  working: boolean;
  /** When `working` last changed; null when unknown. */
  since: Date | null;
}

export interface PrivatePathSource {
  kind: settingOps.PrivatePathKind;
  /** The path's current state from panel.db and the hub's memory. Cheap: settings.panelAccess reads it on every call. */
  state(deps: Pick<Deps, "db" | "agents">): PrivatePathState;
  /**
   * The request came in over this path, which shows the caller can still
   * reach the panel once IP access closes. Only something the request
   * cannot choose counts (ctx.origin through a trusted proxy, ctx.via).
   */
  provenBy(ctx: OpContext): boolean;
}

/** Display and evaluation order. */
const order: readonly settingOps.PrivatePathKind[] = ["domain", "tailnet"];
const sources = new Map<settingOps.PrivatePathKind, PrivatePathSource>();

/**
 * Adds a path, or replaces the one of the same kind (safe to call from a
 * module's start() on every panel built). The returned function removes it
 * again while it is still the registered one (tests).
 */
export function registerPrivatePath(source: PrivatePathSource): () => void {
  sources.set(source.kind, source);
  return () => {
    if (sources.get(source.kind) === source) sources.delete(source.kind);
  };
}

/** Every registered path, domain first. */
export function privatePathSources(): PrivatePathSource[] {
  return order.flatMap((kind) => sources.get(kind) ?? []);
}

/** The paths that have an address, as settings.panelAccess returns them. ctx marks the one the caller is on. */
export function listPrivatePaths(deps: Pick<Deps, "db" | "agents">, ctx?: OpContext): settingOps.PrivatePath[] {
  return privatePathSources().flatMap((source) => {
    const state = source.state(deps);
    if (!state.url) return [];
    return [
      {
        kind: source.kind,
        url: state.url,
        working: state.working,
        since: state.since?.toISOString() ?? null,
        usingNow: ctx ? source.provenBy(ctx) : false,
      },
    ];
  });
}

/** Some private path works right now. */
export function anyPrivatePathWorking(deps: Pick<Deps, "db" | "agents">): boolean {
  return privatePathSources().some((source) => source.state(deps).working);
}

/** The working path the request came in over; null when it came over IP:port or a path that is down. */
export function provingPrivatePath(ctx: OpContext): PrivatePathSource | null {
  return privatePathSources().find((source) => source.provenBy(ctx) && source.state(ctx).working) ?? null;
}

/**
 * The panel domain. Working: a check found it active for the current
 * domain, and it did not fail the 2 checks since in a row (domain.ts
 * domainWorking). A changed or removed domain stops working at once: its
 * status is dropped with it (settings.updateGeneral).
 * Proven by an https://<domain> origin, which a request over IP:port cannot
 * produce: there the scheme is always http (http/request-origin.ts), so only
 * a trusted proxy (Traefik with the domain's certificate) sets it.
 */
export const domainPath: PrivatePathSource = {
  kind: "domain",
  state(deps) {
    const domain = getSetting(deps.db, "panelDomain") ?? null;
    if (!domain) return { url: null, working: false, since: null };
    const { working, since } = domainWorking(getSetting(deps.db, "panelDomainStatus"), domain);
    return { url: `https://${domain}`, working, since: since === null ? null : new Date(since) };
  },
  provenBy(ctx) {
    const domain = getSetting(ctx.db, "panelDomain") ?? null;
    return domain !== null && ctx.origin === `https://${domain}`;
  },
};

registerPrivatePath(domainPath);
