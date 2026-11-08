// The Tailscale sign-in link from tailscale.signIn. Whoever opens it puts
// the panel's server on their tailnet, so it lives in memory only, per
// panel, for 10 minutes: never in panel.db, a log line, an audit row or a
// backup. tailscale.get hands it to the owner while it is fresh; the server
// signing in (Running) forgets it.

import { tailscale } from "@seylo/ops";
import type { Deps } from "../../deps";

interface Link {
  url: string;
  expiresAt: number;
}

// Keyed by the panel's agent hub: one per panel, gone with it.
const links = new WeakMap<object, Link>();

export function rememberSignInLink(deps: Pick<Deps, "agents">, url: string, now = Date.now()): Date {
  const expiresAt = now + tailscale.signInLinkSeconds * 1000;
  links.set(deps.agents, { url, expiresAt });
  return new Date(expiresAt);
}

/** The link while it is fresh; null otherwise. */
export function freshSignInLink(deps: Pick<Deps, "agents">, now = Date.now()): Link | null {
  const link = links.get(deps.agents);
  if (!link) return null;
  if (link.expiresAt <= now) {
    links.delete(deps.agents);
    return null;
  }
  return link;
}

export function forgetSignInLink(deps: Pick<Deps, "agents">): void {
  links.delete(deps.agents);
}
