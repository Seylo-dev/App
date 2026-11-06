// Whose X-Forwarded-* headers the panel believes. Once the panel has a
// domain, browsers reach it through the node's Traefik, so the socket peer
// is Traefik for everyone: without the forwarded headers every visitor
// shares one rate-limit bucket, every audit row shows Traefik's address and
// the panel thinks it is served over http. The panel's port is also
// published directly on the node, so a global "trust the proxy" switch would
// let anyone pick their own address with a header. The panel therefore
// trusts the headers only from the exact addresses of its proxy containers,
// found by name through Docker's DNS on the panel's network (Traefik never
// passes on forwarded headers it got from a client: it has no trusted IPs).

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface ProxyTrust {
  /** Whether forwarded headers from this socket address are believed. */
  trusts(socketIp: string | null): boolean;
  /** Re-resolves the proxy names now (also runs on a timer while started). */
  refresh(): Promise<void>;
  start(): void;
  stop(): void;
}

export type ResolveAll = (name: string) => Promise<string[]>;

const resolveAll: ResolveAll = async (name) => (await lookup(name, { all: true })).map((a) => a.address);

/** "::ffff:172.18.0.3" -> "172.18.0.3", lower-case IPv6. */
export function normalizeIp(ip: string): string {
  const lower = ip.trim().toLowerCase();
  return lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4 ? lower.slice(7) : lower;
}

export function createProxyTrust(options: {
  /** Trust every peer (SEYLO_TRUST_PROXY, for development behind a local proxy). */
  always: boolean;
  /** Container names or literal addresses of the proxies in front of the panel. */
  proxies: readonly string[];
  /** More names, read on every refresh (the Wings fork's Traefik from the panel node's facts). */
  moreProxies?: () => readonly string[];
  resolve?: ResolveAll;
  refreshMs?: number;
}): ProxyTrust {
  const resolve = options.resolve ?? resolveAll;
  const literal = new Set(options.proxies.filter((p) => isIP(p) !== 0).map(normalizeIp));
  const staticNames = options.proxies.filter((p) => isIP(p) === 0);
  const names = () => [...new Set([...staticNames, ...safely(options.moreProxies)])];
  let resolved = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const refresh = async () => {
    const next = new Set<string>();
    for (const name of names()) {
      try {
        for (const address of await resolve(name)) next.add(normalizeIp(address));
      } catch {
        // No such container on this network (no panel domain yet, or a dev panel): trust nobody by that name.
      }
    }
    resolved = next;
  };

  return {
    trusts(socketIp) {
      if (options.always) return true;
      if (!socketIp) return false;
      const ip = normalizeIp(socketIp);
      return literal.has(ip) || resolved.has(ip);
    },
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), options.refreshMs ?? 30_000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

function safely(read: (() => readonly string[]) | undefined): readonly string[] {
  try {
    return read?.() ?? [];
  } catch {
    return [];
  }
}
