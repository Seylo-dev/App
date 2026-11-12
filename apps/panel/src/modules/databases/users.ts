// The Users tab of a database: its login users, read live from the engine
// (Seylo keeps no table of them), new users with an access preset, new
// passwords, renames, deletes, and the main user, the one Seylo signs in
// with and stores (admin_user and the admin_password secret). Every change
// runs in the database through the agent's Exec (user-scripts.ts) first;
// what Seylo stores changes only after the database took it. One change at
// a time per database (withUserLock), never while a deploy of it runs.
// databases.resetPassword and a main user's setUserPassword share
// changeMainPassword. Nothing an engine prints goes to the log or the
// audit, only exit codes: a failing statement can echo a password.

import { parseEnv } from "@seylo/env-analyzer";
import { databases as dbOps, env as envOps, exposures as exposureOps, OpError } from "@seylo/ops";
import type { Static } from "@sinclair/typebox";
import { and, eq, ne } from "drizzle-orm";
import { userOf } from "../../auth/principal";
import { serviceDatabases, services } from "../../db/schema";
import { implement, type OpContext } from "../../ops/implement";
import { activeDeploy, queueDeploy } from "../deployments/queue";
import { invalidateService } from "../domains/lookup";
import { readServiceEnv } from "../env/store";
import { actorOf } from "../services/ops";
import { changePasswordExec, generatePassword, rootPasswordVariable, rootUnchangedMarker } from "./engines";
import { adminPasswordSecret, type DatabaseInfo, exposedConnection, internalConnection, loadDatabase, writeSecret } from "./info";
import {
  type Admin,
  createUserExec,
  deleteUserExec,
  type EngineUser,
  type Exec,
  isSqlEngine,
  type Listing,
  listExec,
  mainPasswordExec,
  manageableName,
  maxUsers,
  mysqlAfterSwitchExec,
  mysqlSelfExec,
  parseListing,
  postgresPredefinedRolesVersion,
  proofExec,
  renameUserExec,
  scrub,
  setPasswordExec,
  signInFailedCode,
  switchPrepareExec,
  type UserPreset,
} from "./user-scripts";

type DatabaseUser = Static<typeof dbOps.DatabaseUser>;
type UserRef = Static<typeof dbOps.DatabaseUserRef>;
type RenameMode = "inPlace" | "restart" | "switch" | "none";

/** The env references that carry the main user's password. */
const passwordVariables = ["PASSWORD", "INTERNAL_URL", "INTERNAL_HTTP_URL", "EXPOSED_URL"];
/** And its name: a rename or a switch changes USER too. */
const nameVariables = [...passwordVariables, "USER"];

/** Services of the project whose env references any of variables of this database. */
export function servicesUsing(ctx: OpContext, info: DatabaseInfo, variables: readonly string[] = passwordVariables): string[] {
  const name = info.service.name.toLowerCase();
  const rows = ctx.db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.projectId, info.service.projectId), ne(services.id, info.service.id)))
    .all();
  return rows
    .filter((row) =>
      parseEnv(readServiceEnv(ctx.db, ctx.secrets, row.id).text).entries.some((e) =>
        e.references.some((r) => r.target.toLowerCase() === name && variables.includes(r.variable)),
      ),
    )
    .map((row) => row.id);
}

/** The agent gets the new credentials (shell, web UI, backups, TLS jobs) and open screens read them again. */
export function afterChange(ctx: OpContext, info: { service: { id: string; projectId: string } }) {
  ctx.agents.desired.markDirty({ serviceId: info.service.id });
  invalidateService(ctx, info.service.id, [dbOps.get.id, dbOps.connection.id, dbOps.users.id, exposureOps.get.id, envOps.references.id]);
}

const tails = new Map<string, Promise<void>>();

