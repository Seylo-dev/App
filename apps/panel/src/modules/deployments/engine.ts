// The deploy runner: a small state machine per deployment that survives
// panel restarts. Nothing waits in memory for long: every step is written
// to the deployment row, and the runner is kicked again by agent events
// (build and deploy progress, state changes), by the ops, and by the
// deployments.tick job (timeouts, and recovery after a restart).
//
//   queued     waits until no other deploy of the service runs, then starts
//   building   a node builds and pushes to the panel registry; its stream
//              gives log lines, and the durable BuildProgress gives the result
//   deploying  the service's target deployment is switched to this one and
//              the desired state is marked dirty; each node reports the
//              rollout (DeployProgress, then its state)
//   live       every node serves it; the previous live one is superseded
//   failed / cancelled   the target goes back to the live deployment, so
//              the old version keeps serving
//
// Runs of one service are serialized (one chain per service), so two kicks
// can never start the same deployment twice.

import { open as openFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { OpError } from "@seylo/ops";
import {
  type BuildProgress,
  BuildStage,
  type DeployProgress,
  DeployStage,
  HealthState,
  InstanceState,
  ServicePhase,
  UploadBuildContextRequestSchema,
} from "@seylo/proto";
import { and, asc, desc, eq, inArray, isNull, max, ne } from "drizzle-orm";
import type { AgentStream } from "../../agent-hub/calls";
import { builds, type DeployStep, deployments, nodes, servicePlacements, services, sourceUploads } from "../../db/schema";
import type { Deps } from "../../deps";
import type { RefusedSpec } from "../../desired";
import { sealDeploymentEnv } from "../env/desired";
import { dataVolumes } from "../services/insert";
import { restoreProjectMove } from "../services/project-move-restore";
import { loadService } from "../services/rows";
import { assertImageAllowed } from "../services/source-guard";
import { needsBuild, readSpec, runSettingsOf } from "../services/spec";
import { appendLog, LineSplitter } from "./logs";
import { registryGcJobType } from "./registry-gc";
import { pickBuildNode, resolveBuild, sourceBranch } from "./source";
import { closeSteps, type DeploymentRow, initialSteps, isFinal, publishDeploymentChange, setStep } from "./store";

/** A build that has not finished after this long failed. */
export const buildTimeoutMs = 90 * 60_000;
/** Extra time on top of the health timeout for pulling and switching. */
const rolloutGraceMs = 5 * 60_000;

export interface Engine {
  /** Advances a deployment as far as it can go now. Never throws. */
  kick(deploymentId: string): void;
  /** Resolves when no kick is running (tests). */
  idle(): Promise<void>;
  /** Called by the build stream and agent events. */
  readonly deps: Deps;
}

interface EngineState {
  deps: Deps;
  chains: Map<string, Promise<void>>;
  /** Build ids whose stream is being read in this process. */
  streams: Map<string, { cancel(): void }>;
  /** Builds this process already tried to re-attach to after a restart. */
  reattached: Set<string>;
  pending: Set<Promise<void>>;
}

const engines = new WeakMap<object, EngineState>();

export function engineFor(deps: Deps): Engine {
  let state = engines.get(deps.db);
  if (!state) {
    state = { deps, chains: new Map(), streams: new Map(), reattached: new Set(), pending: new Set() };
    engines.set(deps.db, state);
  }
  // The latest deps win: tests swap deps.agents for a fake before any op runs.
  state.deps = deps;
  const s = state;
  return {
    get deps() {
      return s.deps;
    },
    kick: (deploymentId) => kick(s, deploymentId),
    async idle() {
      while (s.pending.size > 0) await Promise.allSettled([...s.pending]);
    },
  };
}

function kick(s: EngineState, deploymentId: string): void {
  const row = s.deps.db.select({ serviceId: deployments.serviceId }).from(deployments).where(eq(deployments.id, deploymentId)).get();
  if (!row) return;
  const previous = s.chains.get(row.serviceId) ?? Promise.resolve();
  const next = previous
    .then(() => advance(s, deploymentId))
    .catch((error) => s.deps.logger.error({ err: error, deploymentId }, "deploy runner failed"));
  s.chains.set(row.serviceId, next);
  s.pending.add(next);
  void next.finally(() => {
    s.pending.delete(next);
    if (s.chains.get(row.serviceId) === next) s.chains.delete(row.serviceId);
  });
}

function load(s: EngineState, id: string): DeploymentRow | undefined {
  return s.deps.db.select().from(deployments).where(eq(deployments.id, id)).get();
}

function save(s: EngineState, id: string, patch: Partial<typeof deployments.$inferInsert>): DeploymentRow {
  return s.deps.db.update(deployments).set(patch).where(eq(deployments.id, id)).returning().get();
}

function log(s: EngineState, d: DeploymentRow, step: DeployStep["key"], text: string, error = false) {
  appendLog(s.deps, d.serviceId, d.id, step, text.split("\n"), error);
}

function nodeName(s: EngineState, nodeId: string): string {
  return s.deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? "removed node";
}

async function advance(s: EngineState, id: string): Promise<void> {
  const d = load(s, id);
  if (!d || isFinal(d.status)) return;
  const svc = s.deps.db.select().from(services).where(eq(services.id, d.serviceId)).get();
  if (!svc) return void finish(s, d, "cancelled", "The service was deleted.");

  switch (d.status) {
    case "queued":
      return start(s, d);
    case "building":
      return checkBuild(s, d);
    case "deploying":
      return checkRollout(s, d);
  }
}

/** Starts a queued deployment unless another one of the service is ahead of it. */
async function start(s: EngineState, d: DeploymentRow): Promise<void> {
  const { db } = s.deps;
  const ahead = db
    .select({ id: deployments.id, status: deployments.status, createdAt: deployments.createdAt })
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, d.serviceId),
        inArray(deployments.status, ["queued", "building", "deploying"]),
        ne(deployments.id, d.id),
      ),
    )
    .all();
  if (
    ahead.some(
      (o) => o.status !== "queued" || o.createdAt < d.createdAt || (o.createdAt.getTime() === d.createdAt.getTime() && o.id < d.id),
    )
  )
    return;
  // A move copies volumes first (services/move.ts); it kicks again when done.
  if (d.moveCopying) return;
  // Deployments it waits for (a template's database) kick it when they finish.
  if (d.waitFor.length > 0) {
    const waiting = db.select({ status: deployments.status }).from(deployments).where(inArray(deployments.id, d.waitFor)).all();
    if (waiting.some((w) => !isFinal(w.status))) return;
  }

  const svc = loadService(db, d.serviceId);
  const spec = readSpec(svc.spec);
  const targets = db
    .select({ nodeId: servicePlacements.nodeId })
    .from(servicePlacements)
    .where(eq(servicePlacements.serviceId, svc.id))
    .all()
    .map((p) => p.nodeId)
    // A move with volumes rolls out only on the new node; the old one keeps its stopped copy meanwhile.
    .filter((id) => !(d.trigger === "move" && id === d.movedFromNodeId && dataVolumes(db, svc.id).length > 0));
  if (targets.length === 0) return void finish(s, d, "failed", "The service is not placed on any node.");

  const now = new Date();
  const build = d.imageRef === null && needsBuild(spec);
  const base = save(s, d.id, {
    startedAt: now,
    phaseStartedAt: now,
    targetNodeIds: targets,
    runSettings: (d.runSettings ?? runSettingsOf(spec)) as unknown as Record<string, unknown>,
    envSealed: d.envSealed ?? sealDeploymentEnv(s.deps, svc.id),
    steps: d.steps.length > 0 ? d.steps : initialSteps(build),
  });

  if (!build) {
    if (base.imageRef === null) {
      if (spec.source.type !== "image")
        return void finish(s, base, "failed", "Set a source first: a repository, an image or a Dockerfile.");
      try {
        assertImageAllowed(spec.source.image);
      } catch (error) {
        return void finish(s, base, "failed", error instanceof Error ? error.message : String(error));
      }
      save(s, d.id, { imageRef: spec.source.image });
    }
    return rollout(s, load(s, d.id) as DeploymentRow);
  }

  // The image is pushed to the panel registry on the panel's node: no point building while it is gone.
  const registryNode = db.select({ id: nodes.id, name: nodes.name }).from(nodes).where(eq(nodes.isPanelNode, true)).get();
  if (!registryNode)
    return void finish(s, base, "failed", "No node runs the panel's image registry yet, so built images have nowhere to go.");
  if (!s.deps.agents.isOnline(registryNode.id)) {
    return void finish(
      s,
      base,
      "failed",
      `The panel's image registry is on ${registryNode.name}, which is offline. Try again when it is back.`,
    );
  }

  let buildNode: { id: string; name: string };
  try {
    buildNode = pickBuildNode(s.deps, spec, targets);
  } catch (error) {
    return void finish(s, base, "failed", error instanceof OpError ? error.message : "No node can build.");
  }
  const buildRow = db
    .insert(builds)
    .values({
      deploymentId: d.id,
      nodeId: buildNode.id,
      builder: spec.source.type === "inline" ? "dockerfile" : spec.build.builder,
      status: "running",
      startedAt: now,
    })
    .returning()
    .get();
  // Recorded before the source is fetched, so a deploy whose clone fails still says which branch it tried.
  const branch = d.branch ?? sourceBranch(spec.source);
  let current = save(s, d.id, {
    status: "building",
    builtOnNodeId: buildNode.id,
    branch,
    steps: setStep(setStep(base.steps, "clone", "running", { nodeId: buildNode.id, detail: "Fetching source" }), "build", "pending", {
      nodeId: buildNode.id,
    }),
  });
  publishDeploymentChange(s.deps, d.serviceId, d.id);
  log(s, current, "clone", `Building on ${buildNode.name}.`);

  let resolved: Awaited<ReturnType<typeof resolveBuild>>;
  try {
    resolved = await resolveBuild(s.deps, {
      service: svc,
      spec,
      buildId: buildRow.id,
      generation: d.generation,
      commitSha: d.commitSha,
      uploadId: d.uploadId,
    });
  } catch (error) {
    db.update(builds)
      .set({ status: "failed", finishedAt: new Date(), error: messageOf(error) })
      .where(eq(builds.id, buildRow.id))
      .run();
    return void finish(s, load(s, d.id) as DeploymentRow, "failed", `Could not fetch the source: ${messageOf(error)}`);
  }
  current = save(s, d.id, {
    imageRef: resolved.request.imageReference,
    // What the push said wins; the source lookup fills the gaps (manual deploys).
    commitSha: resolved.commit?.sha ?? d.commitSha,
    commitMessage: d.commitMessage ?? resolved.commit?.message ?? null,
    commitAuthor: d.commitAuthor ?? resolved.commit?.author ?? null,
    branch: d.branch ?? resolved.commit?.branch ?? branch,
    steps: setStep(load(s, d.id)?.steps ?? current.steps, "clone", "running", { detail: resolved.cloneDetail }),
  });
  log(s, current, "clone", `Source: ${resolved.cloneDetail}. Builder: ${resolved.builderLabel}.`);

  if (resolved.request.source?.source.case === "uploadId") {
    try {
      await uploadContext(s, buildNode.id, d.uploadId as string);
    } catch (error) {
      db.update(builds)
        .set({ status: "failed", finishedAt: new Date(), error: messageOf(error) })
        .where(eq(builds.id, buildRow.id))
        .run();
      return void finish(
        s,
        load(s, d.id) as DeploymentRow,
        "failed",
        `Could not send the archive to ${buildNode.name}: ${messageOf(error)}`,
      );
    }
  }

  let stream: AgentStream<"build">;
  try {
    stream = s.deps.agents.open(buildNode.id, "build", resolved.request);
  } catch (error) {
    db.update(builds)
      .set({ status: "failed", finishedAt: new Date(), error: messageOf(error) })
      .where(eq(builds.id, buildRow.id))
      .run();
    return void finish(s, load(s, d.id) as DeploymentRow, "failed", `${buildNode.name} could not start the build: ${messageOf(error)}`);
  }
  s.streams.set(buildRow.id, stream);
  void readBuildStream(s, d.id, d.serviceId, buildRow.id, buildNode, stream);
}

