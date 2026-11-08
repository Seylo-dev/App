// The panel domain's state: pending_dns until the hostname resolves to a
// node of this panel, issuing_certificate until HTTPS answers with this
// panel's health endpoint, then active. A recurring job re-checks it:
// every 5 minutes while it is not active or while IP access is closed (or
// meant to be), hourly otherwise.
//
// As a private path (private-paths.ts) the domain is debounced: once it
// worked it counts as down only after 2 failed checks in a row, at least 4
// minutes apart, so one slow answer does not reopen IP access
// (ip-access.ts), and neither does a check on demand (saving the domain
// again) that lands in the same blip as a scheduled one. The job calls
// applyPanelIpAccess when that debounced state changes.

import { resolve4, resolve6 } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { askNodesToMove } from "../../agent-hub/move-target";
import { nodes } from "../../db/schema";
import type { Deps } from "../../deps";
import { healthPath } from "../../http/health";
import { defineJob } from "../../jobs/queue";
import { getSetting, setSetting } from "../../settings";
import { testReleaseOverrides } from "../updates/manifest";
import { applyPanelIpAccess, readIpAccessApplied, readPanelAccessWanted } from "./ip-access";
import "./keys";

export type DomainState = "none" | "pending_dns" | "issuing_certificate" | "active" | "error";

export interface StoredDomainStatus {
  domain: string;
  state: DomainState;
  message: string;
  checkedAt: number;
  /**
   * The domain as a private path, after the debounce: true once a check
   * found it active, false again after domainDownAfter failed checks in a
   * row. Absent on rows from before 0.2.1: then the state decides.
   */
  working?: boolean;
  /** Epoch milliseconds `working` last changed (absent on rows from before 0.2.1). */
  since?: number;
  /** Checks in a row that did not find the domain active, counting only those domainFailureGapMs apart. */
  failedChecks?: number;
  /** Epoch milliseconds of the last failed check that counted in failedChecks. */
  lastFailedAt?: number;
}

/** Failed checks in a row after which a domain that worked counts as down (5-10 minutes at one check per 5 minutes). */
export const domainDownAfter = 2;
/**
 * A failed check counts toward domainDownAfter only this long after the
 * last one that counted: the schedule's checks are 4.5 to 5.5 minutes
 * apart, a check on demand can come seconds after one.
 */
export const domainFailureGapMs = 4 * 60_000;

/** The debounced private-path view of a stored status; not working when it is about another domain. */
export function domainWorking(status: StoredDomainStatus | undefined, domain: string | null): { working: boolean; since: number | null } {
  if (!status || !domain || status.domain !== domain) return { working: false, since: null };
  return { working: status.working ?? status.state === "active", since: status.since ?? null };
}

declare module "../../settings" {
  interface SettingValues {
    panelDomainStatus: StoredDomainStatus;
  }
}

export const domainCheckJobType = "settings.checkDomain";

export interface DomainProbes {
  resolve(host: string): Promise<string[]>;
  /**
   * True when https://<host>/api/health answers like a panel, with a
   * certificate the public roots trust (or, in test builds, `extraCa`).
   */
  https(host: string, extraCa?: string | null): Promise<boolean>;
}