/** One user change at a time per database, in this panel; the next waits for the one before it. */
export async function withUserLock<T>(serviceId: string, run: () => Promise<T>): Promise<T> {
  const before = tails.get(serviceId) ?? Promise.resolve();
  let release = () => {};
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = before.then(() => mine);
  tails.set(serviceId, tail);
  await before;
  try {
    return await run();
  } finally {
    release();
    if (tails.get(serviceId) === tail) tails.delete(serviceId);
  }
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runExec(ctx: OpContext, info: DatabaseInfo, exec: Exec): Promise<ExecResult> {
  if (!info.node) throw new OpError("CONFLICT", "The database is not placed on a node.", { reason: "noNode" });
  const result = await ctx.agents.call(
    info.node.id,
    "exec",
    { serviceId: info.service.id, command: exec.command, stdin: new TextEncoder().encode(exec.stdin), timeout: { seconds: 60n } },
    { timeoutMs: 75_000, metadata: { actor: userOf(ctx.principal)?.id ?? "" } },
  );
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}

/** The engine's last line of output, without secrets, for the message of a failure. */
function said(info: DatabaseInfo, result: ExecResult, secrets: readonly string[]): string {
  const last = (text: string) => text.trim().split("\n").at(-1) ?? "";
  const line = scrub(last(result.stderr) || last(result.stdout), secrets).slice(0, 300);
  return line ? ` ${info.engine.label} said: ${line}` : "";
}

/** Refuses a failed step: signInFailed when the database refused Seylo's sign-in, else execFailed. Logs the exit code only. */
function mustSucceed(ctx: OpContext, info: DatabaseInfo, result: ExecResult, what: string, secrets: readonly string[]): void {
  if (result.code === 0) return;
  ctx.logger.warn({ serviceId: info.service.id, exitCode: result.code }, `database ${what} failed`);
  if (result.code === signInFailedCode) {
    throw new OpError("CONFLICT", `${signInFailedMessage(info)} Nothing changed.`, { reason: "signInFailed" });
  }
  throw new OpError("CONFLICT", `The database refused to ${what}, so nothing changed.${said(info, result, secrets)}`, {
    reason: "execFailed",
    exitCode: String(result.code),
  });
}

function signInFailedMessage(info: DatabaseInfo): string {
  switch (info.row.engine) {
    case "mysql":
    case "mariadb":
      return `Seylo could not sign in to ${info.engine.label} as root, with the password the container gives it (${rootPasswordVariable(info.row.engine)}) or the main user's. Set the main user's password again: it gives root the same one.`;
    case "clickhouse":
      return "ClickHouse refused the sign-in of the user its container was started with. Deploy the database again so it takes the stored user and password.";
    default:
      return `${info.engine.label} refused Seylo's sign-in as ${info.admin.user}: the stored password no longer works (a restored backup or a change made in the shell). Enter the password that works.`;
  }
}

const admin = (info: DatabaseInfo): Admin => ({ ...info.admin });

/** Why changes cannot run now: not placed, stopped, the node away, or a deploy running. */
function notReady(ctx: OpContext, info: DatabaseInfo, deploys = true): { reason: string; message: string } | null {
  if (!info.node) return { reason: "noNode", message: "The database is not placed on a node." };
  if (info.service.stopped) return { reason: "notRunning", message: "The database is stopped. Start it to see and change its users." };
  if (!ctx.agents.isOnline(info.node.id))
    return { reason: "notRunning", message: `${info.node.name} is not connected. Its users can be changed once it is back.` };
  const active = deploys ? activeDeploy(ctx, info.service.id) : undefined;
  if (active)
    return {
      reason: "deployRunning",
      message: "A deploy of this database is running. Wait for it to finish, then change its users.",
    };
  return null;
}

function assertReady(ctx: OpContext, info: DatabaseInfo, deploys = true): void {
  const blocked = notReady(ctx, info, deploys);
  if (blocked) throw new OpError("CONFLICT", blocked.message, { reason: blocked.reason });
}

function assertMayDeploy(ctx: OpContext, info: DatabaseInfo, what: string): void {
  if (!ctx.access.can("services.deploy", { type: "service", id: info.service.id })) {
    throw new OpError(
      "FORBIDDEN",
      `${what} restarts the database, which needs the services.deploy permission. Ask someone who can deploy it.`,
      {
        action: "services.deploy",
      },
    );
  }
}

function deploy(ctx: OpContext, info: DatabaseInfo, note: string): string {
  const deployment = queueDeploy(ctx, {
    serviceId: info.service.id,
    trigger: "manual",
    actor: actorOf(ctx),
    triggeredBy: userOf(ctx.principal)?.id ?? null,
    notes: [note],
  });
  return deployment.id;
}

/** What the engine offers on the Users tab. */
function engineFeatures(info: DatabaseInfo, listing?: Listing | null) {
  const engine = info.row.engine;
  const presets: UserPreset[] =
    engine === "postgres"
      ? listing?.serverVersion && listing.serverVersion < postgresPredefinedRolesVersion
        ? ["serverAdmin"]
        : ["readOnly", "readWrite", "serverAdmin"]
      : isSqlEngine(engine)
        ? ["readOnly", "readWrite", "databaseAdmin", "serverAdmin"]
        : [];
  const rename: RenameMode =
    engine === "postgres"
      ? "inPlace"
      : engine === "mysql" || engine === "mariadb"
        ? info.admin.user === "root"
          ? "switch"
          : "inPlace"
        : engine === "mongo"
          ? "switch"
          : engine === "clickhouse"
            ? "restart"
            : "none";
  return {
    presets,
    hosts: engine === "mysql" || engine === "mariadb",
    canCreate: isSqlEngine(engine),
    canSwitch: engine === "postgres" || engine === "mysql" || engine === "mariadb" || engine === "mongo",
    rename,
    notice: info.engine.redisLike
      ? `${info.engine.label} has one user, default, and only its password changes here. Users made with ACL SETUSER live in memory only: Seylo starts ${info.engine.label} without an ACL file, so the next restart or deploy would remove them.`
      : null,
  };
}

const isMysql = (info: DatabaseInfo) => info.row.engine === "mysql" || info.row.engine === "mariadb";

function isMainUser(info: DatabaseInfo, u: { name: string; host: string | null; authDatabase: string | null }): boolean {
  if (u.name !== info.admin.user) return false;
  if (isMysql(info)) return u.host === "%";
  if (info.row.engine === "mongo") return u.authDatabase === "admin";
  if (info.row.engine === "clickhouse") return true;
  return true;
}

function refMatches(info: DatabaseInfo, u: EngineUser, ref: UserRef): boolean {
  if (u.name !== ref.name) return false;
  if (isMysql(info)) return u.host === (ref.host ?? "%");
  if (info.row.engine === "mongo") return u.authDatabase === (ref.authDatabase ?? "admin");
  return true;
}

const isMainRef = (info: DatabaseInfo, ref: UserRef) =>
  isMainUser(info, { name: ref.name, host: isMysql(info) ? (ref.host ?? "%") : null, authDatabase: ref.authDatabase ?? "admin" });

const mainWhy = "Seylo signs in with this one. Make another user the main one first.";
const shellWhy = "Its name has characters Seylo does not act on. Manage this one from the shell.";

/** A listed user with what the tab may do with it. */
function decorate(info: DatabaseInfo, u: EngineUser, all: readonly EngineUser[], rootOutOfStep: boolean): DatabaseUser {
  const engine = info.row.engine;
  const main = isMainUser(info, u);
  const features = engineFeatures(info);
  let system = false;
  let can = { password: true, rename: true, delete: true, makeMain: features.canSwitch };
  let why: string | null = null;
  const no = (reason: string, keep: Partial<typeof can> = {}) => {
    can = { password: false, rename: false, delete: false, makeMain: false, ...keep };
    why = reason;
  };
  if (main) {
    can = { password: true, rename: features.rename !== "none", delete: false, makeMain: false };
    why = mainWhy;
  } else if (!manageableName(u.name) || (u.host !== null && !manageableName(u.host))) {
    no(shellWhy);
  } else if (rootOutOfStep) {
    no("Seylo cannot sign in as root to change other users. Set the main user's password again first.");
  } else if (engine === "postgres" && u.bootstrap) {
    system = true;
    can.delete = false;
    why = "The database's first user, which Postgres never lets go.";
  } else if (isMysql(info) && u.name === "root") {
    system = true;
    const remote = u.host === "%";
    can = { password: false, rename: false, delete: remote, makeMain: remote };
    why =
      u.host === "localhost"
        ? "Used inside the container: the image and Seylo's own steps sign in with it. It always has the main user's password."
        : "Root always has the main user's password, so it changes with the main user's.";
  } else if (engine === "clickhouse" && u.storage === "users_xml") {
    system = true;
    no("Defined in the server's configuration files, not with SQL.");
  } else if (isMysql(info) && u.host !== "%") {
    can.makeMain = false;
  } else if (engine === "mongo") {
    if (u.authDatabase !== "admin") can.makeMain = false;
    const roots = all.filter((x) => x.fullRights);
    if (u.fullRights && roots.length <= 1) {
      can.delete = false;
      why = "The last user with root: without it nothing could manage the database's users.";
    }
  }
  if (engine === "clickhouse" && !main) can.makeMain = false;
  return {
    name: u.name,
    host: u.host,
    authDatabase: u.authDatabase,
    main,
    system,
    access: main && engine === "clickhouse" ? "serverAdmin" : u.access,
    roles: u.roles,
    locked: u.locked,
    ownsObjects: u.ownsObjects,
    definerObjects: u.definerObjects,
    renameNeedsPassword: engine === "mongo" ? !main : u.passwordKind === "md5",
    can,
    why,
  };
}

/** The main user from what Seylo stores, while the engine cannot be asked. */
function storedMainUser(info: DatabaseInfo, reason: string, features: ReturnType<typeof engineFeatures>): DatabaseUser {
  // Restart-type changes need no running database: the new env is the change.
  const restart = info.engine.passwordChange === "restart";
  return {
    name: info.admin.user,
    host: isMysql(info) ? "%" : null,
    authDatabase: info.row.engine === "mongo" ? "admin" : null,
    main: true,
    system: false,
    access: info.engine.redisLike ? "custom" : "serverAdmin",
    roles: [],
    locked: false,
    ownsObjects: null,
    definerObjects: null,
    renameNeedsPassword: false,
    can: { password: restart, rename: restart && features.rename === "restart", delete: false, makeMain: false },
    why: restart ? mainWhy : reason,
  };
}

interface Read {
  listing: Listing | null;
  signIn: "ok" | "failed";
  message: string | null;
  /** MySQL and MariaDB: root did not sign in, the main user did (only it is listed). */
  rootOutOfStep: boolean;
}

/** Lists the users through the engine; on MySQL a main user that signs in while root does not is listed alone. */
async function readUsers(ctx: OpContext, info: DatabaseInfo): Promise<Read> {
  const engine = info.row.engine;
  if (!isSqlEngine(engine)) return { listing: null, signIn: "ok", message: null, rootOutOfStep: false };
  const result = await runExec(ctx, info, listExec(engine, admin(info)));
  if (result.code === 0)
    return { listing: parseListing(engine, result.stdout, info.admin.database), signIn: "ok", message: null, rootOutOfStep: false };
  if (result.code !== signInFailedCode) mustSucceed(ctx, info, result, "list its users", [info.admin.password]);
  if (engine === "mysql" || engine === "mariadb") {
    const self = await runExec(ctx, info, mysqlSelfExec(engine, info.admin.user, info.admin.password));
    if (self.code === 0) {
      const only: EngineUser = {
        name: info.admin.user,
        host: "%",
        authDatabase: null,
        access: "custom",
        roles: [],
        locked: false,
        fullRights: false,
        ownsObjects: null,
        definerObjects: null,
        bootstrap: false,
        passwordKind: null,
        storage: null,
      };
      return {
        listing: { users: [only], serverVersion: null, databases: [] },
        signIn: "ok",
        message: `${info.engine.label}'s root user kept an older password, which Seylo does not know, so only ${info.admin.user} is listed and nothing else can change here. Set ${info.admin.user}'s password again: Seylo then gives root the same one where root still signs in, or says how to set it by hand.`,
        rootOutOfStep: true,
      };
    }
  }
  ctx.logger.warn({ serviceId: info.service.id, exitCode: result.code }, "database sign-in failed");
  return { listing: null, signIn: "failed", message: signInFailedMessage(info), rootOutOfStep: false };
}

/** readUsers for a change: refuses when Seylo cannot sign in, or root is out of step. */
async function inspect(ctx: OpContext, info: DatabaseInfo): Promise<Listing> {
  const read = await readUsers(ctx, info);
  if (!read.listing)
    throw new OpError("CONFLICT", `${read.message ?? signInFailedMessage(info)} Nothing changed.`, { reason: "signInFailed" });
  if (read.rootOutOfStep) throw new OpError("CONFLICT", read.message ?? "", { reason: "signInFailed" });
  return read.listing;
}

function findUser(info: DatabaseInfo, listing: Listing, ref: UserRef): EngineUser {
  const found = listing.users.find((u) => refMatches(info, u, ref));
  if (!found) throw new OpError("CONFLICT", `${describe(info, ref)} is not a user of this database (any more).`, { reason: "notFound" });
  return found;
}

function describe(info: DatabaseInfo, ref: { name: string; host?: string | null; authDatabase?: string | null }): string {
  if (isMysql(info)) return `'${ref.name}'@'${ref.host ?? "%"}'`;
  if (info.row.engine === "mongo" && ref.authDatabase && ref.authDatabase !== "admin") return `${ref.name} (${ref.authDatabase})`;
  return ref.name;
}

function refOf(info: DatabaseInfo, u: { name: string; host: string | null; authDatabase: string | null }): UserRef {
  return {
    name: u.name,
    ...(isMysql(info) ? { host: u.host ?? "%" } : {}),
    ...(info.row.engine === "mongo" ? { authDatabase: u.authDatabase ?? "admin" } : {}),
  };
}

const target = (u: EngineUser) => ({ name: u.name, host: u.host ?? "%", authDatabase: u.authDatabase ?? "admin" });

/** Names Seylo will not give a user: the engine's own and those its image or Seylo needs. */
function assertNameAllowed(info: DatabaseInfo, name: string): void {
  const lower = name.toLowerCase();
  const engine = info.row.engine;
  const reserved =
    lower.startsWith("seylo_tmp_") ||
    (engine === "postgres" &&
      (lower.startsWith("pg_") || ["public", "none", "current_user", "session_user", "current_role"].includes(lower))) ||
    ((engine === "mysql" || engine === "mariadb") && ["root", "healthcheck", "public"].includes(lower)) ||
    (engine === "clickhouse" && lower === "default") ||
    (engine === "mongo" && lower === "__system");
  if (reserved)
    throw new OpError("BAD_REQUEST", `${name} is a name ${info.engine.label} or Seylo keeps for itself. Pick another one.`, {
      field: "name",
    });
  // MySQL's limit (MariaDB's is 80).
  if (isMysql(info) && name.length > 32)
    throw new OpError("BAD_REQUEST", "MySQL and MariaDB user names have at most 32 characters.", { field: "name" });
}

function assertFree(info: DatabaseInfo, listing: Listing, ref: UserRef): void {
  if (listing.users.some((u) => refMatches(info, u, ref)))
    throw new OpError("CONFLICT", `${describe(info, ref)} already exists.`, { reason: "exists" });
}

function notOffered(info: DatabaseInfo): OpError {
  return new OpError(
    "CONFLICT",
    `${info.engine.label} has one user, default. Only its password changes, on the Users tab or with databases.resetPassword.`,
    { reason: "notOffered" },
  );
}

// The main user's password: databases.resetPassword and setUserPassword.

export interface MainPasswordResult {
  password: string;
  affectedServiceIds: string[];
  warning: string | null;
  deploymentId: string | null;
}

/**
 * Changes the main user's password in the running database, then stores
 * it. Postgres and MongoDB sign in with the stored login; MySQL and
 * MariaDB give root the same password (changePasswordExec). ClickHouse
 * and Dragonfly read it from their environment at start, and Redis, Valkey
 * and KeyDB would start with the old one again (CONFIG SET only changes
 * the running server), so those queue a deploy with the new one, which
 * needs services.deploy; ClickHouse and Dragonfly need no running database.
 */
export async function changeMainPassword(ctx: OpContext, info: DatabaseInfo, password: string): Promise<MainPasswordResult> {
  const engine = info.row.engine;
  const restarts = info.engine.passwordChange === "restart" || info.engine.redisLike;
  if (restarts) assertMayDeploy(ctx, info, "A new password");
  return withUserLock(info.service.id, async () => {
    let warning: string | null = null;
    const exec =
      engine === "postgres" || engine === "mongo"
        ? mainPasswordExec(engine, admin(info), password)
        : changePasswordExec(engine, info.admin.user, password, info.admin.password);
    if (exec) {
      if (!info.node) throw new OpError("CONFLICT", "The database is not placed on a node.", { reason: "noNode" });
      // Change it inside the running database first; only store it once that worked.
      const result = await runExec(ctx, info, exec);
      if (result.code !== 0) {
        ctx.logger.warn({ serviceId: info.service.id, exitCode: result.code }, "database password change failed");
        if (result.code === signInFailedCode)
          throw new OpError("CONFLICT", `${signInFailedMessage(info)} Nothing changed.`, { reason: "signInFailed" });
        throw new OpError("CONFLICT", "The database refused the password change. Check that it is running and try again.", {
          reason: "execFailed",
          exitCode: String(result.code),
        });
      }
      if (result.stdout.includes(rootUnchangedMarker)) {
        ctx.logger.warn({ serviceId: info.service.id }, "database root password left out of step");
        warning = rootUnchangedWarning(info);
      }
    }
    ctx.db.transaction((tx) => {
      writeSecret(tx, ctx.secrets, info.service.id, adminPasswordSecret, password);
    });
    afterChange(ctx, info);
    const deploymentId = restarts ? deploy(ctx, info, "Database password change: the database restarts with the new password.") : null;
    return { password, affectedServiceIds: servicesUsing(ctx, info), warning, deploymentId };
  });
}

/**
 * What resetPassword says when a MySQL or MariaDB admin other than root
 * changed its own password but root could not sign in to get the same one
 * (changePasswordExec printed rootUnchangedMarker): root is out of step
 * with the password the container gives it.
 */
function rootUnchangedWarning(info: DatabaseInfo): string {
  const variable = rootPasswordVariable(info.row.engine === "mariadb" ? "mariadb" : "mysql");
  const label = info.engine.label;
  return `The password of ${info.admin.user} changed, but ${label}'s root user kept an older password, which the panel does not know: root no longer signs in with the one the database's container gives it (${variable}), as after a password reset before 0.2.11 or a change made by hand, and ${info.admin.user} cannot change root's. Root sign-ins with ${variable} fail until root has the new password: sign in as root with its older password and run ALTER USER 'root'@'%' IDENTIFIED BY '<new password>' and the same for 'root'@'localhost'. Later resets then change both.`;
}

// Ops

export const listUsers = implement(dbOps.users, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  const features = engineFeatures(info);
  const base = {
    engine: info.row.engine,
    hosts: features.hosts,
    canCreate: features.canCreate,
    notice: features.notice,
    main: { user: info.admin.user, rename: features.rename, canSwitch: features.canSwitch },
  };
  const blocked = notReady(ctx, info, false);
  if (blocked || info.engine.redisLike) {
    const main = blocked
      ? storedMainUser(info, blocked.message, features)
      : { ...storedMainUser(info, "", features), can: { password: true, rename: false, delete: false, makeMain: false }, why: mainWhy };
    return {
      ...base,
      presets: features.presets,
      users: [main],
      truncated: false,
      signIn: blocked ? ("offline" as const) : ("ok" as const),
      message: blocked?.message ?? null,
    };
  }
  const read = await readUsers(ctx, info);
  if (!read.listing) {
    const main = storedMainUser(info, read.message ?? "", features);
    return {
      ...base,
      presets: features.presets,
      // The password is what has to change: Postgres through its trusted socket, MySQL through root, else the one that works (known).
      users: [{ ...main, can: { ...main.can, password: true }, why: read.message }],
      truncated: false,
      signIn: "failed" as const,
      message: read.message,
    };
  }
  const listing = read.listing;
  const all = listing.users.slice(0, maxUsers);
  const users = all.map((u) => decorate(info, u, all, read.rootOutOfStep));
  // The main user first, then by name.
  users.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name) || (a.host ?? "").localeCompare(b.host ?? ""));
  return {
    ...base,
    presets: read.rootOutOfStep ? [] : engineFeatures(info, listing).presets,
    canCreate: base.canCreate && !read.rootOutOfStep,
    users,
    truncated: listing.users.length > maxUsers,
    signIn: "ok" as const,
    message: read.message,
  };
});

