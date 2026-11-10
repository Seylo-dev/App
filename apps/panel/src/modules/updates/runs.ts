// Update runs: the panel first, then every node one at a time. A run is
// rows (update_runs, update_steps); the "updates.run" job advances it one
// step at a time and re-enqueues itself while a step is in flight, so a
// run survives the panel restarting into its new version.
//
//   panel step   UpdatePanel on the panel node's agent; done when this panel
//                runs the target version (the job resumes after the swap)
//                or a durable UpdateResult arrives
//   agent step   UpdateAgent with the verified manifest; done when the node
//                reconnects with the target version or an UpdateResult arrives;
//                a node offline when the step comes up, or that drops while
//                UpdateAgent is in flight, is skipped with retry "waiting" and
//                gets the update in a run of its own when it reconnects
//                (catch-up.ts); a busy node (ABORTED: another update holds its
//                lock) gets UpdateAgent again with a backoff until the step's
//                deadline
//   docker step  single-step runs from nodes.updateDocker, finished by UpdateResult
//
// A run keeps the verified manifest it installs (update_runs.manifest), so a
// check that finds a newer release, or a switch of the release channel,
// never changes what a run in progress sends. A failed step fails the run
// and skips the rest. A step that times out raises an update_failed alert;
// a timed-out agent step is tried once more on its own (retry "waiting"
// until retryAt, catch-up.ts). The alert is resolved when the step's version
// arrives after all (resolveTimedOutAlerts).

import { timestampDate } from "@bufbuild/protobuf/wkt";
import { OpError } from "@seylo/ops";
import { type UpdateResult, UpdateTarget } from "@seylo/proto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { compareVersions, isNewer, parseVersion } from "../../agent-hub/version";
import type { Principal } from "../../auth/principal";
import type { PanelDb } from "../../db/client";
import {
  jobs,
  nodes,
  servicePlacements,
  services,
  type UpdateRunTrigger,
  type UpdateStepRetry,
  type UpdateStepStatus,
  updateRuns,
  updateSteps,
} from "../../db/schema";
import type { Deps } from "../../deps";
import { defineJob, type JobContext } from "../../jobs/queue";
import { getSetting, setSetting } from "../../settings";
import { panelServiceId } from "../nodes/panel-service";
import { enqueueNext } from "../nodes/recurring";
import { fetchRelease, ReleaseError } from "./manifest";
import { type RunRelease, releaseChannel, rememberRunningRelease, runRelease, storedCheck, storedRelease } from "./release-state";
import { forgetRollback, noteUpdateResult, panelKey, panelNodeId, wasRolledBack } from "./rollbacks";
import "./settings";

/** A step not finished in this long fails the run. */
export const stepTimeoutMs = 10 * 60_000;
const pollMs = 5_000;
/** The error of a step that timed out. */
export const stepTimeoutError = "The update did not finish in time.";
/** A timed-out agent step is tried again this long after (once: a retry that times out too is left to Update now). */
export const timeoutRetryMs = 5 * 60_000;
/**
 * UpdateAgent's deadline. Since 0.2.1 the agent waits up to a minute for a
 * panel swap that holds its update lock (it leaves 30 seconds of the
 * deadline to the download), then downloads and checks the new binary.
 */
export const updateAgentTimeoutMs = 2 * 60_000;
/** A busy node gets UpdateAgent again after this, then twice as long each time up to busyRetryMaxMs, within the step's deadline. */
export const busyRetryMs = 5_000;
const busyRetryMaxMs = 60_000;
/**
 * How long a Docker update (nodes.updateDocker) may go without its
 * UpdateResult. The agent reports only once the package manager is done and
 * keeps nothing across a restart, so a restart mid-upgrade, a dead node or
 * a removed one would otherwise leave the run, which holds every other
 * update run and catch-up back, running for good.
 */
export const dockerStepTimeoutMs = 60 * 60_000;
const dockerPollMs = 30_000;
export const dockerNoResultError =
  "No result from the node within an hour: its agent restarted during the Docker update or the node is gone. Check `docker version` on the node.";
const dockerNodeRemovedError = "The node was removed before its Docker update reported back.";
export const checkIntervalSeconds = 6 * 3600;

export type RunRow = typeof updateRuns.$inferSelect;
type StepRow = typeof updateSteps.$inferSelect;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const stepStatus = (s: UpdateStepStatus) => (s === "rolled_back" ? "rolledBack" : s);
const stepRetry = (r: UpdateStepRetry | null) => (r === "up_to_date" ? "upToDate" : r);

/** The message of an agent step skipped because its node was offline. */
export const offlineSkipMessage = "The node is offline; it gets the update when it reconnects.";

