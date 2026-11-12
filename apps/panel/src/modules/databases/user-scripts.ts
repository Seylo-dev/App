// What the Users tab runs inside a database (through the agent's Exec, no
// agent change): one script per engine that signs in and runs the SQL or
// JavaScript on its stdin, and the statements that list, create, change
// and delete users. Every password goes on stdin (the scripts move it into
// the client's environment, never into an argument), Postgres gets a
// SCRAM verifier instead of the password itself, and names are quoted by
// one helper per engine. Parsers turn the list output (one JSON object a
// line) into users. The handlers are in users.ts.
//
// Sign-in, the same protocol everywhere: stdin line 1 is the stored main
// user's password, the rest is what runs. Postgres signs in as the main
// user on the container's socket, MySQL and MariaDB as root on the socket
// (with the container's root password, then the main user's), MongoDB as
// the main user inside the script, ClickHouse as the container's own user
// (the image recreates it from its environment at every start). A script
// exits signInFailedCode when the database refused the sign-in.

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type { DatabaseEngine } from "../../db/schema";
import { rootPasswordVariable } from "./engines";

export interface Exec {
  command: string[];
  stdin: string;
}

/** A script's exit code when the database refused its sign-in. */
export const signInFailedCode = 10;

export type UserAccess = "readOnly" | "readWrite" | "databaseAdmin" | "serverAdmin" | "custom" | "none";
export type UserPreset = "readOnly" | "readWrite" | "databaseAdmin" | "serverAdmin";

/** A user as the engine lists it, before the panel adds what may be done with it. */
export interface EngineUser {
  name: string;
  /** MySQL and MariaDB. */
  host: string | null;
  /** MongoDB. */
  authDatabase: string | null;
  access: UserAccess;
  roles: string[];
  locked: boolean;
  /** Full rights on the server: it can be the main user without grantAdmin. */
  fullRights: boolean;
  ownsObjects: number | null;
  definerObjects: number | null;
  /** Postgres: the bootstrap superuser (oid 10), which can never be dropped. */
  bootstrap: boolean;
  /** Postgres: how its password is stored; md5 is cleared by a rename. */
  passwordKind: "scram" | "md5" | "none" | "other" | null;
  /** ClickHouse: where the user is defined (users_xml for the image's own user). */
  storage: string | null;
}

export interface Listing {
  users: EngineUser[];
  /** Postgres: server_version_num and the databases that take connections. */
  serverVersion: number | null;
  databases: string[];
}

/** At most this many users are listed. */
export const maxUsers = 500;

// Quoting. Names are data: every name a script acts on goes through one of
// these, also names Seylo did not make. Names with control characters or
// backslashes are listed but never acted on (manageableName).

/** Postgres "identifier". */
export const pgIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;
/** Postgres 'literal' (standard_conforming_strings, the default since 9.1). */
export const pgLiteral = (text: string) => `'${text.replaceAll("'", "''")}'`;
/** psql meta-command argument ('text', quotes doubled). */
const psqlArg = (text: string) => `'${text.replaceAll("'", "''")}'`;
/** MySQL and MariaDB 'string'. */
export const mysqlString = (text: string) => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
/** MySQL and MariaDB 'user'@'host'. */
export const mysqlAccount = (name: string, host: string) => `${mysqlString(name)}@${mysqlString(host)}`;
/** MySQL and MariaDB `identifier`. */
export const mysqlIdent = (name: string) => `\`${name.replaceAll("`", "``")}\``;
/**
 * A database name in a database-level GRANT: _ and % are wildcards there,
 * so they are escaped (shop\_db), else a grant on shop_db would also cover
 * shopXdb. Default database names have underscores.
 */