export const createUser = implement(dbOps.createUser, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  const engine = info.row.engine;
  if (!isSqlEngine(engine)) throw notOffered(info);
  assertNameAllowed(info, input.name);
  if (input.host !== undefined && !isMysql(info))
    throw new OpError("BAD_REQUEST", `${info.engine.label} users have no host.`, { field: "host" });
  assertReady(ctx, info);
  return withUserLock(info.service.id, async () => {
    const listing = await inspect(ctx, info);
    const presets = engineFeatures(info, listing).presets;
    if (!presets.includes(input.access))
      throw new OpError("BAD_REQUEST", `${info.engine.label} offers ${presets.join(", ")} here.`, { field: "access" });
    const host = input.host ?? "%";
    const ref: UserRef = { name: input.name, ...(isMysql(info) ? { host } : {}), ...(engine === "mongo" ? { authDatabase: "admin" } : {}) };
    assertFree(info, listing, ref);
    const password = input.password ?? generatePassword();
    const result = await runExec(
      ctx,
      info,
      createUserExec(engine, admin(info), { name: input.name, host, access: input.access, password }),
    );
    mustSucceed(ctx, info, result, "create the user", [password, info.admin.password]);
    invalidateService(ctx, info.service.id, [dbOps.users.id]);
    // As the engine lists it now, else as it was made.
    const after = await readUsers(ctx, info).catch(() => null);
    const made = after?.listing?.users.find((u) => refMatches(info, u, ref));
    const listed: EngineUser = made ?? {
      name: input.name,
      host: isMysql(info) ? host : null,
      authDatabase: engine === "mongo" ? "admin" : null,
      access: input.access,
      roles: [],
      locked: false,
      fullRights: input.access === "serverAdmin",
      ownsObjects: engine === "postgres" ? 0 : null,
      definerObjects: isMysql(info) ? 0 : null,
      bootstrap: false,
      passwordKind: engine === "postgres" ? "scram" : null,
      storage: null,
    };
    const creds = { user: input.name, password, database: info.admin.database };
    return {
      user: decorate(info, listed, after?.listing?.users ?? [listed], false),
      password,
      internalUrl: internalConnection(info, creds).url,
      exposedUrl: exposedConnection(info, creds)?.url ?? null,
    };
  });
});