export function toRun(db: PanelDb, run: RunRow) {
  const steps = db
    .select({ step: updateSteps, nodeName: nodes.name })
    .from(updateSteps)
    .leftJoin(nodes, eq(nodes.id, updateSteps.nodeId))
    .where(eq(updateSteps.runId, run.id))
    .orderBy(asc(updateSteps.position))
    .all();
  const done = steps.filter((s) => !["pending", "running"].includes(s.step.status)).length;
  return {
    id: run.id,
    targetVersion: run.targetVersion,
    trigger: run.trigger,
    status: run.status,
    startedBy: run.startedBy,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    finishedAt: iso(run.finishedAt),
    doneSteps: done,
    totalSteps: steps.length,
    steps: steps.map(({ step, nodeName }) => ({
      id: step.id,
      position: step.position,
      target: step.target,
      nodeId: step.nodeId,
      nodeName: nodeName ?? null,
      fromVersion: step.fromVersion,
      toVersion: step.toVersion,
      status: stepStatus(step.status) as never,
      error: step.error,
      startedAt: iso(step.startedAt),
      finishedAt: iso(step.finishedAt),
      retry: stepRetry(step.retry) as never,
      retryRunId: step.retryRunId,
      retryAt: iso(step.retryAt),
    })),
  };
}

/** Queues the run job for every running run that has none waiting (panel start). */
export function watchRunningRuns(deps: Pick<Deps, "db" | "jobs">): void {
  for (const run of deps.db.select({ id: updateRuns.id }).from(updateRuns).where(eq(updateRuns.status, "running")).all()) {
    const waiting = deps.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "updates.run"),
          inArray(jobs.status, ["queued", "running"]),
          sql`json_extract(${jobs.payload}, '$.runId') = ${run.id}`,
        ),
      )
      .get();
    if (!waiting) deps.jobs.enqueue("updates.run", { runId: run.id }, { dedupeKey: `updates.run:${run.id}:watch` });
  }
}

export function activeRun(db: PanelDb): RunRow | undefined {
  return db.select().from(updateRuns).where(eq(updateRuns.status, "running")).orderBy(desc(updateRuns.createdAt)).get();
}

export function agentVersion(deps: Pick<Deps, "agents">, row: typeof nodes.$inferSelect): string | null {
  return deps.agents.state.get(row.id)?.facts?.agentVersion || row.agentVersion;
}

/** Only the owner changes the release channel. */
export function isOwner(principal: Principal | undefined): boolean {
  return principal !== undefined && principal.type !== "anonymous" && principal.user.role === "owner";
}

/** The update status op output. `principal` is the caller, for canChangeChannel. */
export function updateStatus(deps: Pick<Deps, "db" | "agents" | "config"> & { principal?: Principal }) {
  const check = storedCheck(deps.db);
  const latest = check?.latestVersion ?? null;
  const run = activeRun(deps.db);
  const updateAvailable = isNewer(latest, deps.config.version);
  return {
    autoUpdate: getSetting(deps.db, "autoUpdate") ?? false,
    channel: releaseChannel(deps.db),
    canChangeChannel: isOwner(deps.principal),
    panel: {
      currentVersion: deps.config.version,
      latestVersion: latest,
      updateAvailable,
      offeredVersion: updateAvailable ? latest : null,
      latestIsPrerelease: (parseVersion(latest)?.pre ?? "") !== "",
      changelogUrl: check?.changelogUrl ?? null,
    },
    lastCheckedAt: check?.checkedAt ?? null,
    checkError: check?.error ?? null,
    nodes: deps.db
      .select()
      .from(nodes)
      .orderBy(desc(nodes.isPanelNode), asc(nodes.name))
      .all()
      .map((row) => {
        const version = agentVersion(deps, row);
        return {
          nodeId: row.id,
          name: row.name,
          online: deps.agents.isOnline(row.id),
          version,
          updateAvailable: latest !== null && isNewer(latest, version),
        };
      }),
    activeRun: run ? toRun(deps.db, run) : null,
  };
}

/**
 * Fetches and verifies the newest manifest on the release channel and
 * stores the result (also failures, for the UI). A failed check keeps the
 * last good release of the same channel.
 */