export const mysqlGrantDatabase = (name: string) => mysqlIdent(name.replace(/[\\_%]/g, (c) => `\\${c}`));
/** ClickHouse `identifier`. */
export const chIdent = (name: string) => `\`${name.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
/** ClickHouse 'string'. */
export const chString = (text: string) => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
/** A JavaScript string literal for mongosh. */
const js = (text: string) => JSON.stringify(text);

/** Whether a listed name can be acted on: no control characters or backslashes (those stay for the shell). */
export function manageableName(name: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it looks for.
  return name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f\\]/.test(name);
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for a password (RFC 7677,
 * Postgres's "SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>").
 * Postgres takes it in CREATE ROLE and ALTER ROLE as it is, so the
 * password itself never reaches the server: a statement that fails and
 * lands in the container's log (which Seylo shows) holds no password. The
 * alphabet of Seylo's passwords needs no SASLprep.
 */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

/** Options for repeatable output (tests and the VM fixtures): the SCRAM salt and the temporary role's suffix. */
export interface ScriptOptions {
  salt?: Buffer;
  suffix?: string;
}

// Postgres

/**
 * $@ are psql's arguments (the main user and database). The main user
 * signs in on the container's socket, which the image trusts; PGPASSWORD
 * (stdin line 1) covers a pg_hba edited by hand. psql reads the rest of
 * stdin; its errors go to stderr as they are.
 */
const postgresScript = [
  "IFS= read -r pw || exit 2",
  "PGPASSWORD=$pw",
  "export PGPASSWORD",
  '{ err=$(psql -X -q -At -v ON_ERROR_STOP=1 "$@" 2>&1 >&3); } 3>&1',
  "code=$?",
  `[ -z "$err" ] || printf '%s\\n' "$err" >&2`,
  '[ "$code" -eq 0 ] && exit 0',
  `case "$err" in *'FATAL:  password authentication failed'*|*'FATAL:  role "'*'" does not exist'*) exit ${signInFailedCode} ;; esac`,
  'exit "$code"',
].join("\n");

function postgresExec(admin: { user: string; password: string; database: string }, sql: string, single: boolean): Exec {
  return {
    command: [
      "sh",
      "-c",
      postgresScript,
      "sh",
      `--username=${admin.user}`,
      `--dbname=${admin.database || "postgres"}`,
      ...(single ? ["--single-transaction"] : []),
    ],
    stdin: `${admin.password}\n${sql}\n`,
  };
}

/** Postgres 14 added pg_read_all_data and pg_write_all_data, which readOnly and readWrite use. */
export const postgresPredefinedRolesVersion = 140000;

const postgresListSql = [
  "SELECT json_build_object('kind', 'server', 'version', current_setting('server_version_num')::int, 'databases', (SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE datallowconn));",
  "SELECT json_build_object('kind', 'user', 'name', r.rolname, 'bootstrap', r.oid = 10, 'super', r.rolsuper, 'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb, 'expired', COALESCE(r.rolvaliduntil < now(), false), " +
    "'password', CASE WHEN r.rolpassword IS NULL THEN 'none' WHEN r.rolpassword LIKE 'SCRAM-SHA-256$%' THEN 'scram' WHEN r.rolpassword LIKE 'md5%' THEN 'md5' ELSE 'other' END, " +
    "'memberOf', COALESCE((SELECT json_agg(b.rolname ORDER BY b.rolname) FROM pg_auth_members m JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid), '[]'::json), " +
    "'owns', (SELECT count(*) FROM pg_shdepend d WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = r.oid AND d.deptype = 'o')) " +
    `FROM pg_authid r WHERE r.rolcanlogin AND r.rolname NOT LIKE 'pg\\_%' ORDER BY r.rolname LIMIT ${maxUsers + 1};`,
].join("\n");

function postgresGrants(name: string, access: UserPreset, database: string): string[] {
  const n = pgIdent(name);
  const db = pgIdent(database);
  switch (access) {
    case "readOnly":
      return [`GRANT CONNECT ON DATABASE ${db} TO ${n};`, `GRANT pg_read_all_data TO ${n};`];
    case "readWrite":
      // Tables it creates are its own; CREATE on public lets migrations run.
      return [
        `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${db} TO ${n};`,
        `GRANT pg_read_all_data, pg_write_all_data TO ${n};`,
        `GRANT USAGE, CREATE ON SCHEMA public TO ${n};`,
      ];
    case "serverAdmin":
      return [`ALTER ROLE ${n} SUPERUSER CREATEDB CREATEROLE;`];
    case "databaseAdmin":
      throw new Error("Postgres has no database admin preset");
  }
}

// MySQL and MariaDB

const mysqlClient = (engine: "mysql" | "mariadb") => (engine === "mysql" ? "mysql" : "mariadb");

/**
 * The root-first runner. stdin: the main user's password, one line of SQL,
 * and an optional line of SQL whose output is SQL to run after it with
 * --force (the KILL statements of a deleted user's sessions). Root signs
 * in on the socket with the container's root password, then with the main
 * user's (root always has the main user's password: containerEnv, and the
 * container keeps the old environment until its next deploy); a root main
 * user then over TCP (root@%). Any failure but a refused sign-in (ERROR
 * 1045) is the result; when nothing signs in as root, signInFailedCode.
 * $1 is the main user.
 */
function mysqlRootScript(engine: "mysql" | "mariadb"): string {
  const client = mysqlClient(engine);
  return [
    "IFS= read -r pw || exit 2",
    "IFS= read -r q || exit 2",
    "IFS= read -r follow || follow=",
    `run() { rp=$1; shift; { err=$(printf '%s\\n' "$q" | MYSQL_PWD="$rp" ${client} -N -B -r "$@" 2>&1 >&3); } 3>&1; }`,
    `after() { ap=$1; shift; [ -z "$follow" ] || printf '%s\\n' "$follow" | MYSQL_PWD="$ap" ${client} -N -B -r "$@" 2>/dev/null | MYSQL_PWD="$ap" ${client} --force "$@" >/dev/null 2>&1; exit 0; }`,
    "tried=",
    `for p in "$${rootPasswordVariable(engine)}" "$pw"; do`,
    '  [ -n "$p" ] && [ "$p" != "$tried" ] || continue',
    "  tried=$p",
    '  run "$p" -uroot && after "$p" -uroot',
    "  code=$?",
    `  [ -z "$err" ] || printf '%s\\n' "$err" >&2`,
    '  case "$err" in *"ERROR 1045"*) ;; *) exit "$code" ;; esac',
    "done",
    `[ "$1" = root ] || exit ${signInFailedCode}`,
    'run "$pw" -h127.0.0.1 -uroot && after "$pw" -h127.0.0.1 -uroot',
    "code=$?",
    `[ -z "$err" ] || printf '%s\\n' "$err" >&2`,
    `case "$err" in *"ERROR 1045"*) exit ${signInFailedCode} ;; esac`,
    'exit "$code"',
  ].join("\n");
}

function mysqlRootExec(engine: "mysql" | "mariadb", admin: { user: string; password: string }, sql: string, follow = ""): Exec {
  return { command: ["sh", "-c", mysqlRootScript(engine), "sh", admin.user], stdin: `${admin.password}\n${sql}\n${follow}\n` };
}

/**
 * Signs a user in over TCP (as clients and Seylo's tools do, so as
 * user@%) with the password on stdin and prints CURRENT_USER(): the proof
 * of a new main user, and the main user alone when root cannot sign in.
 */
function mysqlSelfScript(engine: "mysql" | "mariadb"): string {
  const client = mysqlClient(engine);
  return [
    "IFS= read -r pw || exit 2",
    `{ err=$(MYSQL_PWD="$pw" ${client} -h127.0.0.1 -u"$1" -N -B -r -e 'SELECT CURRENT_USER()' 2>&1 >&3); } 3>&1`,
    "code=$?",
    `[ -z "$err" ] || printf '%s\\n' "$err" >&2`,
    '[ "$code" -eq 0 ] && exit 0',
    `case "$err" in *"ERROR 1045"*) exit ${signInFailedCode} ;; esac`,
    'exit "$code"',
  ].join("\n");
}

/** Accounts no one signs in with, or that the image needs (MariaDB's healthcheck): never listed. */
export const mysqlHiddenAccounts = ["mysql.sys", "mysql.session", "mysql.infoschema", "mariadb.sys", "healthcheck", "PUBLIC"];

const mysqlPrivileges = [
  ["Select_priv", "select"],
  ["Insert_priv", "insert"],
  ["Update_priv", "update"],
  ["Delete_priv", "delete"],
  ["Create_priv", "create"],
  ["Drop_priv", "drop"],
  ["Alter_priv", "alter"],
  ["Index_priv", "index"],
  ["Create_routine_priv", "createRoutine"],
  ["Event_priv", "event"],
  ["Grant_priv", "grant"],
] as const;

function mysqlListSql(engine: "mysql" | "mariadb", database: string): string {
  const flags = (alias: string, extra: readonly (readonly [string, string])[] = []) =>
    `CONCAT_WS(',', ${[...mysqlPrivileges, ...extra].map(([column, name]) => `IF(${alias}.${column} = 'Y', '${name}', NULL)`).join(", ")})`;
  const definer = (table: string) => `(SELECT COUNT(*) FROM information_schema.${table} x WHERE x.DEFINER = CONCAT(u.User, '@', u.Host))`;
  const dbNames = [...new Set([database, database.replace(/[\\_%]/g, (c) => `\\${c}`)])].map(mysqlString).join(", ");
  const locked = engine === "mysql" ? "u.account_locked = 'Y'" : "IFNULL(JSON_VALUE(gp.Priv, '$.account_locked'), 'false') = 'true'";
  const join = engine === "mariadb" ? " LEFT JOIN mysql.global_priv gp ON gp.User = u.User AND gp.Host = u.Host" : "";
  const roles = engine === "mariadb" ? " AND u.is_role = 'N'" : "";
  return (
    `SELECT JSON_OBJECT('user', u.User, 'host', u.Host, 'locked', ${locked}, ` +
    `'global', ${flags("u", [
      ["Super_priv", "super"],
      ["Create_user_priv", "createUser"],
    ])}, ` +
    `'db', (SELECT ${flags("d")} FROM mysql.db d WHERE d.User = u.User AND d.Host = u.Host AND d.Db IN (${dbNames}) LIMIT 1), ` +
    `'definers', ${["VIEWS", "ROUTINES", "TRIGGERS", "EVENTS"].map(definer).join(" + ")}) ` +
    `FROM mysql.user u${join} WHERE u.User NOT IN (${mysqlHiddenAccounts.map(mysqlString).join(", ")})${roles} ` +
    `ORDER BY u.User, u.Host LIMIT ${maxUsers + 1};`
  );
}

function mysqlGrants(account: string, access: UserPreset, database: string): string[] {
  const on = `${mysqlGrantDatabase(database)}.*`;
  switch (access) {
    case "readOnly":
      return [`GRANT SELECT, SHOW VIEW ON ${on} TO ${account};`];
    case "readWrite":
      return [
        `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, TRIGGER ON ${on} TO ${account};`,
      ];
    case "databaseAdmin":
      return [`GRANT ALL PRIVILEGES ON ${on} TO ${account} WITH GRANT OPTION;`];
    case "serverAdmin":
      return [`GRANT ALL PRIVILEGES ON *.* TO ${account} WITH GRANT OPTION;`];
  }
}

/** Root's two accounts get the main user's password, as containerEnv gives it to root. */
const mysqlRootPassword = (password: string) =>
  ["'root'@'%'", "'root'@'localhost'"].map((a) => `ALTER USER IF EXISTS ${a} IDENTIFIED BY ${mysqlString(password)};`);

// MongoDB

/**
 * mongosh runs the script on stdin as one line, signed in as the main
 * user inside it (no password in argv, and never the container's
 * environment, which keeps the first password until the next deploy).
 * quit() at the end gives the exit code: mongosh reading stdin goes on
 * after an error and would exit 0.
 */
function mongoExec(admin: { user: string; password: string }, body: string): Exec {
  const script = [
    "let seyloCode = 0;",
    "try {",
    'const admin = db.getSiblingDB("admin");',
    `try { const a = admin.auth(${js(admin.user)}, ${js(admin.password)}); if (!a || a.ok !== 1) throw new Error("Authentication failed."); } catch (e) { seyloCode = ${signInFailedCode}; throw e; }`,
    body,
    '} catch (e) { if (seyloCode === 0) seyloCode = 3; print("seylo: " + e.message); }',
    "quit(seyloCode);",
  ].join(" ");
  return { command: ["mongosh", "--quiet", "--norc", "mongodb://127.0.0.1:27017/admin"], stdin: `${script}\n` };
}

const mongoListBody = `const r = admin.runCommand({ usersInfo: { forAllDBs: true } }); if (r.ok !== 1) throw new Error(r.errmsg || "usersInfo failed"); r.users.slice(0, ${maxUsers + 1}).forEach((u) => print(JSON.stringify({ kind: "user", user: u.user, db: u.db, roles: u.roles || [], mechanisms: u.mechanisms || [] })));`;

function mongoRoles(access: UserPreset, database: string): { role: string; db: string }[] {
  switch (access) {
    case "readOnly":
      return [{ role: "read", db: database }];
    case "readWrite":
      return [{ role: "readWrite", db: database }];
    case "databaseAdmin":
      return [{ role: "dbOwner", db: database }];
    case "serverAdmin":
      return [{ role: "root", db: "admin" }];
  }
}

// ClickHouse

/**
 * clickhouse-client as the container's user (CLICKHOUSE_USER, its password
 * in CLICKHOUSE_PASSWORD, which the client reads): the image writes that
 * user from the environment at every start, so the container's
 * environment is what the server has. The queries are on stdin; stdin's
 * first line (the stored password) is read and not used.
 */
const clickhouseScript = [
  "IFS= read -r _ || exit 2",
  '{ err=$(clickhouse-client --user="$CLICKHOUSE_USER" --multiquery 2>&1 >&3); } 3>&1',
  "code=$?",
  `[ -z "$err" ] || printf '%s\\n' "$err" >&2`,
  '[ "$code" -eq 0 ] && exit 0',
  `case "$err" in *AUTHENTICATION_FAILED*|*'Authentication failed'*|*REQUIRED_PASSWORD*) exit ${signInFailedCode} ;; esac`,
  'exit "$code"',
].join("\n");

const clickhouseExec = (sql: string): Exec => ({ command: ["sh", "-c", clickhouseScript], stdin: `-\n${sql}\n` });

const clickhouseListSql = [
  `SELECT 'user' AS kind, name, storage, toString(auth_type) AS auth FROM system.users ORDER BY name LIMIT ${maxUsers + 1} FORMAT JSONEachRow;`,
  "SELECT 'grant' AS kind, user_name, access_type, database, grant_option FROM system.grants WHERE user_name IS NOT NULL FORMAT JSONEachRow;",
].join("\n");

function clickhouseGrants(name: string, access: UserPreset, database: string): string[] {
  const on = `${chIdent(database)}.*`;
  const to = chIdent(name);
  switch (access) {
    case "readOnly":
      return [`GRANT SELECT, SHOW ON ${on} TO ${to};`];
    case "readWrite":
      return [
        `GRANT SELECT, INSERT, ALTER, CREATE TABLE, CREATE VIEW, CREATE DICTIONARY, DROP TABLE, DROP VIEW, TRUNCATE, OPTIMIZE, SHOW ON ${on} TO ${to};`,
      ];
    case "databaseAdmin":
      return [`GRANT ALL ON ${on} TO ${to} WITH GRANT OPTION;`];
    case "serverAdmin":
      // What the main user has: the image's user lacks a few of ALL (NAMED COLLECTION ADMIN), so ALL would be refused.
      return [`GRANT CURRENT GRANTS ON *.* TO ${to} WITH GRANT OPTION;`];
  }
}

// What each engine runs. admin is the stored main user; user names are
// the listed ones (name, host, auth database).

export interface Admin {
  user: string;
  password: string;
  database: string;
}

export interface Target {
  name: string;
  host: string;
  authDatabase: string;
}

type SqlEngine = "postgres" | "mysql" | "mariadb" | "mongo" | "clickhouse";

export function listExec(engine: SqlEngine, admin: Admin): Exec {
  switch (engine) {
    case "postgres":
      return postgresExec(admin, postgresListSql, false);
    case "mysql":
    case "mariadb":
      return mysqlRootExec(engine, admin, mysqlListSql(engine, admin.database));
    case "mongo":
      return mongoExec(admin, mongoListBody);
    case "clickhouse":
      return clickhouseExec(clickhouseListSql);
  }
}

/** MySQL and MariaDB when root cannot sign in: the main user signs itself in (and the proof of a new main user). */
export function mysqlSelfExec(engine: "mysql" | "mariadb", user: string, password: string): Exec {
  return { command: ["sh", "-c", mysqlSelfScript(engine), "sh", user], stdin: `${password}\n` };
}

export function createUserExec(
  engine: SqlEngine,
  admin: Admin,
  user: { name: string; host: string; access: UserPreset; password: string },
  options: ScriptOptions = {},
): Exec {
  switch (engine) {
    case "postgres": {
      const grants = postgresGrants(user.name, user.access, admin.database);
      const create = `CREATE ROLE ${pgIdent(user.name)} LOGIN PASSWORD ${pgLiteral(scramVerifier(user.password, options.salt))};`;
      return postgresExec(admin, [create, ...grants].join("\n"), true);
    }
    case "mysql":
    case "mariadb": {
      const account = mysqlAccount(user.name, user.host);
      const sql = [
        `CREATE USER ${account} IDENTIFIED BY ${mysqlString(user.password)};`,
        ...mysqlGrants(account, user.access, admin.database),
      ];
      return mysqlRootExec(engine, admin, sql.join(" "));
    }
    case "mongo":
      return mongoExec(
        admin,
        `admin.createUser({ user: ${js(user.name)}, pwd: ${js(user.password)}, roles: ${JSON.stringify(mongoRoles(user.access, admin.database))} }); print("created");`,
      );
    case "clickhouse":
      return clickhouseExec(
        [
          `CREATE USER ${chIdent(user.name)} IDENTIFIED WITH sha256_password BY ${chString(user.password)};`,
          ...clickhouseGrants(user.name, user.access, admin.database),
        ].join("\n"),
      );
  }
}

/** A user's new password, for any user but the main one (mainPasswordExec). */
export function setPasswordExec(engine: SqlEngine, admin: Admin, target: Target, password: string, options: ScriptOptions = {}): Exec {
  switch (engine) {
    case "postgres":
      return postgresExec(admin, `ALTER ROLE ${pgIdent(target.name)} PASSWORD ${pgLiteral(scramVerifier(password, options.salt))};`, true);
    case "mysql":
    case "mariadb":
      return mysqlRootExec(engine, admin, `ALTER USER ${mysqlAccount(target.name, target.host)} IDENTIFIED BY ${mysqlString(password)};`);
    case "mongo":
      return mongoExec(
        admin,
        `admin.getSiblingDB(${js(target.authDatabase)}).changeUserPassword(${js(target.name)}, ${js(password)}); print("changed");`,
      );
    case "clickhouse":
      return clickhouseExec(`ALTER USER ${chIdent(target.name)} IDENTIFIED WITH sha256_password BY ${chString(password)};`);
  }
}

/**
 * The main user's new password where it changes inside the running
 * database: Postgres and MongoDB signed in with the stored login (not the
 * container's first one), a SCRAM verifier for Postgres. MySQL, MariaDB
 * and the Redis-like engines keep changePasswordExec (engines.ts).
 */
export function mainPasswordExec(engine: "postgres" | "mongo", admin: Admin, password: string, options: ScriptOptions = {}): Exec {
  return setPasswordExec(engine, admin, { name: admin.user, host: "%", authDatabase: "admin" }, password, options);
}

/**
 * A rename. Postgres keeps ownership and grants (by oid); an md5 password
 * is cleared by Postgres, so password (when given) is set right after, in
 * the same transaction. The main user is the session user, which Postgres
 * will not rename: a temporary superuser without login takes the session
 * for the rename and is dropped again. MySQL and MariaDB may change the
 * host too. MongoDB has no rename: a new user with the same roles and the
 * new password, then the old one goes. ClickHouse users from SQL only.
 */
export function renameUserExec(
  engine: SqlEngine,
  admin: Admin,
  target: Target,
  to: { name: string; host: string; password: string | null },
  options: ScriptOptions = {},
): Exec {
  switch (engine) {
    case "postgres": {
      const rename = `ALTER ROLE ${pgIdent(target.name)} RENAME TO ${pgIdent(to.name)};`;
      const password = to.password
        ? [`ALTER ROLE ${pgIdent(to.name)} PASSWORD ${pgLiteral(scramVerifier(to.password, options.salt))};`]
        : [];
      if (target.name !== admin.user) return postgresExec(admin, [rename, ...password].join("\n"), true);
      const temp = pgIdent(`seylo_tmp_${options.suffix ?? randomSuffix()}`);
      return postgresExec(
        admin,
        [
          `CREATE ROLE ${temp} SUPERUSER NOLOGIN;`,
          `SET SESSION AUTHORIZATION ${temp};`,
          rename,
          "RESET SESSION AUTHORIZATION;",
          `DROP ROLE ${temp};`,
          ...password,
        ].join("\n"),
        true,
      );
    }
    case "mysql":
    case "mariadb": {
      const sql = [`RENAME USER ${mysqlAccount(target.name, target.host)} TO ${mysqlAccount(to.name, to.host)};`];
      if (to.password) sql.push(`ALTER USER ${mysqlAccount(to.name, to.host)} IDENTIFIED BY ${mysqlString(to.password)};`);
      return mysqlRootExec(engine, admin, sql.join(" "));
    }
    case "mongo":
      return mongoExec(
        admin,
        `const s = admin.getSiblingDB(${js(target.authDatabase)}); const u = s.getUser(${js(target.name)}); if (!u) throw new Error("no such user"); s.createUser({ user: ${js(to.name)}, pwd: ${js(to.password ?? "")}, roles: u.roles }); s.dropUser(${js(target.name)}); print("renamed");`,
      );
    case "clickhouse":
      return clickhouseExec(`ALTER USER ${chIdent(target.name)} RENAME TO ${chIdent(to.name)};`);
  }
}

/**
 * A delete. Postgres: in every database that takes connections, what the
 * user owns goes to the main user and DROP OWNED then removes only its
 * grants (no data: nothing is left that it owns); its sessions end; the
 * role goes. MySQL and MariaDB: DROP USER, then its sessions end (when no
 * other account has its name). Accounts own no data there, nor do MongoDB
 * and ClickHouse users.
 */
export function deleteUserExec(
  engine: SqlEngine,
  admin: Admin,
  target: Target,
  context: { databases?: readonly string[]; killSessions?: boolean } = {},
): Exec {
  switch (engine) {
    case "postgres": {
      const n = pgIdent(target.name);
      const each = (context.databases ?? [admin.database]).flatMap((db) => [
        `\\connect ${psqlArg(db)}`,
        `REASSIGN OWNED BY ${n} TO ${pgIdent(admin.user)};`,
        `DROP OWNED BY ${n};`,
      ]);
      return postgresExec(
        admin,
        [
          ...each,
          `SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = ${pgLiteral(target.name)};`,
          `DROP ROLE ${n};`,
        ].join("\n"),
        false,
      );
    }
    case "mysql":
    case "mariadb": {
      const kill = context.killSessions
        ? `SELECT CONCAT('KILL ', id, ';') FROM information_schema.PROCESSLIST WHERE USER = ${mysqlString(target.name)};`
        : "";
      return mysqlRootExec(engine, admin, `DROP USER ${mysqlAccount(target.name, target.host)};`, kill);
    }
    case "mongo":
      return mongoExec(admin, `admin.getSiblingDB(${js(target.authDatabase)}).dropUser(${js(target.name)}); print("deleted");`);
    case "clickhouse":
      return clickhouseExec(`DROP USER ${chIdent(target.name)};`);
  }
}

/**
 * The first step of a switch of the main user: a new user with full
 * rights, or an existing one with a new password (and full rights with
 * grantAdmin). The proof (proofExec) and root's password (MySQL) follow.
 */
export function switchPrepareExec(
  engine: "postgres" | "mysql" | "mariadb" | "mongo",
  admin: Admin,
  to: { name: string; password: string; existing: boolean; grantAdmin: boolean },
  options: ScriptOptions = {},
): Exec {
  switch (engine) {
    case "postgres": {
      const n = pgIdent(to.name);
      const verifier = pgLiteral(scramVerifier(to.password, options.salt));
      const sql = to.existing
        ? [`ALTER ROLE ${n} LOGIN PASSWORD ${verifier};`, ...(to.grantAdmin ? [`ALTER ROLE ${n} SUPERUSER CREATEDB CREATEROLE;`] : [])]
        : [`CREATE ROLE ${n} LOGIN SUPERUSER CREATEDB CREATEROLE PASSWORD ${verifier};`];
      return postgresExec(admin, sql.join("\n"), true);
    }
    case "mysql":
    case "mariadb": {
      const account = mysqlAccount(to.name, "%");
      const sql = to.existing
        ? [`ALTER USER ${account} IDENTIFIED BY ${mysqlString(to.password)};`]
        : [`CREATE USER ${account} IDENTIFIED BY ${mysqlString(to.password)};`];
      if (!to.existing || to.grantAdmin) sql.push(...mysqlGrants(account, "serverAdmin", admin.database));
      return mysqlRootExec(engine, admin, sql.join(" "));
    }
    case "mongo": {
      const roles = JSON.stringify(mongoRoles("serverAdmin", admin.database));
      const body = to.existing
        ? `admin.changeUserPassword(${js(to.name)}, ${js(to.password)});${to.grantAdmin ? ` admin.grantRolesToUser(${js(to.name)}, ${roles});` : ""} print("ready");`
        : `admin.createUser({ user: ${js(to.name)}, pwd: ${js(to.password)}, roles: ${roles} }); print("ready");`;
      return mongoExec(admin, body);
    }
  }
}

/**
 * Signs in as a user with a password the way Seylo's tools do and lists
 * the users: proof that it works as the main user before Seylo stores it
 * (switchMainUser, setUserPassword known). Postgres over the container's
 * own address, which the image checks passwords on (the socket and
 * 127.0.0.1 are trusted), so the password itself is tested; MySQL and
 * MariaDB over TCP; MongoDB by its own sign-in.
 */
export function proofExec(engine: "postgres" | "mysql" | "mariadb" | "mongo", user: Admin): Exec {
  switch (engine) {
    case "postgres":
      return {
        command: [
          "sh",
          "-c",
          [
            "IFS= read -r pw || exit 2",
            "host=$(hostname -i 2>/dev/null | cut -d' ' -f1)",
            '[ -n "$host" ] || host=127.0.0.1',
            '{ err=$(PGPASSWORD="$pw" psql -X -q -At -h "$host" "$@" -c "SELECT current_user" 2>&1 >&3); } 3>&1',
            "code=$?",
            `[ -z "$err" ] || printf '%s\\n' "$err" >&2`,
            '[ "$code" -eq 0 ] && exit 0',
            `case "$err" in *'password authentication failed'*|*'role "'*'" does not exist'*) exit ${signInFailedCode} ;; esac`,
            'exit "$code"',
          ].join("\n"),
          "sh",
          `--username=${user.user}`,
          `--dbname=${user.database || "postgres"}`,
        ],
        stdin: `${user.password}\n`,
      };
    case "mysql":
    case "mariadb":
      return mysqlSelfExec(engine, user.user, user.password);
    case "mongo":
      return mongoExec(user, `const s = admin.runCommand({ connectionStatus: 1 }); print(JSON.stringify(s.authInfo.authenticatedUsers));`);
  }
}

/** After a switch on MySQL and MariaDB: root gets the new main user's password, and the old main user may go. */
export function mysqlAfterSwitchExec(
  engine: "mysql" | "mariadb",
  admin: Admin,
  newPassword: string,
  drop: { name: string; host: string } | null,
): Exec {
  const sql = [
    ...mysqlRootPassword(newPassword),
    ...(drop ? [`DROP USER IF EXISTS ${mysqlAccount(drop.name, drop.host)};`] : []),
    "FLUSH PRIVILEGES;",
  ];
  return mysqlRootExec(engine, admin, sql.join(" "));
}

function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

// Parsing the list output: one JSON object a line; other lines (notices) are skipped.

function jsonLines(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    // mongosh reading stdin puts its prompt ("admin> ") before the first line it prints.
    const at = line.indexOf("{");
    if (at < 0) continue;
    const text = line.slice(at).trim();
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
    } catch {
      // A line that only looks like JSON (a notice): not a user.
    }
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : 0);
const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const strings = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);
const flagSet = (v: unknown) => new Set(str(v).split(",").filter(Boolean));

const user = (over: Partial<EngineUser> & { name: string }): EngineUser => ({
  host: null,
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
  ...over,
});

export function parseListing(engine: SqlEngine, stdout: string, database: string): Listing {
  const rows = jsonLines(stdout);
  switch (engine) {
    case "postgres":
      return parsePostgres(rows);
    case "mysql":
    case "mariadb":
      return { users: rows.map(parseMysqlRow), serverVersion: null, databases: [] };
    case "mongo":
      return { users: rows.filter((r) => r.kind === "user").map((r) => parseMongoRow(r, database)), serverVersion: null, databases: [] };
    case "clickhouse":
      return parseClickHouse(rows, database);
  }
}

function parsePostgres(rows: Record<string, unknown>[]): Listing {
  const server = rows.find((r) => r.kind === "server");
  const users = rows
    .filter((r) => r.kind === "user")
    .map((r) => {
      const memberOf = strings(r.memberOf);
      const member = new Set(memberOf);
      const superuser = truthy(r.super);
      const access: UserAccess = superuser
        ? "serverAdmin"
        : member.has("pg_read_all_data") && member.has("pg_write_all_data")
          ? "readWrite"
          : member.has("pg_read_all_data")
            ? "readOnly"
            : "custom";
      const kind = str(r.password);
      return user({
        name: str(r.name),
        access,
        roles: [
          ...(superuser ? ["SUPERUSER"] : []),
          ...(truthy(r.createrole) ? ["CREATEROLE"] : []),
          ...(truthy(r.createdb) ? ["CREATEDB"] : []),
          ...memberOf,
        ],
        locked: truthy(r.expired),
        fullRights: superuser,
        ownsObjects: num(r.owns),
        bootstrap: truthy(r.bootstrap),
        passwordKind: kind === "scram" || kind === "md5" || kind === "none" ? kind : "other",
      });
    });
  return { users, serverVersion: server ? num(server.version) : null, databases: server ? strings(server.databases) : [] };
}

function parseMysqlRow(r: Record<string, unknown>): EngineUser {
  const g = flagSet(r.global);
  const d = flagSet(r.db);
  const all = (set: Set<string>, ...names: string[]) => names.every((n) => set.has(n));
  const full = all(g, "select", "insert", "update", "delete", "create", "drop", "alter", "createUser");
  const access: UserAccess = full
    ? "serverAdmin"
    : all(d, "select", "insert", "update", "delete", "create", "drop", "alter") && (d.has("grant") || all(d, "createRoutine", "event"))
      ? "databaseAdmin"
      : all(d, "select", "insert", "update", "delete")
        ? "readWrite"
        : d.has("select")
          ? "readOnly"
          : g.size === 0 && d.size === 0
            ? "none"
            : "custom";
  const words = (set: Set<string>) => [...set].map((p) => p.replace(/[A-Z]/g, (c) => ` ${c}`).toUpperCase()).join(", ");
  const roles = [...(g.size ? [`*.*: ${words(g)}`] : []), ...(d.size ? [`this database: ${words(d)}`] : [])];
  return user({
    name: str(r.user),
    host: str(r.host),
    access,
    roles,
    locked: truthy(r.locked),
    fullRights: full,
    definerObjects: num(r.definers),
  });
}

function parseMongoRow(r: Record<string, unknown>, database: string): EngineUser {
  const roles = (Array.isArray(r.roles) ? r.roles : []).map((x) => {
    const role = x as { role?: unknown; db?: unknown };
    return { role: str(role.role), db: str(role.db) };
  });
  const has = (role: string, db: string) => roles.some((x) => x.role === role && x.db === db);
  const root = has("root", "admin");
  const access: UserAccess = root
    ? "serverAdmin"
    : has("dbOwner", database)
      ? "databaseAdmin"
      : has("readWrite", database) || has("readWriteAnyDatabase", "admin")
        ? "readWrite"
        : has("read", database) || has("readAnyDatabase", "admin")
          ? "readOnly"
          : roles.length === 0
            ? "none"
            : "custom";
  return user({
    name: str(r.user),
    authDatabase: str(r.db) || "admin",
    access,
    roles: roles.map((x) => `${x.role}@${x.db}`),
    fullRights: root,
  });
}

function parseClickHouse(rows: Record<string, unknown>[], database: string): Listing {
  const grants = rows.filter((r) => r.kind === "grant");
  const users = rows
    .filter((r) => r.kind === "user")
    .map((r) => {
      const name = str(r.name);
      const mine = grants.filter((g) => str(g.user_name) === name);
      const on = (db: string | null) =>
        new Set(mine.filter((g) => (db === null ? g.database == null : str(g.database) === db)).map((g) => str(g.access_type)));
      const global = on(null);
      const local = on(database);
      const storage = str(r.storage);
      // ClickHouse lists ALL as the privileges it stands for: full rights on the server include managing users.
      const full =
        storage === "users_xml" ||
        global.has("ALL") ||
        (global.has("SELECT") && global.has("INSERT") && (global.has("ACCESS MANAGEMENT") || global.has("CREATE USER")));
      const access: UserAccess = full
        ? "serverAdmin"
        : local.has("ALL") || (local.has("SELECT") && local.has("INSERT") && local.has("DROP DATABASE"))
          ? "databaseAdmin"
          : local.has("SELECT") && local.has("INSERT")
            ? "readWrite"
            : local.has("SELECT")
              ? "readOnly"
              : mine.length === 0
                ? "none"
                : "custom";
      // One line per database, the privileges named while they are few.
      const roles = [...new Set(mine.map((g) => (g.database == null ? "*" : str(g.database))))].map((db) => {
        const these = mine.filter((g) => (g.database == null ? "*" : str(g.database)) === db);
        const names = these.length > 12 ? `${these.length} privileges` : these.map((g) => str(g.access_type)).join(", ");
        return `${db}.*: ${names}${these.every((g) => truthy(g.grant_option)) ? ", with grant option" : ""}`;
      });
      return user({ name, access, roles, fullRights: full, storage });
    });
  return { users, serverVersion: null, databases: [] };
}

/** The engines whose users the Users tab lists from the engine; the Redis-like ones have only "default". */
export function isSqlEngine(engine: DatabaseEngine): engine is SqlEngine {
  return engine === "postgres" || engine === "mysql" || engine === "mariadb" || engine === "mongo" || engine === "clickhouse";
}

/**
 * Takes secrets out of an engine's message before it is shown: a failing
 * MySQL statement can echo the text near the error, password included.
 * Nothing of an engine's output is logged or audited.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.replaceAll(secret, "[redacted]");
  return out;
}