export const setUserPassword = implement(dbOps.setUserPassword, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  const engine = info.row.engine;
  if (isMainRef(info, input.user) || (info.engine.redisLike && input.user.name === "default")) {
    if (input.known) return storeKnownPassword(ctx, info, input.password);
    return changeMainPassword(ctx, info, input.password ?? generatePassword());
  }
  if (!isSqlEngine(engine)) throw notOffered(info);
  if (input.known)
    throw new OpError("BAD_REQUEST", "known only stores the main user's password: Seylo keeps no other.", { field: "known" });
  assertReady(ctx, info);
  return withUserLock(info.service.id, async () => {
    const listing = await inspect(ctx, info);
    const found = findUser(info, listing, input.user);
    const user = decorate(info, found, listing.users, false);
    if (!user.can.password)
      throw new OpError("CONFLICT", user.why ?? "Seylo does not change this user's password.", { reason: "systemUser" });
    const password = input.password ?? generatePassword();
    const result = await runExec(ctx, info, setPasswordExec(engine, admin(info), target(found), password));
    mustSucceed(ctx, info, result, "change the password", [password, info.admin.password]);
    invalidateService(ctx, info.service.id, [dbOps.users.id]);
    return { password, affectedServiceIds: [], deploymentId: null, warning: null };
  });
});