export async function checkNow(deps: Pick<Deps, "db" | "logger" | "config">): Promise<void> {
  const channel = releaseChannel(deps.db);
  const previous = storedCheck(deps.db);
  // The running release's minAgent outlives a check that finds a newer one.
  rememberRunningRelease(deps.db, deps.config.version, previous);
  try {
    const release = await fetchRelease(channel);
    rememberRunningRelease(deps.db, deps.config.version, { latestVersion: release.manifest.version, minAgent: release.manifest.minAgent });
    setSetting(deps.db, "updateCheck", {
      checkedAt: new Date().toISOString(),
      latestVersion: release.manifest.version,
      changelogUrl: release.manifest.changelogUrl,
      error: null,
      minAgent: release.manifest.minAgent,
      manifestBase64: Buffer.from(release.bytes).toString("base64"),
      signatureBase64: Buffer.from(release.signature).toString("base64"),
      channel,
    });
  } catch (error) {
    const message = error instanceof ReleaseError ? error.message : "Checking for updates failed.";
    if (!(error instanceof ReleaseError)) deps.logger.warn({ err: error }, "update check failed");
    // Keep the last good release so a flaky network does not hide an update.
    setSetting(deps.db, "updateCheck", {
      ...(previous ?? { latestVersion: null, changelogUrl: null }),
      checkedAt: new Date().toISOString(),
      error: message,
      channel,
    });
  }
}

/**
 * Inserts a run with its steps and queues the job that advances it. A new
 * agent step for a node supersedes its older steps still waiting for it to
 * reconnect.
 */
export function createRun(
  deps: Pick<Deps, "db" | "jobs">,
  run: { release: RunRelease; trigger: UpdateRunTrigger; startedBy: string | null },
  steps: Omit<typeof updateSteps.$inferInsert, "runId" | "position">[],
  beforeInsert?: (tx: Parameters<Parameters<PanelDb["transaction"]>[0]>[0], runId: string) => void,
): RunRow {
  const created = deps.db.transaction((tx) => {
    const row = tx
      .insert(updateRuns)
      .values({
        targetVersion: run.release.version,
        trigger: run.trigger,
        startedBy: run.startedBy,
        manifest: run.release.manifestBase64,
        manifestSignature: run.release.signatureBase64,
      })
      .returning()
      .get();
    beforeInsert?.(tx, row.id);
    const now = new Date();
    for (const [position, step] of steps.entries()) {
      if (step.target === "agent" && step.nodeId) {
        tx.update(updateSteps)
          .set({ retry: "superseded", retryAt: now })
          .where(and(eq(updateSteps.nodeId, step.nodeId), eq(updateSteps.retry, "waiting")))
          .run();
      }
      tx.insert(updateSteps)
        .values({ ...step, position, runId: row.id })
        .run();
    }
    return row;
  });
  deps.jobs.enqueue("updates.run", { runId: created.id }, { dedupeKey: `updates.run:${created.id}` });
  return created;
}

/**
 * Creates a run to the latest verified release: the panel step when the
 * panel is older, then one agent step per node whose agent is older (or
 * just `onlyNodeId`, when it is older or its version is unknown). Fails
 * with CONFLICT while another run is active or when there is nothing to
 * update.
 *
 * An automatic run leaves out a node whose update to this release was
 * rolled back, and does not start at all when the panel's own update to it
 * was (rollbacks.ts): UpdateAgent and UpdatePanel install what they are
 * asked for, so retrying would loop install / roll back every check. A run
 * a person starts includes them and clears those records.
 */
export function startRun(
  deps: Pick<Deps, "db" | "agents" | "config" | "jobs">,
  options: { trigger: "auto" | "manual"; startedBy: string | null; panelOnly?: boolean; onlyNodeId?: string },
): RunRow {
  const release = storedRelease(deps.db);
  if (activeRun(deps.db)) throw new OpError("CONFLICT", "Another update is running. Wait for it to finish.");
  const auto = options.trigger === "auto";
  const steps: Omit<typeof updateSteps.$inferInsert, "runId" | "position">[] = [];
  if (!options.onlyNodeId && isNewer(release.version, deps.config.version)) {
    if (auto && wasRolledBack(deps.db, panelKey, release.version)) {
      // Nodes go after the panel; they wait with it.
      throw new OpError(
        "CONFLICT",
        `The panel's update to ${release.version} was rolled back. Update it by hand or wait for a newer release.`,
      );
    }
    steps.push({ target: "panel", fromVersion: deps.config.version, toVersion: release.version });
  }
  if (!options.panelOnly) {
    const rows = deps.db.select().from(nodes).orderBy(desc(nodes.isPanelNode), asc(nodes.name)).all();
    for (const row of rows) {
      if (options.onlyNodeId && row.id !== options.onlyNodeId) continue;
      if (row.disabledAt) continue;
      const version = agentVersion(deps, row);
      if (!options.onlyNodeId && !isNewer(release.version, version)) continue;
      // Never a downgrade, also on request: back on the stable channel a node
      // may run a newer pre-release than the release offered.
      if (options.onlyNodeId && parseVersion(version) && !isNewer(release.version, version)) {
        throw new OpError("CONFLICT", `${row.name} already runs ${version}, which is not older than ${release.version}.`);
      }
      if (auto && wasRolledBack(deps.db, row.id, release.version)) continue;
      steps.push({ target: "agent", nodeId: row.id, fromVersion: version, toVersion: release.version });
    }
    if (options.onlyNodeId && steps.length === 0) throw new OpError("NOT_FOUND", "No node with this id.");
  }
  if (steps.length === 0) throw new OpError("CONFLICT", "Everything already runs the latest version.");
  if (!auto) {
    // A person asked for this release here: it may be retried automatically again.
    for (const step of steps) forgetRollback(deps.db, step.target === "panel" ? panelKey : (step.nodeId as string), release.version);
  }
  return createRun(deps, { release, trigger: options.trigger, startedBy: options.startedBy }, steps);
}

