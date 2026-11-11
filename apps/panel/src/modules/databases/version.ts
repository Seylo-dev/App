// Version changes of a database: which catalog versions it may move to
// (judgeVersion, the engines' upgrade rules in one pure function), any
// image of the engine's own repository (judgeImage: the rules' refusals
// become risks the caller accepts, 0.2.11), MongoDB's
// featureCompatibilityVersion step, MySQL 8.4's mysql_native_password
// check and opt-in, and the databases.versionChoices and
// databases.setVersion ops. A change writes service_databases.version and
// the spec's image (the variant stays) and deploys; databases deploy in
// recreate mode on the same data volume, and a new version that never gets
// healthy brings the old container back.

import { databases as dbOps, env as envOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, desc, eq, isNull } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { backupRuns, type DatabaseEngine, deployments, serviceDatabases, services, volumes } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { activeDeploy, assertNoActiveDeploy, queueDeploy } from "../deployments/queue";
import { invalidateService } from "../domains/lookup";
import { readServiceEnv, writeServiceEnv } from "../env/store";
import { writeSpec } from "../services/insert";
import { actorOf, publishService } from "../services/ops";
import { loadService } from "../services/rows";
import { readSpec } from "../services/spec";
import { engines, engineVersion, engineVersions, hasNativePassword, rootPasswordVariable, withNativePassword } from "./engines";
import { baseOfTag, customLine, engineImage, engineRepository, hasOfficialRepository, imageTag, tagRelease } from "./images";
import { type DatabaseInfo, loadDatabase } from "./info";
import { toDatabase } from "./ops";
import { definesPgdata, lineDataFolder, needsPgdataPin, pgdataExec, versionPinNote, withPgdata } from "./pgdata";

type Choice = Static<typeof dbOps.VersionChoice>;
export type VersionKind = Choice["kind"];
export type Judgement = Pick<Choice, "kind" | "allowed" | "reason" | "risk" | "message">;

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

/** A version point and what its image's tag says (images.ts engineImage); catalog images are neither. */
export interface ImagePoint extends VersionPoint {
  /** The tag can point at other bytes on the next deploy (latest, "8.2"), so its release is unknown. */
  floating?: boolean;
  /** The image names a digest, which does not show its release. */
  digest?: boolean;
}

/** What a change can risk (VersionChoice.risk), the most serious first. */
export const riskOrder = [
  "downgrade",
  "olderImage",
  "postgresMajor",
  "dataPath",
  "patchOnly",
  "oneStep",
  "otherLine",
  "postgresBase",
  "floatingTag",
  "digest",
] as const;
export type Risk = (typeof riskOrder)[number];

/** A judgement with every risk it found, the most serious (risk) first. */
export type Judged = Judgement & { risks: Risk[] };

/**
 * judgeVersion for any image of the engine (0.2.11). Only the image that
 * runs stays refused (current, nothing to change); each refusal of the
 * rules is a risk instead, and so are a line outside the catalog on either
 * side (otherLine: not tested by Seylo, and the catalog's one-step rule
 * says nothing about it), another Postgres base system (postgresBase), a
 * floating tag (floatingTag: what it points at can change, so the release
 * is unknown) and a digest (digest: its release does not show), as the
 * target or as what runs. A tag that names no release (customLine) cannot
 * be judged against the other side at all. risk is the most serious one
 * (riskOrder) and message says all of them, naming what a tag is: the
 * line of a release the catalog does not have ("mongo:8.2.12 is MongoDB
 * 8.2. Seylo does not offer MongoDB 8.2"), and that a floating tag is not
 * an exact release but moves to each new one. `variant` (pgvector) only
 * changes those words.
 */