/**
 * setUserPassword known: the main user's password that works, after
 * Seylo's stored one stopped working (a restored backup, a change in the
 * shell). Stored only once Seylo signed in with it; the database is not
 * changed. ClickHouse and the Redis-like engines take the stored one from
 * their environment, so there it is a plain change.
 */
async function storeKnownPassword(ctx: OpContext, info: DatabaseInfo, password: string | undefined) {
  const engine = info.row.engine;
  if (!password) throw new OpError("BAD_REQUEST", "Enter the password that works.", { field: "password" });
  if (engine !== "postgres" && engine !== "mysql" && engine !== "mariadb" && engine !== "mongo")
    throw new OpError("BAD_REQUEST", `${info.engine.label} takes the stored password at start: set a new one instead.`, { field: "known" });
  assertReady(ctx, info, false);
  return withUserLock(info.service.id, async () => {
    const proof = await runExec(ctx, info, proofExec(engine, { ...admin(info), password }));
    if (proof.code !== 0) {
      ctx.logger.warn({ serviceId: info.service.id, exitCode: proof.code }, "database sign-in with a known password failed");
      throw new OpError("CONFLICT", `${info.engine.label} refused ${info.admin.user} with that password, so nothing changed.`, {
        reason: "signInFailed",
      });
    }
    ctx.db.transaction((tx) => writeSecret(tx, ctx.secrets, info.service.id, adminPasswordSecret, password));
    afterChange(ctx, info);
    return { password, affectedServiceIds: servicesUsing(ctx, info), deploymentId: null, warning: null };
  });
}