function finishStep(db: PanelDb, stepId: string, status: UpdateStepStatus, error: string | null = null, extra: Partial<StepRow> = {}) {
  db.update(updateSteps)
    .set({ status, error, finishedAt: new Date(), ...extra })
    .where(eq(updateSteps.id, stepId))
    .run();
}

function finishRun(db: PanelDb, runId: string, status: "succeeded" | "failed", error: string | null = null) {
  db.update(updateRuns).set({ status, error, finishedAt: new Date() }).where(eq(updateRuns.id, runId)).run();
  if (status === "failed") {
    db.update(updateSteps)
      .set({ status: "skipped", finishedAt: new Date() })
      .where(and(eq(updateSteps.runId, runId), eq(updateSteps.status, "pending")))
      .run();
  }
}

/** The protected panel service on the panel node: the reserved id, else (older installs) any protected service there. */
function panelService(db: PanelDb, panelNodeId: string): string | null {
  const reserved = db
    .select({ id: services.id })
    .from(services)
    .innerJoin(servicePlacements, eq(servicePlacements.serviceId, services.id))
    .where(and(eq(services.id, panelServiceId), eq(servicePlacements.nodeId, panelNodeId)))
    .get();
  if (reserved) return reserved.id;
  return (
    db
      .select({ id: services.id })
      .from(services)
      .innerJoin(servicePlacements, eq(servicePlacements.serviceId, services.id))
      .where(and(eq(services.protected, true), eq(servicePlacements.nodeId, panelNodeId)))
      .orderBy(asc(services.createdAt))
      .get()?.id ?? null
  );
}

/** The panel never tries again sooner than this after an agent's wait, so an agent whose clock is behind cannot make it loop. */
export const minAgentWaitMs = 5 * 60_000;
/**
 * Nor later than this: the agent's longest wait is a day (and a rolled-back
 * release is held, not waited for), so a retryAfter past it is a clock far
 * ahead or a bad value. The catch-up then asks again and waits anew.
 */
export const maxAgentWaitMs = 24 * 3_600_000 + 30 * 60_000;

/**
 * A catch-up step (run trigger "reconnect", catch-up.ts) the agent answered
 * with its own wait. A release rolled back there is held, like the panel's
 * own rollback record. One whose automatic update failed there within the
 * hour waits again (retry "waiting") until the agent's retryAfter (between
 * minAgentWaitMs and maxAgentWaitMs from now), and the catch-up job is
 * queued for then.
 */
function agentWait(deps: Pick<Deps, "jobs">, step: StepRow, backoff: string, retryAfter: string | undefined): Partial<StepRow> {
  const now = Date.now();
  if (backoff === "rolledBack") return { retry: "held", retryAt: new Date(now) };
  const until = Date.parse(retryAfter ?? "");
  const wanted = Number.isNaN(until) ? now + 3_600_000 : until + 30_000;
  const retryAt = new Date(Math.min(Math.max(wanted, now + minAgentWaitMs), now + maxAgentWaitMs));
  deps.jobs.enqueue(
    "updates.catchUp",
    { nodeId: step.nodeId },
    { runAt: retryAt, dedupeKey: `updates.catchUp:${step.nodeId}:wait:${step.id}` },
  );
  return { retry: "waiting", retryAt };
}

type RunCtx = Pick<Deps, "db" | "agents" | "config" | "logger" | "live" | "jobs" | "alerts">;

/**
 * Agent steps whose UpdateAgent the node answered busy (ABORTED: another
 * update holds its lock, such as the panel swap that just brought this
 * panel up, or its own update on connect), by step id: when the panel
 * sends it again and how many times it was busy. Kept in memory; after a
 * panel restart such a step finishes by version or times out.
 */