/** Sends an uploaded archive to the build node before the build starts. */
async function uploadContext(s: EngineState, nodeId: string, uploadId: string): Promise<void> {
  const upload = s.deps.db.select().from(sourceUploads).where(eq(sourceUploads.id, uploadId)).get();
  if (!upload) throw new Error("the uploaded archive is gone");
  const raw = s.deps.agents.openRaw(
    nodeId,
    "uploadBuildContext",
    create(UploadBuildContextRequestSchema, { uploadId, sizeBytes: BigInt(upload.sizeBytes), sha256: upload.sha256 }),
  );
  const file = await openFile(join(s.deps.config.dataDir, "uploads", `${uploadId}.tar.gz`), "r");
  try {
    const buffer = new Uint8Array(256 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      await raw.writer.write(buffer.slice(0, bytesRead));
    }
    raw.writer.end();
  } finally {
    await file.close();
  }
  await raw.response;
}

async function readBuildStream(
  s: EngineState,
  deploymentId: string,
  serviceId: string,
  buildId: string,
  node: { id: string; name: string },
  stream: AgentStream<"build">,
): Promise<void> {
  const lines = new LineSplitter();
  const flush = (text: string[]) => {
    if (text.length > 0) appendLog(s.deps, serviceId, deploymentId, "build", text);
  };
  try {
    for await (const message of stream) {
      if (message.output.case === "log") flush(lines.push(message.output.value));
      else if (message.output.case === "progress") {
        flush(lines.flush());
        recordBuildProgress(s, node.id, message.output.value);
      } else if (message.output.case === "sourceInfo") {
        recordSourceInfo(s, deploymentId, message.output.value);
      }
    }
    flush(lines.flush());
    await stream.done;
  } catch (error) {
    flush(lines.flush());
    const build = s.deps.db.select().from(builds).where(eq(builds.id, buildId)).get();
    if (build && (build.status === "running" || build.status === "queued")) {
      const offline = error instanceof OpError && error.details?.reason === "offline";
      if (offline) {
        // The node keeps building; its durable result arrives when it is back.
        appendLog(s.deps, serviceId, deploymentId, "build", [`Lost the connection to ${node.name}; waiting for its build result.`]);
      } else {
        s.deps.db
          .update(builds)
          .set({ status: "failed", finishedAt: new Date(), error: messageOf(error) })
          .where(eq(builds.id, buildId))
          .run();
        appendLog(s.deps, serviceId, deploymentId, "build", [messageOf(error)], true);
      }
    }
  } finally {
    s.streams.delete(buildId);
    kick(s, deploymentId);
  }
}

