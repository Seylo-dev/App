// Version changes of a database: which catalog versions it may move to
// (judgeVersion, the engines' upgrade rules in one pure function), custom
// images of the engine's own official repository, MongoDB's
// featureCompatibilityVersion step, MySQL 8.4's mysql_native_password
// check and opt-in, and the databases.versionChoices and
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
import { engines, engineVersion, engineVersions, hasNativePassword, withNativePassword } from "./engines";
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

/** The release in an image's tag ("mongo:8.0.38" is 8.0.38, "postgres:17.6-alpine" 17.6); null for a digest or a tag without one. */
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
 * - The same line with a newer image is a patch update (a catalog image or
 *   another exact tag of that line, the same release on another base too);
 *   an older image is refused, and so is the very image that runs (current).
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
    if (to.image === from.image) {
      return { kind: "current", allowed: false, reason: "current", message: `The database already runs ${to.image}: nothing to change.` };
    }
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
  if (!claims) throw new OpError("BAD_REQUEST", notOfLine(engine, variant, version, repo, tag, example), field);
  if (engine === "postgres" && baseOf(tag) !== baseOf(catalogTag)) {
    throw new OpError(
      "BAD_REQUEST",
      `${repo}:${tag} is built on another base system than the catalog's ${repo}:${catalogTag}: its C library sorts text differently, which breaks the indexes on text columns. Use a tag such as ${example}.`,
      field,
    );
  }
  return `${repo}:${tag}`;
}

/**
 * Why customImage refuses a tag that is not a release of `version`. An
 * exact release of another line of the engine ("mongo:8.2.12" on 8.0) is
 * named as that line, with whether the catalog has it: a move to another
 * version goes through the catalog's list, not a tag. A tag with a shorter
 * release ("mongo:8.2", a line's moving tag) moves to each new release of
 * it, and one without a release (latest) to each new release.
 */