const busySteps = new Map<string, { tries: number; at: number }>();

/** Advances a run by one step. Returns the delay before the job should look again, or null when the run is over. */
export async function advanceRun(ctx: RunCtx, runId: string): Promise<number | null> {
  const db = ctx.db;
  const run = db.select().from(updateRuns).where(eq(updateRuns.id, runId)).get();
  if (run?.status !== "running") return null;
  const steps = db.select().from(updateSteps).where(eq(updateSteps.runId, runId)).orderBy(asc(updateSteps.position)).all();
  const failed = steps.find((s) => s.status === "failed" || s.status === "rolled_back");
  if (failed) {
    finishRun(db, runId, "failed", failed.error ?? "An update step failed.");
    return null;
  }
  const step = steps.find((s) => s.status === "pending" || s.status === "running");
  if (!step) {
    finishRun(db, runId, "succeeded");
    return null;
  }
  const publish = () => ctx.live.publish("panel", { type: "invalidate", ops: ["updates.status", "updates.history", "nodes.list"] });

  if (step.status === "running" && step.target === "docker") {
    // Its UpdateResult finishes a Docker step (applyUpdateResult); the node
    // going offline is expected while Docker restarts. When that result is
    // lost (the agent restarted with Docker), the node's facts tell: once it
    // is back with another Docker version than the step started from (the
    // one it aimed for, when known), the update happened.
    const now = step.nodeId && ctx.agents.isOnline(step.nodeId) ? ctx.agents.state.get(step.nodeId)?.facts?.dockerVersion : undefined;
    if (now && step.fromVersion && now !== step.fromVersion && (!step.toVersion || step.toVersion === "latest" || step.toVersion === now)) {
      db.update(updateSteps).set({ toVersion: now }).where(eq(updateSteps.id, step.id)).run();
      finishStep(db, step.id, "succeeded");
      publish();
      return 0;
    }
    const error = !step.nodeId
      ? dockerNodeRemovedError
      : step.startedAt && Date.now() - step.startedAt.getTime() > dockerStepTimeoutMs
        ? dockerNoResultError
        : null;
    if (!error) return dockerPollMs;
    finishStep(db, step.id, "failed", error);
    if (error === dockerNoResultError && step.nodeId) {
      const name = db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, step.nodeId)).get()?.name ?? "a node";
      // Resolved if the result still comes (applyUpdateResult).
      ctx.alerts.raise({
        event: "update_failed",
        key: `update-failed:${step.id}`,
        title: `Docker update on ${name} did not report back`,
        message: dockerNoResultError,
        nodeId: step.nodeId,
      });
    }
    publish();
    return 0;
  }

  if (step.status === "running") {
    const doneByVersion =
      (step.target === "panel" && ctx.config.version === step.toVersion) ||
      (step.target === "agent" &&
        step.nodeId !== null &&
        ctx.agents.isOnline(step.nodeId) &&
        ctx.agents.state.get(step.nodeId)?.facts?.agentVersion === step.toVersion);
    if (doneByVersion) {
      busySteps.delete(step.id);
      finishStep(db, step.id, "succeeded");
      if (step.target === "agent" && step.nodeId) resolveTimedOutAlerts(ctx, step.nodeId, step.toVersion);
      publish();
      return 0;
    }
    if (step.startedAt && Date.now() - step.startedAt.getTime() > stepTimeoutMs) {
      busySteps.delete(step.id);
      timedOut(ctx, run, step);
      publish();
      return 0;
    }
    // A busy node gets UpdateAgent again when its backoff is over, if it is
    // connected: one that dropped may be restarting into the new version.
    const busy = busySteps.get(step.id);
    if (busy && step.target === "agent" && step.nodeId) {
      const wait = busy.at - Date.now();
      if (wait > 0) return Math.min(wait, pollMs);
      const release = runRelease(db, run);
      if (release && ctx.agents.isOnline(step.nodeId)) {
        try {
          return await sendUpdateAgent(ctx, run, step, release, busy.tries);
        } catch (error) {
          busySteps.delete(step.id);
          finishStep(db, step.id, "failed", error instanceof OpError ? error.message : "The update could not start.");
          publish();
          return 0;
        }
      }
    }
    return pollMs;
  }

  // Start the pending step.
  const start = () => db.update(updateSteps).set({ status: "running", startedAt: new Date() }).where(eq(updateSteps.id, step.id)).run();
  const release = runRelease(db, run);
  if (!release) {
    finishStep(db, step.id, "failed", "The release this run installs is no longer known. Check for updates and start the update again.");
    publish();
    return 0;
  }
  // A run from before 0.2.0-rc.2 (resumed after the panel's own update) keeps
  // its release from now on, for the nodes it skips (catch-up.ts).
  if (!run.manifest) {
    db.update(updateRuns)
      .set({ manifest: release.manifestBase64, manifestSignature: release.signatureBase64 })
      .where(eq(updateRuns.id, run.id))
      .run();
  }
  try {
    if (step.target === "panel") {
      const panelNode = db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get();
      const serviceId = panelNode ? panelService(db, panelNode.id) : null;
      if (!panelNode || !serviceId) {
        finishStep(db, step.id, "failed", "This panel does not run as a managed service on a node, so it cannot update itself.");
        publish();
        return 0;
      }
      start();
      publish();
      await ctx.agents.call(panelNode.id, "updatePanel", {
        updateId: step.id,
        serviceId,
        image: { reference: release.panelImage, digest: release.panelDigest },
        targetVersion: release.version,
      });
      return pollMs;
    }
    if (step.target === "agent" && step.nodeId) {
      if (!ctx.agents.supports(step.nodeId, "updateAgent")) {
        // An offline node gets the update when it reconnects (catch-up.ts).
        const online = ctx.agents.isOnline(step.nodeId);
        finishStep(
          db,
          step.id,
          "skipped",
          online ? "The agent cannot update itself remotely." : offlineSkipMessage,
          online ? {} : { retry: "waiting" },
        );
        publish();
        return 0;
      }
      // Agents also update themselves when they reconnect to a newer panel:
      // this one may already be there.
      if (ctx.agents.isOnline(step.nodeId) && ctx.agents.state.get(step.nodeId)?.facts?.agentVersion === step.toVersion) {
        finishStep(db, step.id, "succeeded");
        resolveTimedOutAlerts(ctx, step.nodeId, step.toVersion);
        publish();
        return 0;
      }
      start();
      publish();
      return await sendUpdateAgent(ctx, run, { ...step, status: "running" }, release, 0);
    }
    finishStep(db, step.id, "skipped");
    return 0;
  } catch (error) {
    busySteps.delete(step.id);
    const message = error instanceof OpError ? error.message : "The update could not start.";
    finishStep(db, step.id, "failed", message);
    publish();
    return 0;
  }
}

