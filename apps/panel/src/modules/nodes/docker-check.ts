// The Docker version check (node.docker-check.v1, added in 0.2.5): agents
// look for a newer Docker Engine by themselves, shortly after they start
// and then about once a day, and report it in NodeFacts.docker_update.
// The panel keeps the newest report per node (nodes.docker_update), also
// from nodes.updateDocker (what its dry run or upgrade found, and the
// upgrade's UpdateResult), and shows it as the node's `docker`: whether the
// Machine card's Docker version has a newer one and whether "Update
// Docker" has anything to do. Older agents report nothing, so their nodes
// have no `docker` and the screens stay as they were.

import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { DockerUpdateInfo, NodeFacts, UpdateResult } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { isNewer, parseVersion } from "../../agent-hub/version";
import type { PanelDb } from "../../db/client";
import { type DockerUpdateJson, nodes } from "../../db/schema";

/** Advertised by agents that report NodeFacts.docker_update (update.DockerCheckCapability). */
export const dockerCheckCapability = "node.docker-check.v1";

/**
 * A report this old no longer says "up to date": the agent checks daily,
 * so its checks have been failing. "Update Docker" is offered again, and
 * its dry run shows what is wrong.
 */
export const dockerCheckStaleMs = 2 * 24 * 60 * 60_000;

/** The node's agent reports Docker checks: its live facts, else the last ones stored. */
export function checksDocker(facts: NodeFacts | null): boolean {
  return facts?.capabilities.includes(dockerCheckCapability) ?? false;
}

/** One finding, before it is stored. */
type Finding = Omit<DockerUpdateJson, "agentCheckedAt">;

/** An agent's report; null without a time (nothing to order it by). */
export function reportFromAgent(info: DockerUpdateInfo | undefined): Finding | null {
  if (!info?.checkedAt) return null;
  return {
    installed: info.installed,
    candidate: info.candidate,
    packageManager: info.packageManager,
    checkedAt: timestampDate(info.checkedAt).toISOString(),
    updatable: info.updatable,
    reason: info.reason,
  };
}

function storedReport(db: PanelDb, nodeId: string): { row: boolean; report: DockerUpdateJson | null } {
  const row = db.select({ dockerUpdate: nodes.dockerUpdate }).from(nodes).where(eq(nodes.id, nodeId)).get();
  return { row: Boolean(row), report: row?.dockerUpdate ?? null };
}

/**
 * Stores what the agent found (its facts, or a Docker UpdateResult) unless
 * it already sent one at least as new. Agent times are only compared with
 * agent times, so a clock that is off never hides a newer finding, and the
 * facts an agent sends again on every connect change nothing. True when
 * written.
 */
export function recordAgentFinding(db: PanelDb, nodeId: string, finding: Finding): boolean {
  const stored = storedReport(db, nodeId);
  const at = Date.parse(finding.checkedAt);
  if (!stored.row || !Number.isFinite(at)) return false;
  const last = stored.report?.agentCheckedAt;
  if (last && Date.parse(last) >= at) return false;
  db.update(nodes)
    .set({ dockerUpdate: { ...finding, agentCheckedAt: finding.checkedAt } })
    .where(eq(nodes.id, nodeId))
    .run();
  return true;
}

/**
 * What nodes.updateDocker's agent answer found (a dry run, or the start of
 * an upgrade): installed and candidate, found just now, so it is the newest
 * finding whatever the agent's clock says. The package manager is the one
 * the node reported before.
 */
export function recordUpdateDockerAnswer(db: PanelDb, nodeId: string, answer: { fromVersion: string; toVersion: string }): boolean {
  const stored = storedReport(db, nodeId);
  if (!stored.row || !answer.fromVersion) return false;
  const report: DockerUpdateJson = {
    installed: answer.fromVersion,
    candidate: answer.toVersion || answer.fromVersion,
    packageManager: stored.report?.packageManager ?? "",
    checkedAt: new Date().toISOString(),
    updatable: true,
    reason: "",
    agentCheckedAt: stored.report?.agentCheckedAt ?? null,
  };
  db.update(nodes).set({ dockerUpdate: report }).where(eq(nodes.id, nodeId)).run();
  return true;
}

/** A Docker upgrade that succeeded: its new version is installed and the newest one offered. */
export function recordDockerUpgraded(db: PanelDb, nodeId: string, result: UpdateResult): boolean {
  if (!result.success || !result.toVersion) return false;
  const finding: Finding = {
    installed: result.toVersion,
    candidate: result.toVersion,
    packageManager: storedReport(db, nodeId).report?.packageManager ?? "",
    checkedAt: (result.finishedAt ? timestampDate(result.finishedAt) : new Date()).toISOString(),
    updatable: true,
    reason: "",
  };
  // finishedAt is on the agent's clock, like its facts (which say the same once the upgrade is done).
  return recordAgentFinding(db, nodeId, finding);
}

/** The node's `docker` output (ops/nodes.ts NodeDocker). */
export interface NodeDockerView {
  version: string;
  latest: string | null;
  updateAvailable: boolean | null;
  checkedAt: string;
  reason: string | null;
}

/**
 * The node's `docker`, or undefined while nothing is known (an older agent,
 * no report yet). The version is the one Docker reports running
 * (NodeFacts.docker_version), so an update made by hand since the check
 * counts; the package's own version stands in when that is unreadable.
 */
export function dockerView(report: DockerUpdateJson | null, facts: NodeFacts | null, now = Date.now()): NodeDockerView | undefined {
  if (!report || !checksDocker(facts)) return undefined;
  const running = parseVersion(facts?.dockerVersion) ? (facts?.dockerVersion ?? "") : report.installed;
  const version = running || report.installed;
  if (!report.updatable) {
    return {
      version,
      latest: null,
      updateAvailable: null,
      checkedAt: report.checkedAt,
      reason: report.reason || "The agent cannot update Docker on this node.",
    };
  }
  const newer = isNewer(report.candidate, report.installed) && isNewer(report.candidate, version);
  const fresh = now - Date.parse(report.checkedAt) < dockerCheckStaleMs;
  return {
    version,
    latest: report.candidate || null,
    updateAvailable: newer ? true : fresh ? false : null,
    checkedAt: report.checkedAt,
    reason: null,
  };
}
