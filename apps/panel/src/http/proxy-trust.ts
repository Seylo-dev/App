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
//
// Traefik joins the panel's network when the panel domain is set, and gets
// a new address when it is recreated. The names are resolved every 30 s,
// and again before a request is handled when a new address on one of the
// panel's own networks connects, so the proxy counts from its first
// request: an agent session opened through the domain in that window would
// otherwise keep http://<domain> as its address until it reconnects.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { type Cidr, inRanges, parseCidr } from "./ip-ranges";

export interface ProxyTrust {
  /** Whether forwarded headers from this socket address are believed. */
  trusts(socketIp: string | null): boolean;
  /**
   * trusts(), after resolving the proxy names again when the address is on
   * one of the panel's networks and is not trusted (a proxy that just
   * joined, or was recreated): at most once per address per refresh
   * interval, waiting up to checkWaitMs. Run before a request is handled;
   * afterwards trusts() gives the same answer.
   */
  check(socketIp: string | null): Promise<boolean>;
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

/** Untrusted peers remembered at most; more and the list starts over. */
const maxChecked = 4096;

export function createProxyTrust(options: {
  /** Trust every peer (SEYLO_TRUST_PROXY, for development behind a local proxy). */
  always: boolean;
  /** Container names or literal addresses of the proxies in front of the panel. */
  proxies: readonly string[];
  /** More names, read on every refresh (the Wings fork's Traefik from the panel node's facts). */
  moreProxies?: () => readonly string[];
  resolve?: ResolveAll;
  refreshMs?: number;
  /** Whether an address could be a proxy: on one of the panel's own networks (non-loopback interfaces) by default. */
  onOwnNetwork?: (ip: string) => boolean;
  /** How long check() waits for a resolve before it answers with what it has. */
  checkWaitMs?: number;
  now?: () => number;
}): ProxyTrust {
  const resolve = options.resolve ?? resolveAll;
  const refreshMs = options.refreshMs ?? 30_000;
  const checkWaitMs = options.checkWaitMs ?? 1_000;
  const now = options.now ?? Date.now;
  const onOwnNetwork = options.onOwnNetwork ?? ownNetworks(now);
  const literal = new Set(options.proxies.filter((p) => isIP(p) !== 0).map(normalizeIp));
  const staticNames = options.proxies.filter((p) => isIP(p) === 0);
  const names = () => [...new Set([...staticNames, ...safely(options.moreProxies)])];
  let resolved = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  /** Untrusted peers on the panel's networks, with when they last waited for a resolve that started after they connected. */
  const checked = new Map<string, number>();

  const resolveNames = async () => {
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

  // One resolve at a time, so an older answer never replaces a newer one.
  // A caller during a resolve gets the next one, which starts after it.
  let running: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    if (!running) {
      running = resolveNames().finally(() => {
        running = null;
      });
      return running;
    }
    queued ??= running.then(() => {
      queued = null;
      return refresh();
    });
    return queued;
  };

  const trusts = (socketIp: string | null) => {
    if (options.always) return true;
    if (!socketIp) return false;
    const ip = normalizeIp(socketIp);
    return literal.has(ip) || resolved.has(ip);
  };

  return {
    trusts,
    async check(socketIp) {
      if (trusts(socketIp)) return true;
      if (!socketIp) return false;
      const ip = normalizeIp(socketIp);
      const at = checked.get(ip);
      if (at !== undefined && now() - at < refreshMs) return false;
      if (!onOwnNetwork(ip)) return false;
      const started = now();
      await within(refresh(), checkWaitMs);
      if (resolved.has(ip)) {
        checked.delete(ip);
        return true;
      }
      // Remembered also when the wait ran out: that resolve started after this
      // peer connected and still lands in trusts() when it ends. Otherwise, with
      // DNS slower than the wait, every request from the address (the network's
      // gateway, which an SSH tunnel comes from) waited the full wait.
      if (checked.size >= maxChecked) checked.clear();
      checked.set(ip, started);
      return false;
    },
    refresh,
    start() {
      if (timer) return;
      void refresh();
      timer = setInterval(() => void refresh(), refreshMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** Whether `ip` is on the network of one of this machine's non-loopback interfaces (read again every 10 s). */
function ownNetworks(now: () => number): (ip: string) => boolean {
  let ranges: Cidr[] = [];
  let readAt = Number.NEGATIVE_INFINITY;
  return (ip) => {
    if (now() - readAt > 10_000) {
      ranges = [];
      try {
        for (const list of Object.values(networkInterfaces())) {
          for (const address of list ?? []) {
            if (address.internal || !address.cidr) continue;
            try {
              ranges.push(parseCidr(address.cidr));
            } catch {
              // An address Node reports in a form we do not parse: not a proxy network.
            }
          }
        }
      } catch {
        // No interface list (a sandbox): nothing is on our networks.
      }
      readAt = now();
    }
    return inRanges(ip, ranges);
  };
}

/** Whether `promise` settled within `ms`. */
async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), late]);
  } finally {
    clearTimeout(timeout);
  }
}

function safely(read: (() => readonly string[]) | undefined): readonly string[] {
  try {
    return read?.() ?? [];
  } catch {
    return [];
  }
}