/**
 * Sends UpdateAgent for a running agent step (`busyTries`: how many times
 * the node was busy before) and records the answer. Returns the delay
 * before the run looks again. Errors it does not handle are thrown; the
 * caller fails the step with them.
 */
async function sendUpdateAgent(ctx: RunCtx, run: RunRow, step: StepRow, release: RunRelease, busyTries: number): Promise<number> {
  const db = ctx.db;
  const nodeId = step.nodeId as string;
  const publish = () => ctx.live.publish("panel", { type: "invalidate", ops: ["updates.status", "updates.history", "nodes.list"] });
  try {
    await ctx.agents.call(
      nodeId,
      "updateAgent",
      {
        manifest: release.manifest,
        manifestSignature: release.signature,
        targetVersion: release.version,
        updateId: step.id,
        // Not a person's choice: the agent waits as its own automatic updates do.
        automatic: run.trigger !== "manual",
      },
      { timeoutMs: updateAgentTimeoutMs },
    );
    // Accepted: the new version on reconnect or the UpdateResult finishes the step.
    busySteps.delete(step.id);
    return pollMs;
  } catch (error) {
    const details = error instanceof OpError ? error.details : undefined;
    if (details?.reason === "offline" && !ctx.agents.isOnline(nodeId)) {
      // Sent again after a busy answer: the node may be restarting into the
      // new version (its own update held the lock). It finishes by version,
      // or gets UpdateAgent again once it is back on the old one.
      if (busyTries > 0) return pollMs;
      // The node dropped while the call was in flight: like a node offline
      // when its step came up, it gets the update when it reconnects.
      finishStep(db, step.id, "skipped", offlineSkipMessage, { retry: "waiting" });
      publish();
      return 0;
    }
    // An automatic update of a release the agent rolled back, or that
    // failed there within the hour, waits (UpdateAgentRequest.automatic).
    if (details?.agentStatus === "FAILED_PRECONDITION" && details.backoff) {
      busySteps.delete(step.id);
      const retry = run.trigger === "reconnect" ? agentWait(ctx, step, details.backoff, details.retryAfter) : {};
      // Go error text starts in lower case; the history shows it as a sentence.
      const message = (error as OpError).message;
      finishStep(db, step.id, "skipped", message.charAt(0).toUpperCase() + message.slice(1), retry);
      publish();
      return 0;
    }
    if (details?.agentStatus === "ABORTED") {
      // Busy. Before 0.2.1 the panel only waited for the version, which
      // never came when the lock was the panel swap's (the agent waits for
      // that one itself since 0.2.1): send it again.
      const delay = Math.min(busyRetryMs * 2 ** busyTries, busyRetryMaxMs);
      busySteps.set(step.id, { tries: busyTries + 1, at: Date.now() + delay });
      ctx.logger.info(
        { runId: run.id, stepId: step.id, nodeId, busy: (error as OpError).message, attempt: busyTries + 1, retryInMs: delay },
        "node busy with another update; sending UpdateAgent again",
      );
      return Math.min(delay, pollMs);
    }
    if (details?.agentStatus === "ALREADY_EXISTS") {
      // The agent runs that version or a newer one (its facts may be older).
      busySteps.delete(step.id);
      finishStep(db, step.id, "succeeded");
      resolveTimedOutAlerts(ctx, nodeId, step.toVersion);
      publish();
      return 0;
    }
    busySteps.delete(step.id);
    throw error;
  }
}

