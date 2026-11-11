// Version changes of a database: which catalog versions it may move to
// (judgeVersion, the engines' upgrade rules in one pure function), custom
// images of the engine's own official repository, MongoDB's
// featureCompatibilityVersion step, and the databases.versionChoices and
// databases.setVersion ops. A change writes service_databases.version and
// the spec's image (the variant stays) and deploys; databases deploy in
// recreate mode on the same data volume.

import { databases as dbOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, isNull } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { backupRuns, type DatabaseEngine, deployments, serviceDatabases, services, volumes } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { activeDeploy, assertNoActiveDeploy, queueDeploy } from "../deployments/queue";
import { invalidateService } from "../domains/lookup";
import { writeSpec } from "../services/insert";
import { actorOf, publishService } from "../services/ops";
import { loadService } from "../services/rows";
import { readSpec } from "../services/spec";
import { engines, engineVersions } from "./engines";
import { type DatabaseInfo, loadDatabase } from "./info";
import { toDatabase } from "./ops";

type Choice = Static<typeof dbOps.VersionChoice>;
export type VersionKind = Choice["kind"];
export type Judgement = Pick<Choice, "kind" | "allowed" | "reason" | "message">;

/** A change of version line needs a successful backup this recent (or confirmNoBackup). */
export const backupMaxAgeMs = 24 * 60 * 60 * 1000;

/** "10.11" against "11.4", number by number; a missing number counts as 0. */
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The release in an image's tag ("mongo:8.0.34" is 8.0.34, "postgres:17.6-alpine" 17.6); null for a digest or a tag without one. */
export function imageRelease(image: string): string | null {
  if (image.includes("@")) return null;
  const colon = image.lastIndexOf(":");
  if (colon < 0 || image.indexOf("/", colon) >= 0) return null;
  return /^v?(\d+(?:\.\d+)*)/.exec(image.slice(colon + 1))?.[1] ?? null;
}

const major = (version: string) => version.split(".")[0];

export interface VersionPoint {
  version: string;
  image: string;
  /** Where the data volume is mounted. */
  dataPath: string;
}

/**
 * What a change from one version of a database to another is, and whether
 * it may run in place. `lines` are the version ids of the catalog
 * (engine and variant), for the engines that go one line at a time.
 *
 * - The same line with a newer image is a patch update; an older image is refused.
 * - Older lines are refused for every engine: data files are not backward compatible.
 * - Postgres majors need pg_upgrade or a dump and restore, neither of which runs in place.
 * - MongoDB, MariaDB and MySQL go one line up at a time (MongoDB needs each
 *   featureCompatibilityVersion in turn; MariaDB and MySQL support upgrades
 *   from the previous series).
 * - Redis, Valkey and ClickHouse read older data files: any newer line.
 * - KeyDB and Dragonfly: patch updates only.
 */
export function judgeVersion(engine: DatabaseEngine, from: VersionPoint, to: VersionPoint, lines: readonly string[]): Judgement {
  const label = engines[engine].label;
  const order = compareVersions(to.version, from.version);
  if (order === 0) {
    if (to.image === from.image) return { kind: "current", allowed: false, reason: "current", message: `The database runs ${to.image}.` };
    const a = imageRelease(from.image);
    const b = imageRelease(to.image);
    if (a && b && compareVersions(b, a) < 0) {
      return { kind: "downgrade", allowed: false, reason: "olderImage", message: `${to.image} is older than ${from.image}.` };
    }
    return { kind: "patch", allowed: true };
  }
  if (order < 0) {
    return {
      kind: "downgrade",
      allowed: false,
      reason: "downgrade",
      message: `${label} ${from.version} data files cannot go back to ${to.version}. Restore a backup into a new database instead.`,
    };
  }
  const kind: VersionKind = major(to.version) === major(from.version) ? "upgrade" : "major";
  const verdict = engineRule(engine, kind, from, to, lines);
  if (verdict.allowed && to.dataPath !== from.dataPath) {
    return { kind, allowed: false, reason: "dataPath", message: `${label} ${to.version} keeps its data in another folder.` };
  }
  return verdict;
}