/**
 * Applies a BuildProgress (from the stream or the durable report) to the
 * build row and the deployment's steps. Idempotent: a final state is never
 * overwritten.
 */
export function recordBuildProgress(s: Pick<EngineState, "deps">, nodeId: string, progress: BuildProgress): string | null {
  const { db } = s.deps;
  const build = db.select().from(builds).where(eq(builds.id, progress.buildId)).get();
  if (!build || build.nodeId !== nodeId) return null;
  const d = db.select().from(deployments).where(eq(deployments.id, build.deploymentId)).get();
  if (!d) return null;
  const finished = build.status === "succeeded" || build.status === "failed" || build.status === "cancelled";
  if (finished) return d.id;

  let steps = d.steps;
  const patch: Partial<typeof deployments.$inferInsert> = {};
  const seconds = progress.duration ? Number(progress.duration.seconds) : null;
  switch (progress.stage) {
    case BuildStage.FETCHING_SOURCE:
      steps = setStep(steps, "clone", "running");
      break;
    case BuildStage.BUILDING:
      steps = setStep(setStep(steps, "clone", "ok"), "build", "running", { detail: `${labelOf(build.builder)} build running` });
      break;
    case BuildStage.PUSHING:
      steps = setStep(setStep(steps, "clone", "ok"), "build", "running", { detail: "Pushing the image to the panel registry" });
      break;
    case BuildStage.SUCCEEDED: {
      const took = seconds === null ? "" : ` in ${seconds}s`;
      steps = setStep(setStep(steps, "clone", "ok"), "build", "ok", {
        detail: `${labelOf(build.builder)} on ${nodeNameOf(s, nodeId)}${took}`,
      });
      patch.imageDigest = progress.imageDigest || null;
      db.update(builds).set({ status: "succeeded", finishedAt: new Date() }).where(eq(builds.id, build.id)).run();
      break;
    }
    case BuildStage.FAILED:
    case BuildStage.CANCELLED: {
      const cancelled = progress.stage === BuildStage.CANCELLED;
      const failedStep = steps.find((st) => st.key === "clone")?.status === "ok" ? "build" : "clone";
      steps = setStep(steps, failedStep, cancelled ? "skipped" : "failed", {
        detail: progress.message || (cancelled ? "Cancelled" : "Build failed"),
      });
      db.update(builds)
        .set({ status: cancelled ? "cancelled" : "failed", finishedAt: new Date(), error: progress.message || null })
        .where(eq(builds.id, build.id))
        .run();
      break;
    }
    default:
      break;
  }
  db.update(deployments)
    .set({ ...patch, steps })
    .where(eq(deployments.id, d.id))
    .run();
  if (progress.message && progress.stage !== BuildStage.SUCCEEDED) {
    appendLog(
      s.deps,
      d.serviceId,
      d.id,
      progress.stage === BuildStage.FETCHING_SOURCE ? "clone" : "build",
      [progress.message],
      progress.stage === BuildStage.FAILED,
    );
  }
  publishDeploymentChange(s.deps, d.serviceId, d.id);
  return d.id;
}