export const renameUser = implement(dbOps.renameUser, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  const engine = info.row.engine;
  if (!isSqlEngine(engine)) throw notOffered(info);
  assertNameAllowed(info, input.name);
  if (input.host !== undefined && !isMysql(info))
    throw new OpError("BAD_REQUEST", `${info.engine.label} users have no host.`, { field: "host" });
  const main = isMainRef(info, input.user);
  if (main) return renameMainUser(ctx, info, input);
  assertReady(ctx, info);
  return withUserLock(info.service.id, async () => {
    const listing = await inspect(ctx, info);
    const found = findUser(info, listing, input.user);
    const user = decorate(info, found, listing.users, false);
    if (!user.can.rename) throw new OpError("CONFLICT", user.why ?? "Seylo does not rename this user.", { reason: "systemUser" });
    const host = input.host ?? found.host ?? "%";
    const to: UserRef = {
      name: input.name,
      ...(isMysql(info) ? { host } : {}),
      ...(engine === "mongo" ? { authDatabase: found.authDatabase ?? "admin" } : {}),
    };
    if (to.name === found.name && (to.host ?? null) === (isMysql(info) ? found.host : null))
      throw new OpError("BAD_REQUEST", "That is its name already.", { field: "name" });
    assertFree(info, listing, to);
    assertDefiners(info, found, input.acceptOrphanDefiners);
    if (user.renameNeedsPassword && !input.password)
      throw new OpError(
        "BAD_REQUEST",
        engine === "mongo"
          ? "MongoDB has no rename: a new user with the same roles replaces this one, so it needs a new password."
          : "Postgres clears an md5 password when the user is renamed, so the rename needs a new password.",
        { field: "password" },
      );
    const password = input.password ?? null;
    const result = await runExec(ctx, info, renameUserExec(engine, admin(info), target(found), { name: input.name, host, password }));
    mustSucceed(ctx, info, result, "rename the user", [password ?? "", info.admin.password]);
    invalidateService(ctx, info.service.id, [dbOps.users.id]);
    return { user: to, password, affectedServiceIds: [], deploymentId: null, warning: null };
  });
});

function assertDefiners(info: DatabaseInfo, found: EngineUser, accept: boolean | undefined): void {
  const count = found.definerObjects ?? 0;
  if (!isMysql(info) || count === 0 || accept) return;
  throw new OpError(
    "CONFLICT",
    `${count === 1 ? "A view, routine, trigger or event runs" : `${count} views, routines, triggers or events run`} as ${describe(info, found)} (DEFINER). They stop working once it is renamed or deleted, until they are made again with another definer. Nothing changed.`,
    { reason: "definerObjects", count: String(count) },
  );
}

/**
 * The main user's new name. Postgres renames it in place (the session
 * user, through a temporary role) and restarts the database so its
 * container's environment (the health check's user) has the new name;
 * MySQL and MariaDB rename an admin other than root in place (its env
 * name is only read at the first start); ClickHouse stores it and
 * restarts: the image makes its user from the environment at every start.
 * Seylo stores the name (and the password set with it) after the engine
 * took it.
 */