function engineRule(engine: DatabaseEngine, kind: VersionKind, from: VersionPoint, to: VersionPoint, lines: readonly string[]): Judgement {
  const label = engines[engine].label;
  switch (engine) {
    case "postgres":
      return {
        kind,
        allowed: false,
        reason: "postgresMajor",
        message: `A Postgres major upgrade needs a dump and restore into a new database: pg_upgrade is not run in place.`,
      };
    case "keydb":
    case "dragonfly":
      return { kind, allowed: false, reason: "patchOnly", message: `${label} takes patch updates only.` };
    case "mongo":
    case "mariadb":
    case "mysql": {
      const next = lines.filter((v) => compareVersions(v, from.version) > 0).sort(compareVersions)[0];
      if (next !== undefined && to.version !== next) {
        return {
          kind,
          allowed: false,
          reason: "oneStep",
          message: `${label} upgrades one version at a time: go to ${next} first.`,
        };
      }
      return { kind, allowed: true };
    }
    case "redis":
    case "valkey":
    case "clickhouse":
      return { kind, allowed: true };
  }
}

/** The official repository of an engine's images (and variant's); null when only the catalog's image is taken. */
export function officialRepository(engine: DatabaseEngine, variant: string | null): string | null {
  if (engine === "postgres") return variant === "pgvector" ? "pgvector/pgvector" : variant ? null : "postgres";
  if (variant) return null;
  const repos: Partial<Record<DatabaseEngine, string>> = {
    mysql: "mysql",
    mariadb: "mariadb",
    mongo: "mongo",
    redis: "redis",
    valkey: "valkey/valkey",
    clickhouse: "clickhouse/clickhouse-server",
  };
  return repos[engine] ?? null;
}

/**
 * A custom image for a version line, as stored: the engine's own official
 * repository (docker.io, written without it) with an exact release tag of
 * that line ("mongo:8.0.40", "postgres:17.7-alpine", for pgvector
 * "pgvector/pgvector:0.8.8-pg17-trixie"). Floating tags (latest, "8.0")
 * are refused: a redeploy must run the same bytes. So are digests: the
 * rules judge the version in the tag, and a digest could be any version
 * (a downgrade or a major passing as a patch). A Postgres tag keeps the
 * catalog's base system ("-alpine", pgvector's "-trixie"): another C
 * library sorts text differently under the same indexes.
 */