export function judgeImage(
  engine: DatabaseEngine,
  from: ImagePoint,
  to: ImagePoint,
  lines: readonly string[],
  variant: string | null = null,
): Judged {
  if (to.image === from.image) return nothingToChange(to.image);
  const unknown = from.version === customLine || to.version === customLine;
  const sameLine = !unknown && compareVersions(to.version, from.version) === 0;
  // A floating tag's release is unknown: the rules compare releases on the same line.
  const base: Judgement = unknown
    ? { kind: "upgrade", allowed: true }
    : sameLine && (from.floating || to.floating)
      ? { kind: "patch", allowed: true }
      : judgeVersion(engine, from, to, lines);
  const risks = new Set<Risk>();
  if (!base.allowed && base.reason) risks.add(base.reason as Risk);
  if (!unknown && !sameLine && (!lines.includes(to.version) || !lines.includes(from.version))) {
    risks.delete("oneStep");
    risks.add("otherLine");
  }
  // from.dataPath is where the volume is; a tag that names no release has no known folder.
  if (to.version !== customLine && to.dataPath !== from.dataPath) risks.add("dataPath");
  if (engine === "postgres") {
    const a = imageTag(from.image);
    const b = imageTag(to.image);
    if (a !== null && b !== null && baseOfTag(a) !== baseOfTag(b)) risks.add("postgresBase");
  }
  if (from.floating || to.floating) risks.add("floatingTag");
  if (to.digest || (from.digest && from.version === customLine)) risks.add("digest");
  const ordered = riskOrder.filter((r) => risks.has(r));
  const [risk] = ordered;
  if (!risk) return { ...base, risks: [] };
  return { kind: base.kind, allowed: true, risk, message: riskMessage(engine, variant, from, to, ordered, lines), risks: ordered };
}

/**
 * The very image that runs: nothing to change, whatever line it is
 * recorded as. judgeVersion compares lines first, and a line that names
 * no release (customLine: latest, a digest) does not compare.
 */
function nothingToChange(image: string): Judged {
  return {
    kind: "current",
    allowed: false,
    reason: "current",
    message: `The database already runs ${image}: nothing to change.`,
    risks: [],
  };
}

/** The risks of a change in sentences, the most serious first, and what protects the data. */
function riskMessage(
  engine: DatabaseEngine,
  variant: string | null,
  from: ImagePoint,
  to: ImagePoint,
  risks: readonly Risk[],
  lines: readonly string[],
): string {
  const label = engines[engine].label;
  const next = lines.filter((v) => compareVersions(v, from.version) > 0).sort(compareVersions)[0];
  // "mongo:8.2.12 is MongoDB 8.2. Seylo does not offer MongoDB 8.2" (with pgvector for that variant).
  const notOffered = (image: string, line: string) =>
    `${image} is ${label} ${line}. Seylo does not offer ${label} ${line}${variant ? ` with ${variant}` : ""}`;
  // A floating tag moves to each new release of the release it names (pgvector's tags name pgvector's), or to each new one.
  const moves = (image: string) => {
    const tag = imageTag(image);
    const release = tag && variant !== "pgvector" ? tagRelease(tag) : null;
    return release ? `it moves to each new ${label} ${release} release` : "a tag without a full release number moves to each new release";
  };
  const sentence: Record<Risk, () => string> = {
    downgrade: () =>
      `${label} ${to.version} is older than the ${from.version} that runs: it may not open data files a newer version wrote.`,
    olderImage: () => `${to.image} is older than ${from.image}, which runs: it may not open data files a newer release wrote.`,
    postgresMajor: () =>
      `${label} ${to.version} does not open ${label} ${from.version} data files without pg_upgrade or a dump and restore, which do not run here, so it will most likely not start.`,
    dataPath: () =>
      `${label} ${to.version} keeps its data in another folder than ${from.version}: Seylo runs it on the folder of the data that runs (PGDATA), so it will most likely not start.`,
    patchOnly: () => `${label} takes patch updates only: ${to.version} may not read the data files of ${from.version}.`,
    oneStep: () => `${label} upgrades one version at a time: ${to.version} skips ${next ?? "a version"}, and may refuse the data files.`,
    otherLine: () =>
      lines.includes(to.version)
        ? `${notOffered(from.image, from.version)}, so this change from it is not tested by Seylo.`
        : `${notOffered(to.image, to.version)}, so this change is not tested by Seylo.`,
    postgresBase: () =>
      `${to.image} is built on another base system than ${from.image}: its C library may sort text in another order, so indexes on text columns may need REINDEX.`,
    floatingTag: () =>
      to.floating
        ? `${to.image} is not an exact release: ${moves(to.image)}, so the release behind it can change on the next deploy, and Seylo cannot tell which release it is.`
        : `${from.image}, which runs, is not an exact release: ${moves(from.image)}, so Seylo cannot tell which release runs and cannot check this change.`,
    digest: () =>
      to.digest
        ? `A digest does not show which release ${to.image} is, so Seylo cannot check this change.`
        : `${from.image}, which runs, is a digest: Seylo cannot tell which release runs, so it cannot check this change.`,
  };
  const out = risks.map((r) => sentence[r]());
  // Only a one-step upgrade between catalog lines takes no risk, and only that one gets the step.
  if (engine === "mongo" && (to.version !== from.version || to.version === customLine)) {
    out.push(
      "MongoDB may refuse data whose featureCompatibilityVersion it does not support: Seylo sets it only for a one-step upgrade between its catalog versions.",
    );
  }
  out.push("If the new version never gets healthy, the old container comes back on the same data.");
  return out.join(" ");
}