/**
 * Fails a step that did not finish within stepTimeoutMs and raises the
 * update_failed alert a failed UpdateResult raises (same key, so a late
 * result does not alert twice). An agent step is tried once more after
 * timeoutRetryMs (retry "waiting"; the catch-up makes a run of its own),
 * unless its run is already that second try.
 */
function timedOut(ctx: RunCtx, run: RunRow, step: StepRow): void {
  const db = ctx.db;
  const node =
    step.target === "panel"
      ? db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.isPanelNode, true)).get()
      : step.nodeId
        ? db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.id, step.nodeId)).get()
        : undefined;
  if (step.target !== "panel" && !node) {
    // The node was removed meanwhile: nothing to alert about or try again.
    finishStep(db, step.id, "failed", stepTimeoutError);
    return;
  }
  let extra: Partial<StepRow> = {};
  let next: string;
  if (step.target === "agent" && node) {
    const secondTry =
      db
        .select({ id: updateSteps.id })
        .from(updateSteps)
        .where(and(eq(updateSteps.retryRunId, run.id), eq(updateSteps.status, "failed")))
        .get() !== undefined;
    if (secondTry) {
      next = "It was the second try. Update now in Settings > Updates tries again.";
    } else {
      const retryAt = new Date(Date.now() + timeoutRetryMs);
      ctx.jobs.enqueue(
        "updates.catchUp",
        { nodeId: node.id },
        { runAt: retryAt, dedupeKey: `updates.catchUp:${node.id}:timeout:${step.id}` },
      );
      extra = { retry: "waiting", retryAt };
      next = `The panel tries again in ${timeoutRetryMs / 60_000} minutes; Update now in Settings > Updates tries now.`;
    }
  } else {
    next = "Update the panel again in Settings > Updates.";
  }
  finishStep(db, step.id, "failed", stepTimeoutError, extra);
  const minutes = stepTimeoutMs / 60_000;
  const what =
    step.target === "panel"
      ? `The panel did not come back on ${step.toVersion} within ${minutes} minutes, and its node reported no result.`
      : `The node's agent did not reconnect on ${step.toVersion} within ${minutes} minutes and reported no result.`;
  ctx.alerts.raise({
    event: "update_failed",
    key: `update-failed:${step.id}`,
    title:
      step.target === "panel"
        ? `Update of the panel to ${step.toVersion} did not finish`
        : `Update to ${step.toVersion} did not finish on ${node?.name ?? "a node"}`,
    message: `${what} ${next}`,
    nodeId: node?.id ?? null,
    link: "/settings/updates",
  });
}

/**
 * Resolves the update_failed alerts of the node's agent steps that timed
 * out (timedOut) on their way to `version` or an older release: the node
 * runs it now after all (a late restart, the panel's retry, Update now, or
 * its own update on connect), so "did not finish on <node>" no longer holds.
 * The steps keep their status.
 */
export function resolveTimedOutAlerts(deps: Pick<Deps, "db" | "alerts">, nodeId: string, version: string | null | undefined): void {
  const reached = parseVersion(version);
  if (!reached) return;
  const steps = deps.db
    .select({ id: updateSteps.id, toVersion: updateSteps.toVersion })
    .from(updateSteps)
    .where(
      and(
        eq(updateSteps.nodeId, nodeId),
        eq(updateSteps.target, "agent"),
        eq(updateSteps.status, "failed"),
        eq(updateSteps.error, stepTimeoutError),
      ),
    )
    .all();
  for (const step of steps) {
    const wanted = parseVersion(step.toVersion);
    if (wanted && compareVersions(wanted, reached) <= 0) deps.alerts.resolve(`update-failed:${step.id}`);
  }
}