async function answersLikePanel(host: string, ca?: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${host}${healthPath}`, {
      signal: AbortSignal.timeout(8000),
      redirect: "error",
      ...(ca ? { tls: { ca } } : {}),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/** The real DNS and HTTPS probes (tests use them against local servers). */
export const defaultProbes: DomainProbes = {
  async resolve(host) {
    const [v4, v6] = await Promise.all([resolve4(host).catch(() => []), resolve6(host).catch(() => [])]);
    return [...v4, ...v6];
  },
  async https(host, extraCa) {
    if (await answersLikePanel(host)) return true;
    return extraCa ? answersLikePanel(host, extraCa) : false;
  },
};

/** In the data dir; read only by test builds (testReleaseOverrides), never by a shipped panel. */
export const testCaFile = "test-ca.pem";

/**
 * The e2e's test CA (Pebble's root), trusted by the HTTPS probe of a test
 * build only, so a panel domain with a Pebble certificate can become active
 * there. A normal build never reads the file: its domains need a public
 * certificate, which is what lets agents verify them with system roots.
 */
export function testCa(dataDir: string | undefined, testBuild = testReleaseOverrides() !== null): string | null {
  if (!testBuild || !dataDir) return null;
  try {
    return readFileSync(join(dataDir, testCaFile), "utf8");
  } catch {
    return null;
  }
}

let probes: DomainProbes = defaultProbes;

/** Tests swap DNS and HTTPS for fakes. */
export function setDomainProbes(next: DomainProbes | null): void {
  probes = next ?? defaultProbes;
}

export function readDomainStatus(deps: Pick<Deps, "db">): { state: DomainState; message: string } {
  const domain = getSetting(deps.db, "panelDomain") ?? null;
  if (!domain) return { state: "none", message: "" };
  const status = getSetting(deps.db, "panelDomainStatus");
  if (!status || status.domain !== domain) return { state: "pending_dns", message: "Checking DNS..." };
  return { state: status.state, message: status.message };
}

/** Panel node addresses first; any node of this panel counts, since agents route the panel too. */
function nodeAddresses(deps: Pick<Deps, "db">): { all: Set<string>; panel: string | null } {
  const rows = deps.db
    .select({ v4: nodes.publicIpv4, v6: nodes.publicIpv6, address: nodes.publicAddress, isPanel: nodes.isPanelNode })
    .from(nodes)
    .all();
  const all = new Set<string>();
  for (const row of rows) {
    if (row.v4) all.add(row.v4);
    if (row.v6) all.add(row.v6);
    // The owner's address counts when it is an IP; a name is not what an A record holds.
    if (row.address && isIP(row.address)) all.add(row.address);
  }
  const panelRow = rows.find((r) => r.isPanel) ?? rows[0];
  const panelIp = panelRow?.address && isIP(panelRow.address) ? panelRow.address : null;
  return { all, panel: panelIp ?? panelRow?.v4 ?? panelRow?.v6 ?? null };
}

export async function checkDomain(
  deps: Pick<Deps, "db" | "live"> & { config?: Pick<Deps["config"], "dataDir"> },
  now = new Date(),
): Promise<StoredDomainStatus | null> {
  const domain = getSetting(deps.db, "panelDomain") ?? null;
  if (!domain) return null;
  const save = (state: DomainState, message: string): StoredDomainStatus => {
    const before = getSetting(deps.db, "panelDomainStatus");
    const previous = before?.domain === domain ? before : undefined;
    const was = domainWorking(previous, domain);
    const failedBefore = previous?.failedChecks ?? 0;
    const lastFailedAt = previous?.lastFailedAt;
    // A failure soon after the last one that counted is the same blip, seen twice.
    const counts =
      state !== "active" && (failedBefore === 0 || lastFailedAt === undefined || now.getTime() - lastFailedAt >= domainFailureGapMs);
    const failedChecks = state === "active" ? 0 : counts ? Math.min(failedBefore + 1, 99) : failedBefore;
    const working = state === "active" || (was.working && failedChecks < domainDownAfter);
    const since = !previous || working !== was.working ? now.getTime() : was.since;
    const failedAt = counts ? now.getTime() : state === "active" ? undefined : lastFailedAt;
    const status: StoredDomainStatus = {
      domain,
      state,
      message,
      checkedAt: now.getTime(),
      working,
      ...(since !== null ? { since } : {}),
      failedChecks,
      ...(failedAt !== undefined ? { lastFailedAt: failedAt } : {}),
    };
    // The domain may have changed while DNS was resolving.
    if ((getSetting(deps.db, "panelDomain") ?? null) !== domain) return status;
    setSetting(deps.db, "panelDomainStatus", status);
    if (before?.state !== state || before?.domain !== domain || working !== was.working) {
      deps.live.publish("panel", { type: "invalidate", ops: ["settings.general", "settings.panelAccess", "system.features", "mcp.info"] });
    }
    return status;
  };

  const { all, panel } = nodeAddresses(deps);
  let found: string[];
  try {
    found = await probes.resolve(domain);
  } catch {
    found = [];
  }
  if (found.length === 0) {
    return save(
      "pending_dns",
      panel ? `Add an A record for ${domain} pointing at ${panel}.` : `Add an A record for ${domain} pointing at the panel node.`,
    );
  }
  if (!found.some((ip) => all.has(ip))) {
    return save(
      "pending_dns",
      `${domain} points at ${found.join(", ")}, not at a node of this panel${panel ? ` (expected ${panel})` : ""}. DNS changes can take a while.`,
    );
  }
  if (!(await probes.https(domain, testCa(deps.config?.dataDir)))) {
    return save("issuing_certificate", `DNS is right. Waiting for a certificate and for https://${domain} to answer.`);
  }
  return save("active", "");
}

/**
 * Whether the domain is checked on every run (5 minutes): while IP access
 * is closed or meant to be, the domain is what keeps the panel reachable,
 * and the debounce needs its second check within minutes, not an hour.
 */
export function checksOftenForIpAccess(deps: Pick<Deps, "db">): boolean {
  return !readPanelAccessWanted(deps).serveOnIp || readIpAccessApplied(deps).closed;
}

export const domainCheckJob = defineJob<Record<string, unknown>>({
  type: domainCheckJobType,
  maxAttempts: 1,
  async run(_payload, ctx) {
    const status = getSetting(ctx.db, "panelDomainStatus");
    const domain = getSetting(ctx.db, "panelDomain") ?? null;
    // Active domains are re-checked hourly while IP access is open; pending ones on every run.
    const hourly = !checksOftenForIpAccess(ctx);
    if (hourly && domain && status?.domain === domain && status.state === "active" && Date.now() - status.checkedAt < 60 * 60 * 1000)
      return;
    const before = domainWorking(status, domain);
    const after = await checkDomain(ctx);
    // The domain just went live, so nodes that joined over an IP address move to it now.
    if (after?.state === "active" && !(status?.state === "active" && status.domain === after.domain)) askNodesToMove(ctx);
    // The domain is a private path: IP access may close or reopen with it.
    const now = domainWorking(getSetting(ctx.db, "panelDomainStatus"), getSetting(ctx.db, "panelDomain") ?? null);
    if (now.working !== before.working) {
      applyPanelIpAccess(ctx, now.working ? "the panel domain works again" : "the panel domain stopped working");
    }
  },
});

export function nodeExists(deps: Pick<Deps, "db">, nodeId: string): boolean {
  return deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).get() !== undefined;
}