/** The official repository of an engine's images (and variant's); null for KeyDB and Dragonfly, which have none (engineRepository). */
export function officialRepository(engine: DatabaseEngine, variant: string | null): string | null {
  return hasOfficialRepository(engine) ? engineRepository(engine, variant) : null;
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
 * The script of mysqlNativeUsersExec. Root signs in on the socket as
 * MYSQL_PWD (an environment variable, never an argument), like
 * changePasswordExec: first with the container's MYSQL_ROOT_PASSWORD, then
 * with the admin's password from stdin's first line (the shell's read, a
 * builtin), since a password reset gives root the admin's new password at
 * once while the container keeps the old environment until its next
 * deploy. An admin other than root (MYSQL_USER) has rights on its own
 * database only and cannot read mysql.user. Only when root's sign-in is
 * refused both ways (ERROR 1045) does the admin ($1) sign in over TCP with
 * that password; any other failure of root's (the server down) is the
 * result. The query is the rest of stdin.
 */
const mysqlNativeUsersScript = [
  "IFS= read -r pw || exit 2",
  'q=$(cat); [ -n "$q" ] || exit 2',
  "tried=",
  `for p in "$${rootPasswordVariable("mysql")}" "$pw"; do`,
  '  [ -n "$p" ] && [ "$p" != "$tried" ] || continue',
  "  tried=$p",
  '  { err=$(MYSQL_PWD="$p" mysql -uroot -N -B -e "$q" 2>&1 >&3); } 3>&1',
  "  code=$?",
  '  [ "$code" -eq 0 ] && exit 0',
  '  [ -z "$err" ] || printf \'%s\\n\' "$err" >&2',
  '  case "$err" in *"ERROR 1045"*) ;; *) exit "$code" ;; esac',
  "done",
  'MYSQL_PWD="$pw" exec mysql -h127.0.0.1 -u"$1" -N -B -e "$q"',
].join("\n");

/**
 * Exec call that lists the accounts of a running MySQL whose plugin is
 * mysql_native_password, one user@host a line, MySQL's own system accounts
 * left out: MySQL 8.4 ships that plugin off, so they could not sign in
 * there. Root reads the list (mysqlNativeUsersScript), with the container's
 * root password or the admin's, the admin only when root cannot sign in;
 * the admin's password and the query go on stdin.
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
 * Whether a MySQL change lists the running database's accounts on
 * mysql_native_password first (assertNoNativePasswordUsers):
 * nativePasswordPlan's check, and every change to a line from 8.4 on that
 * the catalog does not have (9.0 removed the plugin; a tag that names no
 * release counts as one), from a line that has the plugin on by itself
 * (before 8.4), a command that turns it on, or an image whose tag names no
 * release (mysql:8 pulled while it was 8.0, mysql:5): it may be such a line.
 */
export function nativePasswordCheckNeeded(
  engine: DatabaseEngine,
  command: readonly string[],
  from: string,
  to: string,
  plan: { on: boolean; check: boolean },
): boolean {
  if (plan.check) return true;
  if (engine !== "mysql" || plan.on) return false;
  const off = (version: string) => version === customLine || compareVersions(version, "8.4") >= 0;
  return off(to) && (hasNativePassword(command) || from === customLine || !off(from));
}

/**
 * Refuses keepNativePassword for a MySQL line from 9.0 on, or a tag that
 * names no release: 9.0 removed the plugin, so there is nothing to keep on
 * (nativePasswordPlan refuses it for the other lines without the option).
 */
export function assertNativePasswordKeepable(engine: DatabaseEngine, to: string, keep: boolean | undefined): void {
  if (engine !== "mysql" || keep !== true) return;
  if (to !== customLine && compareVersions(to, "9.0") < 0) return;
  const lines = engines.mysql.versions.filter((v) => v.nativePasswordOption).map((v) => v.version);
  throw new OpError(
    "BAD_REQUEST",
    `${to === customLine ? "The MySQL this image runs may have" : `MySQL ${to} has`} no mysql_native_password plugin to keep on: keepNativePassword is for MySQL ${lines.join(", ")}.`,
    { field: "keepNativePassword" },
  );
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
  from: ImagePoint;
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
  const from =
    pending && running
      ? { version: lineOfRunning(info, running, catalog), image: running, dataPath, ...imageFlags(info, running, catalog) }
      : null;
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
    from: from ?? { version: info.row.version, image, dataPath, ...imageFlags(info, image, catalog) },
    pending,
    lines: catalog.map((v) => v.version),
    blocked,
    recentBackupAt: backup?.finishedAt ?? null,
    command: spec.container.command,
  };
}