async function renameMainUser(ctx: OpContext, info: DatabaseInfo, input: Static<typeof dbOps.renameUser.input>) {
  const engine = info.row.engine;
  if (!isSqlEngine(engine)) throw notOffered(info);
  const mode = engineFeatures(info).rename;
  if (mode === "switch")
    throw new OpError(
      "CONFLICT",
      engine === "mongo"
        ? "MongoDB has no rename. Use another user as the main one instead (databases.switchMainUser)."
        : `${info.engine.label}'s root user stays: the image, its health check and Seylo's own steps need it. Use another user as the main one instead (databases.switchMainUser).`,
      { reason: "useSwitchMainUser" },
    );
  if (mode === "none") throw notOffered(info);
  if (input.name === info.admin.user) throw new OpError("BAD_REQUEST", "That is its name already.", { field: "name" });
  if (isMysql(info) && input.host !== undefined && input.host !== "%")
    throw new OpError("BAD_REQUEST", "The main user signs in from any host (%): Seylo's tools and services connect from other addresses.", {
      field: "host",
    });
  const restarts = mode === "restart" || (engine === "postgres" && input.deploy !== false);
  if (restarts) assertMayDeploy(ctx, info, "A new name");
  if (mode === "restart") {
    // ClickHouse: the new name must not be one of its SQL users. A database that is not running is checked on its next start.
    const blocked = notReady(ctx, info);
    if (blocked?.reason === "deployRunning") throw new OpError("CONFLICT", blocked.message, { reason: blocked.reason });
    return withUserLock(info.service.id, async () => {
      if (!blocked) assertFree(info, await inspect(ctx, info), { name: input.name });
      return storeMainUser(
        ctx,
        info,
        input.name,
        input.password ?? null,
        true,
        `Database user change: the main user is now ${input.name}.`,
      );
    });
  }
  assertReady(ctx, info);
  return withUserLock(info.service.id, async () => {
    const listing = await inspect(ctx, info);
    const found = findUser(info, listing, refOf(info, { name: info.admin.user, host: "%", authDatabase: "admin" }));
    assertFree(info, listing, { name: input.name, ...(isMysql(info) ? { host: "%" } : {}) });
    assertDefiners(info, found, input.acceptOrphanDefiners);
    const password = input.password ?? null;
    if (engine === "postgres" && found.passwordKind === "md5" && !password)
      throw new OpError("BAD_REQUEST", "Postgres clears an md5 password when the user is renamed, so the rename needs a new password.", {
        field: "password",
      });
    const exec = renameUserExec(engine, admin(info), target(found), { name: input.name, host: "%", password });
    const result = await runExec(ctx, info, exec);
    mustSucceed(ctx, info, result, "rename the user", [password ?? "", info.admin.password]);
    let warning: string | null = null;
    if (password && isMysql(info)) {
      // Root has the main user's password.
      const roots = await runExec(ctx, info, mysqlAfterSwitchExec(engine as "mysql" | "mariadb", admin(info), password, null));
      if (roots.code !== 0) warning = rootUnchangedWarning({ ...info, admin: { ...info.admin, user: input.name } });
    }
    const note =
      engine === "postgres"
        ? `Database user change: the main user is now ${input.name}; the database restarts so its environment has the new name.`
        : "";
    return { ...storeMainUser(ctx, info, input.name, password, restarts, note), warning };
  });
}

/** Stores a new main user name (and password), tells the agent and open screens, and queues the restart when asked. */
function storeMainUser(ctx: OpContext, info: DatabaseInfo, name: string, password: string | null, restart: boolean, note: string) {
  ctx.db.transaction((tx) => {
    tx.update(serviceDatabases).set({ adminUser: name }).where(eq(serviceDatabases.serviceId, info.service.id)).run();
    if (password) writeSecret(tx, ctx.secrets, info.service.id, adminPasswordSecret, password);
  });
  afterChange(ctx, info);
  const deploymentId = restart ? deploy(ctx, info, note) : null;
  return {
    user: refOf(info, { name, host: "%", authDatabase: "admin" }),
    password,
    affectedServiceIds: servicesUsing(ctx, info, nameVariables),
    deploymentId,
    warning: null as string | null,
  };
}

export const deleteUser = implement(dbOps.deleteUser, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  const engine = info.row.engine;
  if (!isSqlEngine(engine)) throw notOffered(info);
  if (isMainRef(info, input.user))
    throw new OpError("CONFLICT", "Seylo signs in with this user. Make another user the main one first.", { reason: "mainUser" });
  assertReady(ctx, info);
  return withUserLock(info.service.id, async () => {
    const listing = await inspect(ctx, info);
    const found = findUser(info, listing, input.user);
    const user = decorate(info, found, listing.users, false);
    if (!user.can.delete) {
      const last = engine === "mongo" && found.fullRights;
      throw new OpError("CONFLICT", user.why ?? "Seylo does not delete this user.", { reason: last ? "lastAdmin" : "systemUser" });
    }
    const owns = found.ownsObjects ?? 0;
    if (engine === "postgres" && owns > 0 && !input.reassignOwned)
      throw new OpError(
        "CONFLICT",
        `${found.name} owns ${owns === 1 ? "a table or another object" : `${owns} tables and other objects`}. Give ${owns === 1 ? "it" : "them"} to ${info.admin.user} first (reassignOwned), or drop ${owns === 1 ? "it" : "them"} in the shell. Nothing changed.`,
        { reason: "ownsObjects", count: String(owns) },
      );
    assertDefiners(info, found, input.acceptOrphanDefiners);
    const others = listing.users.filter((u) => u.name === found.name && u.host !== found.host).length;
    const exec = deleteUserExec(engine, admin(info), target(found), { databases: listing.databases, killSessions: others === 0 });
    const result = await runExec(ctx, info, exec);
    mustSucceed(ctx, info, result, "delete the user", [info.admin.password]);
    invalidateService(ctx, info.service.id, [dbOps.users.id]);
    return { deleted: true as const, reassignedObjects: engine === "postgres" ? owns : 0 };
  });
});