export function customImage(engine: DatabaseEngine, variant: string | null, version: string, image: string): string {
  const repo = officialRepository(engine, variant);
  const label = engines[engine].label;
  const field = { field: "image", reason: "customImage" };
  if (!repo) throw new OpError("BAD_REQUEST", `${label}${variant ? ` with ${variant}` : ""} takes the catalog's image only.`, field);
  const name = image.trim().replace(/^docker\.io\//, "");
  const bare = repo.includes("/") ? name : name.replace(/^library\//, "");
  const match = /^([a-z0-9][a-z0-9._/-]*?)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?$/.exec(bare);
  if (!match || match[1] !== repo)
    throw new OpError("BAD_REQUEST", `Use ${label}'s official image, ${repo}, with an exact release tag.`, field);
  const tag = match[2];
  if (match[3]) {
    throw new OpError(
      "BAD_REQUEST",
      `Give ${repo} an exact release tag without a digest: the change is judged by the version in the tag, which a digest does not show.`,
      field,
    );
  }
  const catalogTag =
    engineVersions(engine, variant)
      ?.find((v) => v.version === version)
      ?.image.split(":")[1] ?? "";
  const example = variant === "pgvector" ? `<release>-pg${version}${baseOf(catalogTag)}` : `${version}.<patch>${baseOf(catalogTag)}`;
  if (!tag) throw new OpError("BAD_REQUEST", `Give ${repo} an exact release tag, for example ${repo}:${example}.`, field);
  const claims =
    variant === "pgvector"
      ? new RegExp(`^\\d+(\\.\\d+)*-pg${escapeRegExp(version)}(-|$)`).test(tag)
      : new RegExp(`^v?${escapeRegExp(version)}\\.\\d`).test(tag);
  if (!claims) {
    throw new OpError("BAD_REQUEST", `${repo}:${tag} is not an exact ${label} ${version} release. Use a tag such as ${example}.`, field);
  }
  if (engine === "postgres" && baseOf(tag) !== baseOf(catalogTag)) {
    throw new OpError(
      "BAD_REQUEST",
      `${repo}:${tag} is built on another base system than the catalog's ${repo}:${catalogTag}: its C library sorts text differently, which breaks the indexes on text columns. Use a tag such as ${example}.`,
      field,
    );
  }
  return `${repo}:${tag}`;
}

/** What follows the release in a tag: "-alpine" of "17.6-alpine", "-trixie" of pgvector's "0.8.7-pg17-trixie". */
const baseOf = (tag: string) => tag.replace(/^v?\d+(?:\.\d+)*(?:-pg\d+)?/, "");

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Exec call that sets a running MongoDB's featureCompatibilityVersion to
 * `version` (its own line): a newer major refuses data files whose
 * compatibility version is more than one line behind. The admin signs in
 * inside the script, which goes on stdin, so the password never shows in a
 * process list. quit() gives the exit code: mongosh reading stdin goes on
 * after an error and would exit 0.
 */
export function mongoFcvExec(user: string, password: string, version: string): { command: string[]; stdin: string } {
  const script = [
    "try {",
    'const admin = db.getSiblingDB("admin");',
    `admin.auth(${JSON.stringify(user)}, ${JSON.stringify(password)});`,
    `const r = admin.runCommand({ setFeatureCompatibilityVersion: ${JSON.stringify(version)}, confirm: true });`,
    "if (r.ok !== 1) { print(r.errmsg || JSON.stringify(r)); quit(2); }",
    `print("featureCompatibilityVersion " + ${JSON.stringify(version)});`,
    "} catch (e) { print(e.message); quit(3); }",
  ].join(" ");
  return { command: ["mongosh", "--quiet", "--norc", "mongodb://127.0.0.1:27017/admin"], stdin: `${script}\n` };
}

/**
 * The version line an image belongs to: the catalog line with that very
 * image, else the line its tag starts with ("mongo:8.0.40" is 8.0; pgvector
 * tags name it as "-pg17"). Null when neither says.
 */
export function lineOfImage(image: string, catalog: readonly { version: string; image: string }[]): string | null {
  const exact = catalog.find((v) => v.image === image);
  if (exact) return exact.version;
  const pg = /:[^/]*-pg(\d+)(-|$)/.exec(image)?.[1];
  if (pg) return catalog.find((v) => v.version === pg)?.version ?? null;
  const release = imageRelease(image);
  if (!release) return null;
  const lines = catalog.filter((v) => release === v.version || release.startsWith(`${v.version}.`));
  return lines.sort((a, b) => b.version.length - a.version.length)[0]?.version ?? null;
}

interface VersionState {
  info: DatabaseInfo;
  /** What the database runs: its live deployment's image (else what it is set to run, before a first deploy). */
  from: VersionPoint;
  /** What it is set to run when that is not what runs: a change whose deploy is running or failed. */
  pending: { version: string; image: string } | null;
  lines: string[];
  blocked: { reason: string; message: string } | null;
  recentBackupAt: Date | null;
}

function versionState(ctx: OpContext, serviceId: string): VersionState {
  const info = loadDatabase(ctx, serviceId);
  const svc = loadService(ctx.db, serviceId);
  const spec = readSpec(svc.spec);
  const image = spec.source.type === "image" ? spec.source.image : "";
  const catalog = engineVersions(info.row.engine, info.row.variant) ?? [];
  const dataPath =
    ctx.db
      .select({ mountPath: volumes.mountPath })
      .from(volumes)
      .where(and(eq(volumes.serviceId, serviceId), eq(volumes.name, "data")))
      .get()?.mountPath ?? "";
  // The live deployment is the one that ran healthy; a failed deploy makes it the target again.
  const running = svc.liveDeploymentId
    ? (ctx.db.select({ imageRef: deployments.imageRef }).from(deployments).where(eq(deployments.id, svc.liveDeploymentId)).get()
        ?.imageRef ?? null)
    : null;
  const pending = running !== null && running !== image ? { version: info.row.version, image } : null;
  const from = pending && running ? { version: lineOfImage(running, catalog) ?? info.row.version, image: running, dataPath } : null;
  const active = activeDeploy(ctx, serviceId);
  const blocked = !info.node
    ? { reason: "noNode", message: "The database is not placed on a node." }
    : svc.stopped
      ? {
          reason: "stopped",
          message: "The database is stopped. Start it first: a version change deploys, which would start it.",
        }
      : active
        ? { reason: "deployRunning", message: "A deploy of this database is running. Wait for it to finish, then change the version." }
        : null;
  const backup = ctx.db
    .select({ finishedAt: backupRuns.finishedAt })
    .from(backupRuns)
    .where(
      and(
        eq(backupRuns.serviceId, serviceId),
        eq(backupRuns.kind, "backup"),
        eq(backupRuns.target, "database"),
        eq(backupRuns.status, "succeeded"),
        isNull(backupRuns.deletedAt),
      ),
    )
    .orderBy(desc(backupRuns.finishedAt))
    .get();
  return {
    info,
    from: from ?? { version: info.row.version, image, dataPath },
    pending,
    lines: catalog.map((v) => v.version),
    blocked,
    recentBackupAt: backup?.finishedAt ?? null,
  };
}

/**
 * judgeVersion from what runs. After a change whose deploy failed, the
 * image that still runs may be set again (it only restarts the database),
 * and the change itself runs again under the same rules.
 */
function judge(state: VersionState, to: VersionPoint): Judgement {
  const j = judgeVersion(state.info.row.engine, state.from, to, state.lines);
  if (j.reason === "current" && state.pending) {
    return { kind: "current", allowed: true, message: `Stay on ${to.image}: the change to ${state.pending.image} did not finish.` };
  }
  return j;
}

function backupFresh(state: VersionState, now: Date): boolean {
  return state.recentBackupAt !== null && now.getTime() - state.recentBackupAt.getTime() <= backupMaxAgeMs;
}

export const versionChoices = implement(dbOps.versionChoices, (input, ctx) => {
  const state = versionState(ctx, input.serviceId);
  const catalog = engineVersions(state.info.row.engine, state.info.row.variant) ?? [];
  return {
    engine: state.info.row.engine,
    version: state.from.version,
    variant: state.info.row.variant,
    image: state.from.image,
    pendingImage: state.pending?.image ?? null,
    choices: catalog.map((v) => ({ version: v.version, image: v.image, ...judge(state, v) })),
    blocked: state.blocked,
    recentBackupAt: state.recentBackupAt?.toISOString() ?? null,
    backupFresh: backupFresh(state, new Date()),
  };
});

export const setVersion = implement(dbOps.setVersion, async (input, ctx) => {
  const state = versionState(ctx, input.serviceId);
  const { info } = state;
  if (state.blocked) throw new OpError("CONFLICT", state.blocked.message, { reason: state.blocked.reason });
  const catalog = engineVersions(info.row.engine, info.row.variant) ?? [];
  const line = catalog.find((v) => v.version === input.version);
  if (!line) {
    throw new OpError(
      "BAD_REQUEST",
      `${info.engine.label}${info.row.variant ? ` with ${info.row.variant}` : ""} ${input.version} is not offered. Pick one of ${catalog.map((v) => v.version).join(", ")}.`,
      { field: "version" },
    );
  }
  const image = input.image ? customImage(info.row.engine, info.row.variant, input.version, input.image) : line.image;
  const to = { version: input.version, image, dataPath: line.dataPath };
  const verdict = judge(state, to);
  if (!verdict.allowed)
    throw new OpError("CONFLICT", verdict.message ?? "This version change is not allowed.", { reason: verdict.reason ?? "" });
  const lineChange = to.version !== state.from.version;
  if (lineChange && !input.confirmNoBackup && !backupFresh(state, new Date())) {
    throw new OpError(
      "CONFLICT",
      "Back up the database first: there is no successful backup from the last 24 hours, and a new version cannot be undone. Or confirm the change without a backup.",
      { reason: "backupRequired" },
    );
  }
  const node = info.node;
  if (lineChange && info.row.engine === "mongo" && node) await raiseFeatureCompatibility(ctx, info, node.id, state.from.version);
  // Another change may have queued its deploy while the MongoDB step ran.
  assertNoActiveDeploy(ctx, info.service.id);

  ctx.db.transaction((tx) => {
    tx.update(serviceDatabases).set({ version: to.version }).where(eq(serviceDatabases.serviceId, info.service.id)).run();
    // Read again: other settings may have changed while the MongoDB step ran.
    const spec = readSpec(tx.select({ spec: services.spec }).from(services).where(eq(services.id, info.service.id)).get()?.spec);
    writeSpec(tx, info.service.id, {
      ...spec,
      source: { type: "image", image, registryId: spec.source.type === "image" ? spec.source.registryId : null },
    });
  });
  const user = userOf(ctx.principal);
  const deployment = queueDeploy(ctx, {
    serviceId: info.service.id,
    trigger: "manual",
    actor: actorOf(ctx),
    triggeredBy: user?.id ?? null,
    notes: [`Version change: ${state.from.image || state.from.version} to ${image}.`],
  });
  publishService(ctx, info.service);
  invalidateService(ctx, info.service.id, [dbOps.get.id, dbOps.versionChoices.id]);
  return { database: toDatabase(loadDatabase(ctx, info.service.id), ctx.agents), deploymentId: deployment.id };
});

async function raiseFeatureCompatibility(ctx: OpContext, info: DatabaseInfo, nodeId: string, version: string): Promise<void> {
  const exec = mongoFcvExec(info.admin.user, info.admin.password, version);
  const refuse = (detail: string) =>
    new OpError(
      "CONFLICT",
      `Could not set MongoDB's featureCompatibilityVersion to ${version} before the upgrade, so nothing changed. Check that the database is running and healthy, then try again. ${detail}`.trim(),
      { reason: "fcvFailed" },
    );
  let result: { exitCode: number; stdout: Uint8Array; stderr: Uint8Array };
  try {
    result = await ctx.agents.call(
      nodeId,
      "exec",
      { serviceId: info.service.id, command: exec.command, stdin: new TextEncoder().encode(exec.stdin), timeout: { seconds: 60n } },
      { timeoutMs: 75_000, metadata: { actor: userOf(ctx.principal)?.id ?? "" } },
    );
  } catch (error) {
    throw refuse(error instanceof Error ? error.message : "");
  }
  if (result.exitCode !== 0) {
    const output = new TextDecoder().decode(result.stdout).trim().split("\n").at(-1)?.slice(0, 300) ?? "";
    ctx.logger.warn({ serviceId: info.service.id, exitCode: result.exitCode, output }, "mongo featureCompatibilityVersion change failed");
    throw refuse(output ? `MongoDB said: ${output}` : "");
  }
}