function labelOf(builder: string): string {
  return builder === "railpack" ? "Railpack" : builder === "nixpacks" ? "Nixpacks" : "Dockerfile";
}

function nodeNameOf(s: Pick<EngineState, "deps">, nodeId: string): string {
  return s.deps.db.select({ name: nodes.name }).from(nodes).where(eq(nodes.id, nodeId)).get()?.name ?? "removed node";
}

async function checkBuild(s: EngineState, d: DeploymentRow): Promise<void> {
  const build = s.deps.db.select().from(builds).where(eq(builds.deploymentId, d.id)).orderBy(desc(builds.createdAt)).get();
  if (!build) return void finish(s, d, "failed", "The build record is missing.");
  if (build.status === "succeeded") return rollout(s, d);
  if (build.status === "failed") {
    const reason = build.error ?? "";
    return void finish(
      s,
      d,
      "failed",
      /^the build failed/i.test(reason) ? reason : reason ? `The build failed: ${reason}` : "The build failed.",
    );
  }
  if (build.status === "cancelled") return void finish(s, d, "cancelled", "The build was cancelled.");
  // After a panel restart the build keeps running on its node: ask for it again to follow its output.
  if (build.nodeId && !s.streams.has(build.id) && !s.reattached.has(build.id) && s.deps.agents.supports(build.nodeId, "build")) {
    s.reattached.add(build.id);
    await reattachBuild(s, d, build.id, build.nodeId);
  }
  const started = (d.phaseStartedAt ?? d.createdAt).getTime();
  if (Date.now() - started > buildTimeoutMs) {
    s.deps.db.update(builds).set({ status: "failed", finishedAt: new Date(), error: "timed out" }).where(eq(builds.id, build.id)).run();
    if (build.nodeId && s.deps.agents.supports(build.nodeId, "cancelBuild")) {
      void s.deps.agents.call(build.nodeId, "cancelBuild", { buildId: build.id }).catch(() => undefined);
    }
    return void finish(s, d, "failed", `The build did not finish within ${buildTimeoutMs / 60_000} minutes.`);
  }
}