/**
 * The line of the image that still runs after a change whose deploy
 * failed: the catalog's, else the one its tag names (engineImage), else
 * what the row says.
 */
function lineOfRunning(info: DatabaseInfo, running: string, catalog: readonly { version: string; image: string }[]): string {
  const known = lineOfImage(running, catalog);
  if (known) return known;
  try {
    return engineImage(info.row.engine, info.row.variant, running).version;
  } catch {
    return info.row.version;
  }
}

/** Whether an image's tag floats or it names a digest, for judgeImage; neither for a catalog image or another repository's. */
function imageFlags(info: DatabaseInfo, image: string, catalog: readonly { image: string }[]): { floating: boolean; digest: boolean } {
  if (catalog.some((v) => v.image === image)) return { floating: false, digest: false };
  try {
    const parsed = engineImage(info.row.engine, info.row.variant, image);
    return { floating: parsed.floating, digest: parsed.digest !== null };
  } catch {
    return { floating: false, digest: false };
  }
}

/**
 * What setVersion moves to: any image of the engine's repository (the
 * line its tag names, or customLine), else the catalog line's image.
 */
function targetOf(info: DatabaseInfo, version: string | undefined, image: string | undefined): ImagePoint {
  const catalog = engineVersions(info.row.engine, info.row.variant) ?? [];
  if (image !== undefined) {
    const parsed = engineImage(info.row.engine, info.row.variant, image);
    return { version: parsed.version, image: parsed.image, dataPath: parsed.dataPath, ...imageFlags(info, parsed.image, catalog) };
  }
  const line = catalog.find((v) => v.version === version);
  if (!line) {
    throw new OpError(
      "BAD_REQUEST",
      `${version === undefined ? "Give a version or an image." : `${info.engine.label}${info.row.variant ? ` with ${info.row.variant}` : ""} ${version} is not offered.`} Pick one of ${catalog.map((v) => v.version).join(", ")}, or give any image of ${engineRepository(info.row.engine, info.row.variant) ?? "its repository"}.`,
      { field: "version" },
    );
  }
  return { version: line.version, image: line.image, dataPath: line.dataPath };
}

/**
 * judgeImage from what runs. After a change whose deploy failed, the
 * image that still runs may be set again (it only restarts the database),
 * and the change itself runs again under the same rules. The image that
 * runs is nothing to change, unless its command changes (`commandChange`:
 * MySQL 8.4's mysql_native_password turned on or off, keepNativePassword):
 * then it deploys again with the new command, a change of its own that
 * takes no risk and no backup.
 */
function judge(state: VersionState, to: ImagePoint, commandChange = false): Judged {
  const j = judgeImage(state.info.row.engine, state.from, to, state.lines, state.info.row.variant);
  if (j.reason === "current" && state.pending) {
    return {
      kind: "current",
      allowed: true,
      message: `Stay on ${to.image}: the change to ${state.pending.image} did not finish.`,
      risks: [],
    };
  }
  if (j.reason === "current" && commandChange) {
    return { kind: "current", allowed: true, message: `Deploy ${to.image} again with the new command.`, risks: [] };
  }
  return j;
}