function notOfLine(engine: DatabaseEngine, variant: string | null, version: string, repo: string, tag: string, example: string): string {
  const label = engines[engine].label;
  const release = /^v?(\d+(?:\.\d+)*)/.exec(tag)?.[1] ?? null;
  const depth = version.split(".").length;
  // pgvector's tags name their Postgres line after the release ("0.8.8-pg18-trixie" is 18).
  const line =
    variant === "pgvector"
      ? (/^\d+(?:\.\d+)*-pg(\d+)(?:-|$)/.exec(tag)?.[1] ?? null)
      : release && release.split(".").length > depth
        ? release.split(".").slice(0, depth).join(".")
        : null;
  if (line !== null && line !== version) {
    const offered = (engineVersions(engine, variant) ?? []).some((v) => v.version === line);
    return [
      `${repo}:${tag} is ${label} ${line}, not ${version}.`,
      ...(offered ? [] : [`Seylo does not offer ${label} ${line}${variant ? ` with ${variant}` : ""}.`]),
      `Another tag takes ${example} releases; to move to another version, pick it in the list above.`,
    ].join(" ");
  }
  if (release !== null && variant !== "pgvector") {
    return `${repo}:${tag} is not an exact release: it moves to each new ${label} ${release} release. Use a tag such as ${repo}:${example}.`;
  }
  return `${repo}:${tag} is not an exact release: a tag without a full release number moves to each new release. Use a tag such as ${repo}:${example}.`;
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

/** MySQL's own accounts, which no one signs in with. */
const mysqlSystemAccounts = ["mysql.sys", "mysql.session", "mysql.infoschema"];

/**
 * The script of mysqlNativeUsersExec. Root signs in on the socket with the
 * container's MYSQL_ROOT_PASSWORD, like changePasswordExec, as MYSQL_PWD
 * (an environment variable, never an argument): an admin other than root
 * (MYSQL_USER) has rights on its own database only and cannot read
 * mysql.user. Only when root's sign-in is refused (ERROR 1045, or no
 * MYSQL_ROOT_PASSWORD) does the admin ($1) sign in over TCP with the
 * password from stdin's first line (the shell's read, a builtin); any other
 * failure of root's (the server down) is the result. The query is the rest
 * of stdin.
 */
const mysqlNativeUsersScript = [
  "IFS= read -r pw || exit 2",
  'q=$(cat); [ -n "$q" ] || exit 2',
  'if [ -n "$MYSQL_ROOT_PASSWORD" ]; then',
  '  { err=$(MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -N -B -e "$q" 2>&1 >&3); } 3>&1',
  "  code=$?",
  '  [ "$code" -eq 0 ] && exit 0',
  '  [ -z "$err" ] || printf \'%s\\n\' "$err" >&2',
  '  case "$err" in *"ERROR 1045"*) ;; *) exit "$code" ;; esac',
  "fi",
  'MYSQL_PWD="$pw" exec mysql -h127.0.0.1 -u"$1" -N -B -e "$q"',
].join("\n");

/**
 * Exec call that lists the accounts of a running MySQL whose plugin is
 * mysql_native_password, one user@host a line, MySQL's own system accounts
 * left out: MySQL 8.4 ships that plugin off, so they could not sign in
 * there. Root reads the list (mysqlNativeUsersScript), the admin only when
 * root cannot sign in; the admin's password and the query go on stdin.
 */
export function mysqlNativeUsersExec(user: string, password: string): { command: string[]; stdin: string } {
  const query = `SELECT CONCAT(user, '@', host) FROM mysql.user WHERE plugin = 'mysql_native_password' AND user NOT IN (${mysqlSystemAccounts.map((a) => `'${a}'`).join(", ")}) ORDER BY user, host;`;
  return { command: ["sh", "-c", mysqlNativeUsersScript, "sh", user], stdin: `${password}\n${query}\n` };
}

/** At most this many accounts are named in a nativePasswordUsers refusal. */
const namedAccounts = 10;

/** The refusal of a MySQL change that would lock out accounts signing in with mysql_native_password. */
export function nativePasswordRefusal(accounts: readonly string[], version: string): OpError {
  const named = accounts.slice(0, namedAccounts);
  const more = accounts.length - named.length;
  const list = `${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  const which =
    accounts.length === 1 ? "this account signs in with it, so it" : `these ${accounts.length} accounts sign in with it, so they`;
  return new OpError(
    "CONFLICT",
    `MySQL ${version} has the mysql_native_password plugin off, and ${which} could not sign in after the change: ${list}. Nothing changed. Switch them to caching_sha2_password first (ALTER USER 'user'@'host' IDENTIFIED WITH caching_sha2_password BY '<password>', which needs each account's password), or keep mysql_native_password logins on in MySQL ${version} (keepNativePassword).`,
    { reason: "nativePasswordUsers", accounts: named.join("\n"), count: String(accounts.length) },
  );
}

/**
 * What a version change does with MySQL's mysql_native_password logins,
 * from the container command the database is set to run and setVersion's
 * keepNativePassword (left out: as it is). command is the new container
 * command, null to leave it; check means the running database's accounts
 * with the plugin are listed first, since the change turns it off for
 * them: from 8.0 (on by itself) to 8.4 without the opt-in, or 8.4 with it
 * on to 8.4 without. A line without the option (8.0, staying after a
 * failed change) runs without it: the plugin is on there anyway.
 */
export function nativePasswordPlan(
  engine: DatabaseEngine,
  command: readonly string[],
  from: string,
  to: string,
  keep: boolean | undefined,
): { on: boolean; check: boolean; command: string[] | null } {
  const optionLine = (version: string) => engineVersion("mysql", version)?.nativePasswordOption === true;
  const takes = engine === "mysql" && optionLine(to);
  if (keep === true && !takes) {
    const lines = engines.mysql.versions.filter((v) => v.nativePasswordOption).map((v) => v.version);
    throw new OpError(
      "BAD_REQUEST",
      engine === "mysql"
        ? `MySQL ${to} has mysql_native_password on by itself: keepNativePassword is for MySQL ${lines.join(", ")}.`
        : `keepNativePassword is for MySQL ${lines.join(", ")} only.`,
      { field: "keepNativePassword" },
    );
  }
  if (engine !== "mysql") return { on: false, check: false, command: null };
  const was = hasNativePassword(command);
  const on = takes && (keep ?? was);
  const check = takes && !on && (was || !optionLine(from));
  if (on === was) return { on, check, command: null };
  const next = withNativePassword(command, on);
  if (!next) {
    throw new OpError(
      "CONFLICT",
      `The database runs its own command (${command.join(" ")}), which is not mysqld's: add or take out --mysql-native-password=ON there, then change the version.`,
      { reason: "customCommand" },
    );
  }
  return { on, check, command: next };
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
  /** The container command it is set to run (MySQL's mysql_native_password option). */
  command: string[];
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
    command: spec.container.command,
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
    customOnCurrent:
      state.blocked === null &&
      officialRepository(state.info.row.engine, state.info.row.variant) !== null &&
      catalog.some((v) => v.version === state.from.version),
    recentBackupAt: state.recentBackupAt?.toISOString() ?? null,
    backupFresh: backupFresh(state, new Date()),
    nativePassword:
      state.info.row.engine === "mysql"
        ? {
            on: hasNativePassword(state.command),
            lines: catalog.filter((v) => v.nativePasswordOption).map((v) => v.version),
          }
        : null,
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
  const native = nativePasswordPlan(info.row.engine, state.command, state.from.version, to.version, input.keepNativePassword);
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
  if (native.check && node) await assertNoNativePasswordUsers(ctx, info, node.id, to.version);
  // Another change may have queued its deploy while the MongoDB or MySQL step ran.
  assertNoActiveDeploy(ctx, info.service.id);

  ctx.db.transaction((tx) => {
    tx.update(serviceDatabases).set({ version: to.version }).where(eq(serviceDatabases.serviceId, info.service.id)).run();
    // Read again: other settings may have changed while the MongoDB or MySQL step ran.
    const spec = readSpec(tx.select({ spec: services.spec }).from(services).where(eq(services.id, info.service.id)).get()?.spec);
    const command = native.command ? withNativePassword(spec.container.command, native.on) : null;
    writeSpec(tx, info.service.id, {
      ...spec,
      source: { type: "image", image, registryId: spec.source.type === "image" ? spec.source.registryId : null },
      ...(command ? { container: { ...spec.container, command } } : {}),
    });
  });
  const user = userOf(ctx.principal);
  const deployment = queueDeploy(ctx, {
    serviceId: info.service.id,
    trigger: "manual",
    actor: actorOf(ctx),
    triggeredBy: user?.id ?? null,
    notes: [
      `Version change: ${state.from.image || state.from.version} to ${image}.`,
      ...(native.command ? [`mysql_native_password logins ${native.on ? "on (--mysql-native-password=ON)" : "off"}.`] : []),
    ],
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
  await execStep(ctx, info, nodeId, exec, refuse, "mongo featureCompatibilityVersion change failed");
}

/**
 * Lists the running MySQL's accounts that sign in with mysql_native_password
 * (mysqlNativeUsersExec) and refuses the change when there are any
 * (nativePasswordUsers), or when the list cannot be read
 * (nativePasswordCheckFailed): either way nothing changed.
 */
async function assertNoNativePasswordUsers(ctx: OpContext, info: DatabaseInfo, nodeId: string, version: string): Promise<void> {
  const exec = mysqlNativeUsersExec(info.admin.user, info.admin.password);
  const refuse = (detail: string) =>
    new OpError(
      "CONFLICT",
      `Could not list the MySQL accounts that sign in with mysql_native_password, which MySQL ${version} has off, so nothing changed. Check that the database is running and healthy, then try again, or keep mysql_native_password logins on in MySQL ${version} (keepNativePassword), which needs no list. ${detail}`.trim(),
      { reason: "nativePasswordCheckFailed" },
    );
  const stdout = await execStep(ctx, info, nodeId, exec, refuse, "mysql native password check failed");
  const accounts = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (accounts.length > 0) throw nativePasswordRefusal(accounts, version);
}

/**
 * Runs a step of a version change in the running database through the
 * agent's Exec (the secret on stdin) and returns its stdout; refuse makes
 * the error when the agent cannot run it or it exits non-zero, with the
 * database's last line of output.
 */
async function execStep(
  ctx: OpContext,
  info: DatabaseInfo,
  nodeId: string,
  exec: { command: string[]; stdin: string },
  refuse: (detail: string) => OpError,
  failure: string,
): Promise<string> {
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
  const stdout = new TextDecoder().decode(result.stdout);
  if (result.exitCode !== 0) {
    // mongosh prints its errors on stdout, mysql on stderr.
    const lastLine = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim().split("\n").at(-1) ?? "";
    const output = (lastLine(result.stdout) || lastLine(result.stderr)).slice(0, 300);
    ctx.logger.warn({ serviceId: info.service.id, exitCode: result.exitCode, output }, failure);
    throw refuse(output ? `${info.engine.label} said: ${output}` : "");
  }
  return stdout;
}