/** Calling Build again with the same build id re-attaches to a running build and replays its output. */
async function reattachBuild(s: EngineState, d: DeploymentRow, buildId: string, nodeId: string): Promise<void> {
  try {
    const svc = loadService(s.deps.db, d.serviceId);
    const resolved = await resolveBuild(s.deps, {
      service: svc,
      spec: readSpec(svc.spec),
      buildId,
      generation: d.generation,
      commitSha: d.commitSha,
      uploadId: d.uploadId,
    });
    const stream = s.deps.agents.open(nodeId, "build", resolved.request);
    s.streams.set(buildId, stream);
    log(s, d, "build", "Following the build again after a panel restart.");
    void readBuildStream(s, d.id, d.serviceId, buildId, { id: nodeId, name: nodeName(s, nodeId) }, stream);
  } catch (error) {
    // Not fatal: the durable result still arrives when the build ends.
    s.deps.logger.warn({ err: error, deploymentId: d.id }, "could not re-attach to the build");
  }
}

/** The fetched commit, for deploys that asked for a branch. */
function recordSourceInfo(
  s: Pick<EngineState, "deps">,
  deploymentId: string,
  info: { commit: string; subject: string; author: string },
): void {
  const d = s.deps.db.select().from(deployments).where(eq(deployments.id, deploymentId)).get();
  if (!d || !info.commit) return;
  s.deps.db
    .update(deployments)
    .set({
      commitSha: d.commitSha ?? info.commit,
      commitMessage: d.commitMessage ?? (info.subject || null),
      commitAuthor: d.commitAuthor ?? (info.author || null),
    })
    .where(eq(deployments.id, deploymentId))
    .run();
}

/** Points the service at this deployment and lets the agents roll it out. */
async function rollout(s: EngineState, d: DeploymentRow): Promise<void> {
  const { db } = s.deps;
  const svc = loadService(db, d.serviceId);
  const now = new Date();
  const results = Object.fromEntries(d.targetNodeIds.map((id) => [id, { status: "pending" as const, message: "", digest: null }]));
  const names = d.targetNodeIds.map((id) => nodeName(s, id));
  const steps = setStep(d.steps, "ship", "running", { nodeId: d.targetNodeIds[0] ?? null, detail: `Shipping to ${names.join(", ")}` });
  const current = db.transaction((tx) => {
    tx.update(services).set({ targetDeploymentId: d.id, generation: d.generation, stopped: false }).where(eq(services.id, svc.id)).run();
    return tx
      .update(deployments)
      .set({ status: "deploying", phaseStartedAt: now, nodeResults: results, steps })
      .where(eq(deployments.id, d.id))
      .returning()
      .get();
  });
  log(s, current, "ship", `Rolling out generation ${d.generation} on ${names.join(", ")}.`);
  s.deps.agents.desired.markDirty({ serviceId: svc.id });
  publishDeploymentChange(s.deps, svc.id, d.id);

  // Cron services have no long-running container to health check: accepted is done.
  if (svc.kind === "cron") {
    await s.deps.agents.desired.settled();
    const done = load(s, d.id);
    if (done && done.status === "deploying") {
      const ok = Object.fromEntries(done.targetNodeIds.map((id) => [id, { status: "ok" as const, message: "", digest: null }]));
      save(s, d.id, { nodeResults: ok });
    }
  }
  return checkRollout(s, load(s, d.id) as DeploymentRow);
}

/**
 * Applies a DeployProgress to the deployment whose generation it names.
 * Returns the deployment id to kick, or null.
 */
export function recordDeployProgress(s: Pick<EngineState, "deps">, nodeId: string, progress: DeployProgress): string | null {
  const { db } = s.deps;
  const d = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, progress.serviceId),
        eq(deployments.generation, Number(progress.generation)),
        eq(deployments.status, "deploying"),
      ),
    )
    .get();
  if (!d || !(nodeId in d.nodeResults)) return null;
  let steps = d.steps;
  const results = { ...d.nodeResults };
  const name = nodeNameOf(s, nodeId);
  switch (progress.stage) {
    case DeployStage.PULLING:
      steps = setStep(steps, "ship", "running", { detail: `Pulling on ${name}` });
      break;
    case DeployStage.STARTING:
    case DeployStage.HEALTH_CHECKING:
      steps = setStep(setStep(steps, "ship", "ok"), "health", "running", {
        nodeId,
        detail: progress.message || "Waiting for the health check",
      });
      break;
    case DeployStage.SWITCHING_ROUTE:
    case DeployStage.VERIFYING:
    case DeployStage.STOPPING_OLD:
      steps = setStep(setStep(setStep(steps, "ship", "ok"), "health", "ok"), "switch", "running", {
        nodeId,
        detail: progress.message || "Switching traffic",
      });
      break;
    case DeployStage.SUCCEEDED:
      results[nodeId] = { status: "ok", message: progress.message, digest: results[nodeId]?.digest ?? null };
      break;
    case DeployStage.FAILED:
      results[nodeId] = { status: "failed", message: progress.message || `The new version did not start on ${name}.`, digest: null };
      break;
    default:
      break;
  }
  db.update(deployments).set({ steps, nodeResults: results }).where(eq(deployments.id, d.id)).run();
  if (progress.message) {
    const step = progress.stage === DeployStage.PULLING ? "ship" : progress.stage <= DeployStage.HEALTH_CHECKING ? "health" : "switch";
    appendLog(s.deps, d.serviceId, d.id, step, [`${name}: ${progress.message}`], progress.stage === DeployStage.FAILED);
  }
  publishDeploymentChange(s.deps, d.serviceId, d.id);
  return d.id;
}