/** The refusal of a change that takes a risk without acceptRisk: what can go wrong, and that nothing changed. */
export function riskRefusal(verdict: Judged, to: ImagePoint, backupRequired: boolean): OpError {
  return new OpError("CONFLICT", `${verdict.message ?? ""} Nothing changed: accept the risk (acceptRisk) to go ahead.`.trim(), {
    reason: "riskNotAccepted",
    risk: verdict.risk ?? "",
    risks: verdict.risks.join(","),
    message: verdict.message ?? "",
    version: to.version,
    image: to.image,
    backupRequired: String(backupRequired),
  });
}

function backupFresh(state: VersionState, now: Date): boolean {
  return state.recentBackupAt !== null && now.getTime() - state.recentBackupAt.getTime() <= backupMaxAgeMs;
}

export const versionChoices = implement(dbOps.versionChoices, (input, ctx) => {
  const state = versionState(ctx, input.serviceId);
  const catalog = engineVersions(state.info.row.engine, state.info.row.variant) ?? [];
  const repository = engineRepository(state.info.row.engine, state.info.row.variant);
  const tag = imageTag(state.from.image);
  return {
    engine: state.info.row.engine,
    version: state.from.version,
    variant: state.info.row.variant,
    image: state.from.image,
    release: tag ? tagRelease(tag) : null,
    repository,
    anyImage: repository !== null,
    pendingImage: state.pending?.image ?? null,
    choices: catalog.map((v) => {
      const { risks, ...j } = judge(state, v);
      return { version: v.version, image: v.image, ...j, ...(risks.length > 0 ? { risks } : {}) };
    }),
    blocked: state.blocked,
    customOnCurrent: state.blocked === null && repository !== null,
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
  const to = targetOf(info, input.version, input.image);
  const image = to.image;
  assertNativePasswordKeepable(info.row.engine, to.version, input.keepNativePassword);
  const native = nativePasswordPlan(info.row.engine, state.command, state.from.version, to.version, input.keepNativePassword);
  const verdict = judge(state, to, native.command !== null);
  // The image that runs with mysql_native_password turned on or off (keepNativePassword): the command is the change.
  const flagOnly = verdict.kind === "current" && state.pending === null && native.command !== null;
  if (!verdict.allowed)
    throw new OpError("CONFLICT", verdict.message ?? "This version change is not allowed.", { reason: verdict.reason ?? "" });
  const lineChange = to.version !== state.from.version;
  // Every change but a newer patch of the line it runs: another line, or a risk taken.
  const needsBackup = lineChange || verdict.risk !== undefined;
  const fresh = backupFresh(state, new Date());
  if (verdict.risk && !input.acceptRisk) throw riskRefusal(verdict, to, needsBackup && !fresh);
  if (needsBackup && !input.confirmNoBackup && !fresh) {
    throw new OpError(
      "CONFLICT",
      "Back up the database first: there is no successful backup from the last 24 hours, and a new version cannot be undone. Or confirm the change without a backup.",
      { reason: "backupRequired" },
    );
  }
  const node = info.node;
  // Only a one-step upgrade between catalog lines takes no risk: other MongoDB moves get no compatibility step.
  if (lineChange && !verdict.risk && info.row.engine === "mongo" && node)
    await raiseFeatureCompatibility(ctx, info, node.id, state.from.version);
  if (nativePasswordCheckNeeded(info.row.engine, state.command, state.from.version, to.version, native) && node)
    await assertNoNativePasswordUsers(ctx, info, node.id, to.version);
  const pgdata = node ? await pgdataPin(ctx, state, node.id, to) : null;
  // Another change may have queued its deploy while the MongoDB, MySQL or PostgreSQL step ran.
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
    if (pgdata) writePgdataPin(tx, ctx, info.service.id, pgdata);
  });
  const user = userOf(ctx.principal);
  const deployment = queueDeploy(ctx, {
    serviceId: info.service.id,
    trigger: "manual",
    actor: actorOf(ctx),
    triggeredBy: user?.id ?? null,
    notes: [
      ...(flagOnly ? [] : [`Version change: ${state.from.image || state.from.version} to ${image}.`]),
      ...(verdict.risk ? [`Risk accepted: ${verdict.risks.join(", ")}.`] : []),
      ...(native.command
        ? [
            `mysql_native_password logins ${native.on ? "on (--mysql-native-password=ON)" : "off"}${flagOnly ? `, on the image it runs (${image})` : ""}.`,
          ]
        : []),
      ...(pgdata ? [`PGDATA set to ${pgdata}, the folder of the data that ran.`] : []),
    ],
  });
  publishService(ctx, info.service);
  invalidateService(ctx, info.service.id, [dbOps.get.id, dbOps.versionChoices.id, ...(pgdata ? [envOps.get.id] : [])]);
  return { database: toDatabase(loadDatabase(ctx, info.service.id), ctx.agents), deploymentId: deployment.id };
});