/**
 * Another user as the main one: made (with full rights) or given a new
 * password (Seylo does not know the old one), proved by signing in as it,
 * then stored. A user made here is removed again when the proof fails.
 * MySQL and MariaDB then give root the new password (root always has the
 * main user's) and drop the old main user when asked (root: root@% only).
 * Postgres and MongoDB drop the old one signed in as the new.
 */
export const switchMainUser = implement(dbOps.switchMainUser, async (input, ctx) => {
  const info = loadDatabase(ctx, input.serviceId);
  const engine = info.row.engine;
  if (engine !== "postgres" && engine !== "mysql" && engine !== "mariadb" && engine !== "mongo")
    throw new OpError(
      "CONFLICT",
      engine === "clickhouse"
        ? "ClickHouse's main user is the one its container is started with: rename it instead (databases.renameUser)."
        : notOffered(info).message,
      { reason: "notOffered" },
    );
  if (input.name === info.admin.user) throw new OpError("BAD_REQUEST", `${input.name} is the main user already.`, { field: "name" });
  if (!input.existing) assertNameAllowed(info, input.name);
  assertReady(ctx, info);
  return withUserLock(info.service.id, async () => {
    const listing = await inspect(ctx, info);
    const oldMain = listing.users.find((u) => isMainUser(info, u)) ?? null;
    const ref = refOf(info, { name: input.name, host: "%", authDatabase: "admin" });
    if (input.existing) {
      const found = findUser(info, listing, ref);
      if (!found.fullRights && !input.grantAdmin)
        throw new OpError(
          "CONFLICT",
          `${describe(info, found)} does not have full rights, which the main user needs for backups, the web UI and the Users tab. Give it full rights with the switch (grantAdmin), or pick another user.`,
          { reason: "notAdmin" },
        );
    } else {
      assertFree(info, listing, ref);
    }
    const drop = input.oldUser === "delete";
    if (drop && engine === "postgres" && oldMain?.bootstrap)
      throw new OpError("BAD_REQUEST", `${info.admin.user} is the database's first user, which Postgres never lets go. Keep it.`, {
        field: "oldUser",
      });
    const password = input.password ?? generatePassword();
    const secrets = [password, info.admin.password];
    const to = { name: input.name, password, existing: input.existing === true, grantAdmin: input.grantAdmin === true };
    mustSucceed(ctx, info, await runExec(ctx, info, switchPrepareExec(engine, admin(info), to)), "set up the user", secrets);
    const next: Admin = { user: input.name, password, database: info.admin.database };
    const proof = await runExec(ctx, info, proofExec(engine, next));
    if (proof.code !== 0) {
      ctx.logger.warn({ serviceId: info.service.id, exitCode: proof.code }, "database new main user sign-in failed");
      // A user made for the switch goes again; an existing one keeps its new password, which nothing uses yet.
      if (!to.existing) {
        const made = { name: input.name, host: "%", authDatabase: "admin" };
        await runExec(ctx, info, deleteUserExec(engine, admin(info), made, { databases: listing.databases })).catch(() => null);
      }
      throw new OpError(
        "CONFLICT",
        `Seylo could not sign in as ${input.name} the way its tools do, so it stays as it was and ${info.admin.user} is still the main user.${said(info, proof, secrets)}`,
        { reason: "signInFailed" },
      );
    }
    let warning: string | null = null;
    if (engine === "mysql" || engine === "mariadb") {
      const old = drop ? { name: info.admin.user, host: "%" } : null;
      const after = await runExec(ctx, info, mysqlAfterSwitchExec(engine, admin(info), password, old));
      if (after.code !== 0) {
        ctx.logger.warn({ serviceId: info.service.id, exitCode: after.code }, "database root password left out of step");
        warning = `${input.name} is the main user now, but root kept its older password, which Seylo signs in with for its own steps until the next deploy. Set ${input.name}'s password again on the Users tab: that gives root the same one.${drop ? ` ${describe(info, { name: info.admin.user, host: "%" })} was not removed.` : ""}`;
      }
    }
    ctx.db.transaction((tx) => {
      tx.update(serviceDatabases).set({ adminUser: input.name }).where(eq(serviceDatabases.serviceId, info.service.id)).run();
      writeSecret(tx, ctx.secrets, info.service.id, adminPasswordSecret, password);
    });
    afterChange(ctx, info);
    if (drop && oldMain && (engine === "postgres" || engine === "mongo")) {
      const gone = await runExec(ctx, info, deleteUserExec(engine, next, target(oldMain), { databases: listing.databases })).catch(
        () => null,
      );
      if (gone?.code !== 0) {
        ctx.logger.warn({ serviceId: info.service.id, exitCode: gone?.code ?? -1 }, "database old main user not removed");
        warning = `${input.name} is the main user now, but ${info.admin.user} could not be removed. Delete it on the Users tab.`;
      }
    }
    return { user: input.name, password, affectedServiceIds: servicesUsing(ctx, info, nameVariables), deploymentId: null, warning };
  });
});