/**
 * A node refused the spec of a deploying generation: that node's
 * result fails with the agent's reason and the deploy_failed alert goes out
 * now, instead of the rollout waiting for the health timeout. The node keeps
 * running its last valid spec. Returns the deployment id to kick, or null.
 */
export function recordRefusedSpec(s: Pick<EngineState, "deps">, nodeId: string, refusal: RefusedSpec): string | null {
  const { db } = s.deps;
  const d = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.serviceId, refusal.serviceId),
        eq(deployments.generation, Number(refusal.generation)),
        eq(deployments.status, "deploying"),
      ),
    )
    .get();
  if (d?.nodeResults[nodeId]?.status !== "pending") return null;
  const name = nodeNameOf(s, nodeId);
  const reason = (refusal.message || "no reason given").replace(/[.\s]+$/, "");
  const message = `The node refused the new settings: ${reason}.`;
  db.update(deployments)
    .set({ nodeResults: { ...d.nodeResults, [nodeId]: { status: "failed", message, digest: null } } })
    .where(eq(deployments.id, d.id))
    .run();
  appendLog(s.deps, d.serviceId, d.id, "ship", [`${name}: ${message}`], true);
  publishDeploymentChange(s.deps, d.serviceId, d.id);
  const service = db.select({ name: services.name }).from(services).where(eq(services.id, d.serviceId)).get();
  if (service) {
    // The key the alerts module uses for an agent's DeployProgress FAILED, so one failure alerts once.
    s.deps.alerts.raise({
      event: "deploy_failed",
      key: `deploy-failed:${d.serviceId}:${d.generation}:${nodeId}`,
      title: `Deploy of ${service.name} failed`,
      message: `${name}: ${message} The previous version stayed live.`,
      serviceId: d.serviceId,
      nodeId,
    });
  }
  return d.id;
}

/** Fills pending node results from the nodes' reported state (covers lost events). */
function resultsFromState(s: EngineState, d: DeploymentRow): DeploymentRow["nodeResults"] {
  const results = { ...d.nodeResults };
  for (const { nodeId, status } of s.deps.agents.state.serviceStatuses(d.serviceId)) {
    const current = results[nodeId];
    if (current?.status !== "pending") continue;
    if (Number(status.generation) !== d.generation) continue;
    const mine = status.instances.filter((i) => Number(i.generation) === d.generation);
    const healthy =
      status.phase === ServicePhase.RUNNING &&
      mine.length > 0 &&
      mine.every((i) => i.state === InstanceState.RUNNING && i.health !== HealthState.UNHEALTHY && i.health !== HealthState.STARTING);
    if (healthy) results[nodeId] = { status: "ok", message: "", digest: mine[0]?.imageDigest || null };
    else if (status.phase === ServicePhase.FAILED)
      results[nodeId] = { status: "failed", message: status.message || "The new version failed.", digest: null };
  }
  return results;
}

async function checkRollout(s: EngineState, d: DeploymentRow): Promise<void> {
  const results = resultsFromState(s, d);
  if (JSON.stringify(results) !== JSON.stringify(d.nodeResults)) d = save(s, d.id, { nodeResults: results });
  const entries = Object.entries(results);
  const failed = entries.find(([, r]) => r.status === "failed");
  if (failed) {
    const [nodeId, r] = failed;
    return void finish(s, d, "failed", `${nodeName(s, nodeId)}: ${r.message} The previous version stayed live.`, { alert: false });
  }
  if (entries.length > 0 && entries.every(([, r]) => r.status === "ok")) return succeed(s, d);

  const settings = d.runSettings as { deploy?: { healthTimeoutSeconds?: number } } | null;
  const healthMs = (settings?.deploy?.healthTimeoutSeconds ?? 300) * 1000;
  const started = (d.phaseStartedAt ?? d.createdAt).getTime();
  if (Date.now() - started > healthMs + rolloutGraceMs) {
    const waiting = entries.filter(([, r]) => r.status === "pending").map(([id]) => nodeName(s, id));
    return void finish(
      s,
      d,
      "failed",
      `${waiting.join(", ")} did not report the new version healthy within ${Math.round((healthMs + rolloutGraceMs) / 1000)}s. The previous version stayed live.`,
    );
  }
}

/** The digest a node runs for this generation, from its state report (image sources: what the tag pulled). */
/**
 * The live deployment of an image pulled by tag can finish before the
 * node's status carries the image's digest. Record it in nodeResults when
 * it arrives (not in imageDigest, which is part of the spec and would roll
 * the service again), so a rollback runs the same bytes.
 */
export function fillReportedDigest(deps: Deps, serviceId: string): void {
  const d = deps.db
    .select()
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), eq(deployments.status, "live"), isNull(deployments.imageDigest)))
    .get();
  if (!d || Object.values(d.nodeResults).some((r) => r.digest)) return;
  const results = { ...d.nodeResults };
  let changed = false;
  for (const { nodeId, status } of deps.agents.state.serviceStatuses(serviceId)) {
    const instance = status.instances.find((i) => Number(i.generation) === d.generation && i.imageDigest);
    const current = results[nodeId];
    if (instance && current) {
      results[nodeId] = { ...current, digest: instance.imageDigest };
      changed = true;
    }
  }
  if (changed) deps.db.update(deployments).set({ nodeResults: results }).where(eq(deployments.id, d.id)).run();
}