/**
 * The folder a PostgreSQL change pins PGDATA to (pgdata.ts), null when it
 * needs none: the cluster that runs, from the line it runs (18 on), else
 * as the running container says. Refused when that cannot be read:
 * nothing changed.
 */
async function pgdataPin(ctx: OpContext, state: VersionState, nodeId: string, to: ImagePoint): Promise<string | null> {
  const { info } = state;
  const env = readServiceEnv(ctx.db, ctx.secrets, info.service.id).text;
  if (!needsPgdataPin(info.row.engine, state.from.dataPath, env, state.from.version, to.version)) return null;
  const known = lineDataFolder(state.from.version);
  if (known) return known;
  const refuse = (detail: string) =>
    new OpError(
      "CONFLICT",
      `Could not read where PostgreSQL keeps the data that runs (PGDATA), so nothing changed. Check that the database is running and healthy, then try again. ${detail}`.trim(),
      { reason: "pgdataFailed" },
    );
  const folder = (await execStep(ctx, info, nodeId, pgdataExec, refuse, "postgres PGDATA read failed")).trim();
  if (!folder.startsWith("/")) throw refuse(folder ? `PostgreSQL said: ${folder.slice(0, 300)}` : "");
  return folder;
}

/** Writes the PGDATA pin into the database's .env, unless it was set there in the meantime. */
function writePgdataPin(tx: Parameters<typeof writeServiceEnv>[0], ctx: OpContext, serviceId: string, folder: string): void {
  const env = readServiceEnv(tx, ctx.secrets, serviceId).text;
  if (definesPgdata(env)) return;
  writeServiceEnv(tx, ctx.secrets, serviceId, withPgdata(env, folder, versionPinNote), userOf(ctx.principal)?.id ?? null);
}

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
  // MySQL 9.0 and later have no such plugin to keep on (nativePasswordCheckNeeded).
  const keepable = engineVersion("mysql", version)?.nativePasswordOption === true;
  const refuse = (detail: string) =>
    new OpError(
      "CONFLICT",
      `Could not list the MySQL accounts that sign in with mysql_native_password, which MySQL ${version} has off, so nothing changed. Check that the database is running and healthy, then try again${keepable ? `, or keep mysql_native_password logins on in MySQL ${version} (keepNativePassword), which needs no list` : ""}. ${detail}`.trim(),
      { reason: "nativePasswordCheckFailed" },
    );
  const stdout = await execStep(ctx, info, nodeId, exec, refuse, "mysql native password check failed");
  const accounts = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (accounts.length > 0) throw keepable ? nativePasswordRefusal(accounts, version) : nativePasswordGoneRefusal(accounts, version);
}

/**
 * The refusal of a change to a MySQL without mysql_native_password to keep
 * on (9.0 removed it; a tag that names no release), while accounts sign in
 * with it: they must switch first.
 */
export function nativePasswordGoneRefusal(accounts: readonly string[], version: string): OpError {
  const named = accounts.slice(0, namedAccounts);
  const more = accounts.length - named.length;
  const which = version === customLine ? "the MySQL it would run may not have" : `MySQL ${version} does not have`;
  return new OpError(
    "CONFLICT",
    `${accounts.length === 1 ? "This account signs" : `These ${accounts.length} accounts sign`} in with mysql_native_password, a plugin ${which}, so ${accounts.length === 1 ? "it" : "they"} could not sign in after the change: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Nothing changed. Switch them to caching_sha2_password first (ALTER USER 'user'@'host' IDENTIFIED WITH caching_sha2_password BY '<password>', which needs each account's password).`,
    { reason: "nativePasswordUsers", accounts: named.join("\n"), count: String(accounts.length) },
  );
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