/** Runs being advanced right now; jobs for the same run never overlap. */
const advancing = new Set<string>();

export const runJob = defineJob<{ runId: string }>({
  type: "updates.run",
  maxAttempts: 3,
  async run(payload, ctx: JobContext) {
    if (advancing.has(payload.runId)) return;
    advancing.add(payload.runId);
    try {
      let delay = await advanceRun(ctx, payload.runId);
      // Quick steps chain without waiting for the next poll.
      while (delay === 0) delay = await advanceRun(ctx, payload.runId);
      if (delay !== null) enqueueNext(ctx, "updates.run", new Date(Date.now() + delay), payload);
    } finally {
      advancing.delete(payload.runId);
    }
  },
});

/** The scheduled release check (schedule "updates.check"); starts a run when auto-update is on. */
export const checkJob = defineJob<Record<string, never>>({
  type: "updates.check",
  async run(_payload, ctx) {
    await checkNow(ctx);
    if (getSetting(ctx.db, "autoUpdate") && !activeRun(ctx.db)) {
      try {
        startRun(ctx, { trigger: "auto", startedBy: null });
      } catch (error) {
        // Nothing to update, or no verified release yet.
        if (!(error instanceof OpError)) throw error;
      }
    }
  },
});

/**
 * A durable UpdateResult from an agent: finishes the step it names, when
 * that node is the one the step runs on (a node step on its own node, the
 * panel step on the panel's node); another node cannot finish it.
 */
export function applyUpdateResult(deps: Pick<Deps, "db" | "jobs" | "live" | "alerts">, nodeId: string, result: UpdateResult): void {
  // Also results no step names (the agent updating itself on connect).
  noteUpdateResult(deps.db, nodeId, result, panelNodeId(deps.db));
  // This node's agent runs that release now (agents always report toVersion), with or without a step.
  if (result.success && result.target === UpdateTarget.AGENT) resolveTimedOutAlerts(deps, nodeId, result.toVersion);
  const step = deps.db.select().from(updateSteps).where(eq(updateSteps.id, result.updateId)).get();
  if (!step) return;
  const runsOn = step.nodeId ?? deps.db.select({ id: nodes.id }).from(nodes).where(eq(nodes.isPanelNode, true)).get()?.id ?? null;
  // A step that timed out and then finished after all keeps its status
  // (its run already failed and skipped the rest), but not its alert.
  if (step.status === "failed" && step.error === stepTimeoutError) {
    if (result.success && runsOn === nodeId) deps.alerts.resolve(`update-failed:${step.id}`);
    return;
  }
  // A Docker step the panel stopped waiting for still takes its late result.
  const lateDocker = step.target === "docker" && step.status === "failed" && step.error === dockerNoResultError;
  if (!["pending", "running"].includes(step.status) && !lateDocker) return;
  if (runsOn !== nodeId) return;
  const status: UpdateStepStatus = result.success ? "succeeded" : result.rolledBack ? "rolled_back" : "failed";
  finishStep(deps.db, step.id, status, result.success ? null : result.error || "The update failed.", {
    fromVersion: result.fromVersion || step.fromVersion,
    toVersion: result.toVersion || step.toVersion,
    finishedAt: result.finishedAt ? timestampDate(result.finishedAt) : new Date(),
  });
  // The "did not report back" alert of a Docker step whose result came late after all.
  if (lateDocker && result.success) deps.alerts.resolve(`update-failed:${step.id}`);
  const others = deps.db
    .select({ id: updateSteps.id })
    .from(updateSteps)
    .where(and(eq(updateSteps.runId, step.runId), inArray(updateSteps.status, ["pending", "running"])))
    .all();
  if (step.target === "docker" && others.length === 0) {
    finishRun(
      deps.db,
      step.runId,
      result.success ? "succeeded" : "failed",
      result.success ? null : result.error || "The Docker update failed.",
    );
  } else {
    deps.jobs.enqueue("updates.run", { runId: step.runId }, { dedupeKey: `updates.run:${step.runId}:result:${step.id}` });
  }
  deps.live.publish("panel", { type: "invalidate", ops: ["updates.status", "updates.history", "nodes.list"] });
}

export function history(db: PanelDb, limit: number, before?: string) {
  const rows = db
    .select()
    .from(updateRuns)
    .where(before ? lt(updateRuns.createdAt, new Date(before)) : undefined)
    .orderBy(desc(updateRuns.createdAt))
    .limit(limit + 1)
    .all();
  return { runs: rows.slice(0, limit).map((run) => toRun(db, run)), hasMore: rows.length > limit };
}