function succeed(s: EngineState, d: DeploymentRow): void {
  const { db } = s.deps;
  const now = new Date();
  // imageDigest stays as deployed (it is part of the spec); a digest the
  // node reported for an image pulled by tag lives in nodeResults.
  const digest = d.imageDigest;
  let steps = d.steps;
  const names = d.targetNodeIds.map((id) => nodeName(s, id)).join(", ");
  const done = { ship: `Running on ${names}`, health: "Healthy", switch: "Traffic switched" } as const;
  for (const key of ["ship", "health", "switch"] as const) steps = setStep(steps, key, "ok", { detail: done[key] });
  db.transaction((tx) => {
    tx.update(deployments)
      .set({ status: "superseded" })
      .where(and(eq(deployments.serviceId, d.serviceId), eq(deployments.status, "live"), ne(deployments.id, d.id)))
      .run();
    tx.update(deployments).set({ status: "live", finishedAt: now, steps, imageDigest: digest }).where(eq(deployments.id, d.id)).run();
    tx.update(services).set({ liveDeploymentId: d.id }).where(eq(services.id, d.serviceId)).run();
    // A move is done once the new node serves: the old copy goes.
    if (d.trigger === "move" && d.movedFromNodeId) {
      tx.delete(servicePlacements)
        .where(and(eq(servicePlacements.serviceId, d.serviceId), eq(servicePlacements.nodeId, d.movedFromNodeId)))
        .run();
    }
  });
  if (d.trigger === "move" && d.movedFromNodeId) s.deps.agents.desired.markDirty({ nodeId: d.movedFromNodeId });
  s.deps.jobs.enqueue(registryGcJobType, { serviceId: d.serviceId }, { dedupeKey: `registry-gc:${d.serviceId}` });
  const finalLine = d.projectMove
    ? "The service runs on its new project's network."
    : d.trigger === "move"
      ? "The service runs on its new node."
      : "The new version is live.";
  appendLog(s.deps, d.serviceId, d.id, "switch", [finalLine]);
  publishDeploymentChange(s.deps, d.serviceId, d.id);
  kickNext(s, d.serviceId);
}

/**
 * Ends a deployment that did not go live. The service's target goes back
 * to the live deployment (or to nothing), so agents keep or restore the
 * old version.
 */
export function finish(
  s: Pick<EngineState, "deps"> & Partial<EngineState>,
  d: DeploymentRow,
  outcome: "failed" | "cancelled",
  message: string,
  options: { alert?: boolean } = {},
): void {
  const { db } = s.deps;
  const now = new Date();
  let reverted = false;
  let projectBack: string | null = null;
  db.transaction((tx) => {
    tx.update(deployments)
      .set({
        status: outcome,
        finishedAt: now,
        error: outcome === "failed" ? message : null,
        steps: closeSteps(d.steps, outcome, now.getTime()),
      })
      .where(eq(deployments.id, d.id))
      .run();
    tx.update(builds)
      .set({ status: outcome === "failed" ? "failed" : "cancelled", finishedAt: now })
      .where(and(eq(builds.deploymentId, d.id), inArray(builds.status, ["queued", "running"])))
      .run();
    const svc = tx.select().from(services).where(eq(services.id, d.serviceId)).get();
    if (svc && svc.targetDeploymentId === d.id) {
      const live = svc.liveDeploymentId ? tx.select().from(deployments).where(eq(deployments.id, svc.liveDeploymentId)).get() : undefined;
      tx.update(services)
        .set({ targetDeploymentId: live?.id ?? null, generation: live?.generation ?? svc.generation })
        .where(eq(services.id, svc.id))
        .run();
      reverted = true;
    }
    if (d.trigger === "move" && d.movedFromNodeId) {
      restoreMove(tx, d);
      reverted = true;
    }
    if (d.projectMove) {
      projectBack = restoreProjectMove(tx, d);
      reverted = true;
    }
  });
  appendLog(s.deps, d.serviceId, d.id, lastStep(d), [message], outcome === "failed");
  if (d.projectMove) {
    const back = projectBack === d.projectMove.fromProjectId;
    appendLog(s.deps, d.serviceId, d.id, lastStep(d), [
      back
        ? "The service went back to its old project, with the grants the move removed."
        : "The service could not go back to its old project (removed, or a service there took its name); it stays in the new one.",
    ]);
    for (const projectId of [d.projectMove.fromProjectId, d.projectMove.toProjectId]) {
      s.deps.live.publish(`project:${projectId}`, { type: "invalidate", ops: ["services.list", "projects.get", "env.references"] });
    }
    s.deps.live.publish("panel", { type: "invalidate", ops: ["projects.list"] });
    for (const g of d.projectMove.removedGrants) s.deps.live.recheck({ userId: g.userId });
  }
  if (reverted) s.deps.agents.desired.markDirty({ serviceId: d.serviceId });
  if (reverted && d.trigger === "move") for (const nodeId of d.targetNodeIds) s.deps.agents.desired.markDirty({ nodeId });
  publishDeploymentChange(s.deps, d.serviceId, d.id);
  // Failures the panel itself saw (no builder, source, timeouts); the alerts module covers what agents report.
  if (outcome === "failed" && options.alert !== false) {
    const name = s.deps.db.select({ name: services.name }).from(services).where(eq(services.id, d.serviceId)).get()?.name;
    if (name && (d.status === "queued" || d.status === "building")) {
      // Before anything shipped it is a build failure. The key matches the one the alerts module
      // uses for the agent's BuildProgress FAILED, so a build the agent also reports alerts once.
      const build = s.deps.db
        .select({ id: builds.id })
        .from(builds)
        .where(eq(builds.deploymentId, d.id))
        .orderBy(desc(builds.createdAt))
        .get();
      s.deps.alerts.raise({
        event: "build_failed",
        key: build ? `build-failed:${build.id}` : `build-failed:deployment:${d.id}`,
        title: `Build of ${name} failed`,
        message,
        serviceId: d.serviceId,
      });
    } else if (name) {
      s.deps.alerts.raise({
        event: "deploy_failed",
        key: `deploy-failed:${d.serviceId}:${d.generation}:panel`,
        title: `${name} failed to deploy`,
        message,
        serviceId: d.serviceId,
      });
    }
  }
  if (s.chains) kickNext(s as EngineState, d.serviceId);
}

/** A failed move leaves the service on (or puts it back on) the node it came from. */
function restoreMove(tx: Pick<Deps["db"], "select" | "insert" | "update" | "delete">, d: DeploymentRow): void {
  const from = d.movedFromNodeId as string;
  const placements = tx.select().from(servicePlacements).where(eq(servicePlacements.serviceId, d.serviceId)).all();
  const replicas = placements.find((p) => p.nodeId === from)?.replicas ?? placements[0]?.replicas ?? 1;
  tx.delete(servicePlacements).where(eq(servicePlacements.serviceId, d.serviceId)).run();
  tx.insert(servicePlacements).values({ serviceId: d.serviceId, nodeId: from, replicas }).run();
  tx.update(services).set({ stopped: false }).where(eq(services.id, d.serviceId)).run();
  tx.update(deployments).set({ moveCopying: false }).where(eq(deployments.id, d.id)).run();
}

function lastStep(d: DeploymentRow): DeployStep["key"] {
  const running = d.steps.find((st) => st.status === "running");
  if (running) return running.key;
  return d.status === "deploying" ? "health" : d.status === "building" ? "build" : "clone";
}

function kickNext(s: EngineState, serviceId: string): void {
  // Deployments of other services waiting for one of this service's deployments.
  for (const w of s.deps.db
    .select({ id: deployments.id, waitFor: deployments.waitFor })
    .from(deployments)
    .where(eq(deployments.status, "queued"))
    .all()) {
    if (w.waitFor.length > 0) kick(s, w.id);
  }
  const next = s.deps.db
    .select({ id: deployments.id })
    .from(deployments)
    .where(and(eq(deployments.serviceId, serviceId), eq(deployments.status, "queued")))
    .orderBy(asc(deployments.createdAt), asc(deployments.id))
    .get();
  if (next) kick(s, next.id);
}

/** Stops a deployment that has not finished. */
export async function cancelDeployment(deps: Deps, d: DeploymentRow, actor: string | null): Promise<void> {
  const engine = engines.get(deps.db);
  if (d.status === "building") {
    const build = deps.db
      .select()
      .from(builds)
      .where(and(eq(builds.deploymentId, d.id), inArray(builds.status, ["queued", "running"])))
      .get();
    if (build?.nodeId && deps.agents.supports(build.nodeId, "cancelBuild")) {
      await deps.agents.call(build.nodeId, "cancelBuild", { buildId: build.id }).catch(() => undefined);
    }
    if (build) engine?.streams.get(build.id)?.cancel();
  }
  finish(engine ?? { deps }, d, "cancelled", actor ? `Cancelled by ${actor}.` : "Cancelled.");
}

/** Next generation for a service: above everything it ever ran or tried. */
export function nextGeneration(deps: Pick<Deps, "db">, serviceId: string): number {
  const svc = deps.db.select({ generation: services.generation }).from(services).where(eq(services.id, serviceId)).get();
  const top = deps.db
    .select({ g: max(deployments.generation) })
    .from(deployments)
    .where(eq(deployments.serviceId, serviceId))
    .get();
  return Math.max(svc?.generation ?? 0, top?.g ?? 0) + 1;
}

/** Ids of deployments that have not finished, oldest first (recovery after a restart). */
export function unfinishedDeployments(deps: Pick<Deps, "db">): string[] {
  return deps.db
    .select({ id: deployments.id })
    .from(deployments)
    .where(inArray(deployments.status, ["queued", "building", "deploying"]))
    .orderBy(asc(deployments.createdAt))
    .all()
    .map((r) => r.id);
}

function messageOf(error: unknown): string {
  return error instanceof OpError ? error.message : error instanceof Error ? error.message : String(error);
}
