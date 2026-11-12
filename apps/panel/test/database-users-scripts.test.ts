// The Users tab's scripts (user-scripts.ts) without a database: the
// quoting helpers, the SCRAM verifier against RFC 7677, the statements of
// each access preset, the parsers with odd names, and the sign-in scripts
// run under sh and dash (MySQL's image has bash as /bin/sh, MariaDB's
// dash) against fake clients in a temp folder that record their arguments,
// environment and stdin. MongoDB's script is JavaScript: it runs here
// against a fake db. The real images run them in the VM
// (database-users-vm.test.ts).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerEnv, rootPasswordVariable } from "../src/modules/databases/engines";
import {
  type Admin,
  chIdent,
  chString,
  createUserExec,
  deleteUserExec,
  type Exec,
  listExec,
  mainPasswordExec,
  manageableName,
  mysqlAccount,
  mysqlGrantDatabase,
  mysqlIdent,
  mysqlSelfExec,
  mysqlString,
  parseListing,
  pgIdent,
  pgLiteral,
  proofExec,
  renameUserExec,
  scramVerifier,
  scrub,
  setPasswordExec,
  signInFailedCode,
  switchPrepareExec,
} from "../src/modules/databases/user-scripts";

const shells = ["sh", "dash"];
const admin: Admin = { user: "shop", password: "StoredPassword01", database: "shop_db" };
const secret = /StoredPassword01|NewPassword0002|EnvPassword00003/;

// Quoting: the engine's own unquoting gives the name back.

const odd = ["plain", "it's", 'say "hi"', "back\\slash", "per%cent_and_under", "naïve ünïcode", "`tick`", "a'b\"c\\d`e"];

const unquote = {
  pg: (q: string) => q.slice(1, -1).replaceAll('""', '"'),
  pgLiteral: (q: string) => q.slice(1, -1).replaceAll("''", "'"),
  mysql: (q: string) => q.slice(1, -1).replace(/\\(.)/g, "$1"),
  mysqlIdent: (q: string) => q.slice(1, -1).replaceAll("``", "`"),
  ch: (q: string) => q.slice(1, -1).replace(/\\(.)/g, "$1"),
};

describe("quoting", () => {
  test("every helper gives the name back and never ends the quote early", () => {
    for (const name of odd) {
      expect(unquote.pg(pgIdent(name))).toBe(name);
      expect(pgIdent(name).slice(1, -1)).not.toMatch(/(^|[^"])"([^"]|$)/);
      expect(unquote.pgLiteral(pgLiteral(name))).toBe(name);
      expect(unquote.mysql(mysqlString(name))).toBe(name);
      expect(mysqlString(name).slice(1, -1)).not.toMatch(/(^|[^\\])'/);
      expect(unquote.mysqlIdent(mysqlIdent(name))).toBe(name);
      expect(unquote.ch(chIdent(name))).toBe(name);
      expect(unquote.ch(chString(name))).toBe(name);
    }
    expect(mysqlAccount("app", "10.0.%")).toBe("'app'@'10.0.%'");
  });

  test("a MySQL grant on shop_db does not also cover shopXdb", () => {
    expect(mysqlGrantDatabase("shop_db")).toBe("`shop\\_db`");
    expect(mysqlGrantDatabase("100%")).toBe("`100\\%`");
  });

  test("names with control characters or backslashes are listed but not acted on", () => {
    expect(manageableName("app_user")).toBe(true);
    expect(manageableName("it's")).toBe(true);
    expect(manageableName("new\nline")).toBe(false);
    expect(manageableName("back\\slash")).toBe(false);
    expect(manageableName("")).toBe(false);
  });

  test("scrub takes passwords out of an engine's message", () => {
    expect(scrub("near 'IDENTIFIED BY 'NewPassword0002'' at line 1", ["NewPassword0002", ""])).toBe(
      "near 'IDENTIFIED BY '[redacted]'' at line 1",
    );
  });
});

describe("SCRAM-SHA-256 verifier", () => {
  test("signs in the RFC 7677 exchange", () => {
    // RFC 7677 section 3: user "user", password "pencil".
    const salt = Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64");
    const verifier = scramVerifier("pencil", salt, 4096);
    const match = /^SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)$/.exec(verifier);
    expect(match?.[1]).toBe("W22ZaJ0SNY7soEsUEjb6gQ==");
    const storedKey = Buffer.from(match?.[2] ?? "", "base64");
    const serverKey = Buffer.from(match?.[3] ?? "", "base64");
    const nonce = "rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const authMessage = `n=user,r=rOprNGfwEbeRWgbNEkqO,r=${nonce},s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=${nonce}`;
    // The server's signature the RFC's client checks.
    expect(createHmac("sha256", serverKey).update(authMessage).digest("base64")).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
    // The RFC's client proof, checked the way the server does: ClientKey = proof XOR signature, H(ClientKey) = StoredKey.
    const signature = createHmac("sha256", storedKey).update(authMessage).digest();
    const proof = Buffer.from("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=", "base64");
    const clientKey = Buffer.from(proof.map((b, i) => b ^ (signature[i] ?? 0)));
    expect(createHash("sha256").update(clientKey).digest().equals(storedKey)).toBe(true);
  });

  test("a new salt each time, so two users with one password store different verifiers", () => {
    expect(scramVerifier("SamePassword123")).not.toBe(scramVerifier("SamePassword123"));
  });
});

describe("statements", () => {
  const sqlOf = (exec: Exec) => exec.stdin.split("\n").slice(1).join("\n");

  test("Postgres: each preset's grants, a verifier instead of the password, one transaction", () => {
    const make = (access: "readOnly" | "readWrite" | "serverAdmin") =>
      createUserExec("postgres", admin, { name: "app", host: "%", access, password: "NewPassword0002" });
    expect(sqlOf(make("readOnly"))).toContain('GRANT pg_read_all_data TO "app";');
    expect(sqlOf(make("readOnly"))).not.toContain("pg_write_all_data");
    expect(sqlOf(make("readWrite"))).toContain('GRANT pg_read_all_data, pg_write_all_data TO "app";');
    expect(sqlOf(make("readWrite"))).toContain('GRANT USAGE, CREATE ON SCHEMA public TO "app";');
    expect(sqlOf(make("serverAdmin"))).toContain('ALTER ROLE "app" SUPERUSER CREATEDB CREATEROLE;');
    for (const access of ["readOnly", "readWrite", "serverAdmin"] as const) {
      const exec = make(access);
      expect(exec.stdin.split("\n")[0]).toBe(admin.password);
      expect(sqlOf(exec)).toMatch(/CREATE ROLE "app" LOGIN PASSWORD 'SCRAM-SHA-256\$4096:/);
      expect(exec.stdin).not.toContain("NewPassword0002");
      expect(exec.command).toContain("--single-transaction");
    }
    expect(() => createUserExec("postgres", admin, { name: "app", host: "%", access: "databaseAdmin", password: "x" })).toThrow();
  });

  test("MySQL: grants on the escaped database, the host, root's two accounts after a switch", () => {
    const exec = (access: "readOnly" | "readWrite" | "databaseAdmin" | "serverAdmin") =>
      createUserExec("mysql", admin, { name: "app", host: "10.0.%", access, password: "NewPassword0002" });
    expect(exec("readOnly").stdin).toContain("GRANT SELECT, SHOW VIEW ON `shop\\_db`.* TO 'app'@'10.0.%';");
    expect(exec("readWrite").stdin).toContain("TRIGGER ON `shop\\_db`.* TO 'app'@'10.0.%';");
    expect(exec("databaseAdmin").stdin).toContain("GRANT ALL PRIVILEGES ON `shop\\_db`.* TO 'app'@'10.0.%' WITH GRANT OPTION;");
    expect(exec("serverAdmin").stdin).toContain("GRANT ALL PRIVILEGES ON *.* TO 'app'@'10.0.%' WITH GRANT OPTION;");
    expect(exec("readOnly").stdin).toContain("CREATE USER 'app'@'10.0.%' IDENTIFIED BY 'NewPassword0002';");
    const rename = renameUserExec(
      "mariadb",
      admin,
      { name: "app", host: "%", authDatabase: "admin" },
      { name: "app2", host: "10.%", password: null },
    );
    expect(rename.stdin).toContain("RENAME USER 'app'@'%' TO 'app2'@'10.%';");
    const del = deleteUserExec("mysql", admin, { name: "app", host: "%", authDatabase: "admin" }, { killSessions: true });
    const [, statement, follow] = del.stdin.split("\n");
    expect(statement).toBe("DROP USER 'app'@'%';");
    expect(follow).toContain("information_schema.PROCESSLIST WHERE USER = 'app'");
  });

  test("MongoDB and ClickHouse: roles and grants per preset", () => {
    const mongo = (access: "readOnly" | "readWrite" | "databaseAdmin" | "serverAdmin") =>
      createUserExec("mongo", admin, { name: "app", host: "%", access, password: "NewPassword0002" }).stdin;
    expect(mongo("readOnly")).toContain('[{"role":"read","db":"shop_db"}]');
    expect(mongo("readWrite")).toContain('[{"role":"readWrite","db":"shop_db"}]');
    expect(mongo("databaseAdmin")).toContain('[{"role":"dbOwner","db":"shop_db"}]');
    expect(mongo("serverAdmin")).toContain('[{"role":"root","db":"admin"}]');
    const ch = (access: "readOnly" | "readWrite" | "databaseAdmin" | "serverAdmin") =>
      createUserExec("clickhouse", admin, { name: "app", host: "%", access, password: "NewPassword0002" }).stdin;
    expect(ch("readOnly")).toContain("GRANT SELECT, SHOW ON `shop_db`.* TO `app`;");
    expect(ch("databaseAdmin")).toContain("GRANT ALL ON `shop_db`.* TO `app` WITH GRANT OPTION;");
    expect(ch("serverAdmin")).toContain("GRANT CURRENT GRANTS ON *.* TO `app` WITH GRANT OPTION;");
    expect(ch("readOnly")).toContain("CREATE USER `app` IDENTIFIED WITH sha256_password BY 'NewPassword0002';");
  });

  test("the Postgres main user's rename goes through a temporary role that takes the session", () => {
    const exec = renameUserExec(
      "postgres",
      admin,
      { name: "shop", host: "%", authDatabase: "admin" },
      { name: "boss", host: "%", password: null },
      { suffix: "abc" },
    );
    expect(exec.stdin.split("\n").slice(1, 6)).toEqual([
      'CREATE ROLE "seylo_tmp_abc" SUPERUSER NOLOGIN;',
      'SET SESSION AUTHORIZATION "seylo_tmp_abc";',
      'ALTER ROLE "shop" RENAME TO "boss";',
      "RESET SESSION AUTHORIZATION;",
      'DROP ROLE "seylo_tmp_abc";',
    ]);
    // Another user's rename is plain, with the password right after when one is set (an md5 one is cleared).
    const other = renameUserExec(
      "postgres",
      admin,
      { name: "app", host: "%", authDatabase: "admin" },
      { name: "app2", host: "%", password: "NewPassword0002" },
    );
    expect(other.stdin).toContain('ALTER ROLE "app" RENAME TO "app2";\nALTER ROLE "app2" PASSWORD \'SCRAM-SHA-256$');
    expect(other.stdin).not.toContain("SESSION AUTHORIZATION");
  });

  test("a Postgres delete gives what the user owns to the main user in every database first", () => {
    const exec = deleteUserExec("postgres", admin, { name: "app", host: "%", authDatabase: "admin" }, { databases: ["shop_db", "it's"] });
    expect(exec.stdin.split("\n").slice(1)).toEqual([
      "\\connect 'shop_db'",
      'REASSIGN OWNED BY "app" TO "shop";',
      'DROP OWNED BY "app";',
      "\\connect 'it''s'",
      'REASSIGN OWNED BY "app" TO "shop";',
      'DROP OWNED BY "app";',
      "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename = 'app';",
      'DROP ROLE "app";',
      "",
    ]);
  });
});

describe("parsers", () => {
  test("Postgres: access from memberships, the bootstrap role, md5 passwords, odd names", () => {
    const out = [
      '{"kind" : "server", "version" : 170006, "databases" : ["postgres", "shop_db", "template1"]}',
      '{"kind" : "user", "name" : "shop", "bootstrap" : true, "super" : true, "createrole" : true, "createdb" : true, "expired" : false, "password" : "scram", "memberOf" : [], "owns" : 4}',
      '{"kind" : "user", "name" : "say \\"hi\\"", "bootstrap" : false, "super" : false, "createrole" : false, "createdb" : false, "expired" : true, "password" : "md5", "memberOf" : ["pg_read_all_data"], "owns" : 0}',
      '{"kind" : "user", "name" : "rw", "bootstrap" : false, "super" : false, "createrole" : false, "createdb" : false, "expired" : false, "password" : "scram", "memberOf" : ["pg_read_all_data", "pg_write_all_data"], "owns" : 2}',
      '{"kind" : "user", "name" : "x", "bootstrap" : false, "super" : false, "createrole" : false, "createdb" : false, "expired" : false, "password" : "none", "memberOf" : [], "owns" : 0}',
      "NOTICE:  not json",
    ].join("\n");
    const listing = parseListing("postgres", out, "shop_db");
    expect(listing.serverVersion).toBe(170006);
    expect(listing.databases).toEqual(["postgres", "shop_db", "template1"]);
    expect(listing.users.map((u) => [u.name, u.access, u.passwordKind, u.locked, u.ownsObjects])).toEqual([
      ["shop", "serverAdmin", "scram", false, 4],
      ['say "hi"', "readOnly", "md5", true, 0],
      ["rw", "readWrite", "scram", false, 2],
      ["x", "custom", "none", false, 0],
    ]);
    expect(listing.users[0]).toMatchObject({ bootstrap: true, fullRights: true, roles: ["SUPERUSER", "CREATEROLE", "CREATEDB"] });
  });

  test("MySQL: access from global and database rights, hosts, definers", () => {
    const out = [
      '{"user": "root", "host": "localhost", "locked": 0, "global": "select,insert,update,delete,create,drop,alter,index,createRoutine,event,grant,super,createUser", "db": null, "definers": 0}',
      '{"user": "shop", "host": "%", "locked": 0, "global": "", "db": "select,insert,update,delete,create,drop,alter,index,createRoutine,event", "definers": 3}',
      '{"user": "it\'s", "host": "10.0.%", "locked": 1, "global": "", "db": "select", "definers": 0}',
      '{"user": "w", "host": "%", "locked": 0, "global": "", "db": "select,insert,update,delete,create,drop,alter,index", "definers": 0}',
      '{"user": "none", "host": "%", "locked": 0, "global": "", "db": null, "definers": 0}',
    ].join("\n");
    const listing = parseListing("mysql", out, "shop_db");
    expect(listing.users.map((u) => [u.name, u.host, u.access, u.locked, u.definerObjects])).toEqual([
      ["root", "localhost", "serverAdmin", false, 0],
      ["shop", "%", "databaseAdmin", false, 3],
      ["it's", "10.0.%", "readOnly", true, 0],
      ["w", "%", "readWrite", false, 0],
      ["none", "%", "none", false, 0],
    ]);
  });

  test("MongoDB: the prompt before the first line, roles on this database, other auth databases", () => {
    const out = [
      'admin> {"kind":"user","user":"root","db":"admin","roles":[{"role":"root","db":"admin"}],"mechanisms":["SCRAM-SHA-256"]}',
      '{"kind":"user","user":"app","db":"shop_db","roles":[{"role":"readWrite","db":"shop_db"}],"mechanisms":["SCRAM-SHA-256"]}',
      '{"kind":"user","user":"other","db":"admin","roles":[{"role":"read","db":"elsewhere"}],"mechanisms":[]}',
    ].join("\n");
    const listing = parseListing("mongo", out, "shop_db");
    expect(listing.users.map((u) => [u.name, u.authDatabase, u.access, u.fullRights])).toEqual([
      ["root", "admin", "serverAdmin", true],
      ["app", "shop_db", "readWrite", false],
      ["other", "admin", "custom", false],
    ]);
    expect(listing.users[1]?.roles).toEqual(["readWrite@shop_db"]);
  });
});

/** A folder with fake clients that record their arguments, environment and stdin, and answer as told. */
function fakeBin() {
  const dir = mkdtempSync(join(tmpdir(), "fake-db-users-"));
  const record = (name: string, envName: string) =>
    [`printf '%s\\t%s\\t%s\\n' "${name}" "$${envName}" "$*" >> "$d/calls.log"`, `cat >> "$d/${name}.stdin"`].join("\n");
  const write = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\nd='${dir}'\n${body}\n`, { mode: 0o755 });
  write(
    "psql",
    [
      record("psql", "PGPASSWORD"),
      'case "$FAKE" in',
      `  auth) echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  password authentication failed for user "shop"' >&2; exit 2 ;;`,
      `  norole) echo 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "shop" does not exist' >&2; exit 2 ;;`,
      `  sql) echo 'psql:<stdin>:1: ERROR:  role "app" does not exist' >&2; exit 3 ;;`,
      "esac",
      '[ -f "$d/out" ] && cat "$d/out"',
      "exit 0",
    ].join("\n"),
  );
  write("hostname", 'echo "172.18.0.5 fd00::5"');
  // mysql and mariadb: accounts as files acct/<user>@<host> holding the password (user@localhost on the socket, else user@%).
  for (const client of ["mysql", "mariadb"])
    write(
      client,
      [
        `printf '%s\\t%s\\t%s\\n' "${client}" "$MYSQL_PWD" "$*" >> "$d/calls.log"`,
        "user=; host=localhost",
        'for a in "$@"; do case "$a" in -u*) user=${a#-u} ;; -h*) host=${a#-h} ;; esac; done',
        `[ "$FAKE" = down ] && { echo "ERROR 2002 (HY000): Can't connect to local server through socket" >&2; exit 1; }`,
        "acct=$user@%",
        '[ "$host" = localhost ] && [ -f "$d/acct/$user@localhost" ] && acct=$user@localhost',
        `{ [ -f "$d/acct/$acct" ] && [ "$MYSQL_PWD" = "$(cat "$d/acct/$acct")" ]; } || { echo "ERROR 1045 (28000): Access denied for user '$user'@'$host' (using password: YES)" >&2; exit 1; }`,
        `sql=$(cat); printf '%s\\n' "$sql" >> "$d/${client}.stdin"`,
        `case "$sql" in *FAILME*) echo "ERROR 1064 (42000): You have an error in your SQL syntax near 'FAILME'" >&2; exit 1 ;; esac`,
        `case "$sql" in *PROCESSLIST*) echo 'KILL 7;' ;; esac`,
        '[ -f "$d/out" ] && case "$sql" in *JSON_OBJECT*|*CURRENT_USER*) cat "$d/out" ;; esac',
        "exit 0",
      ].join("\n"),
    );
  write(
    "clickhouse-client",
    [
      record("clickhouse-client", "CLICKHOUSE_PASSWORD"),
      `[ "$FAKE" = auth ] && { echo 'Code: 516. DB::Exception: ch_admin: Authentication failed: password is incorrect, or there is no user with such name. (AUTHENTICATION_FAILED)' >&2; exit 4; }`,
      '[ -f "$d/out" ] && cat "$d/out"',
      "exit 0",
    ].join("\n"),
  );
  return {
    dir,
    out: (text: string) => writeFileSync(join(dir, "out"), text),
    accounts: (accounts: Record<string, string>) => {
      Bun.spawnSync(["mkdir", "-p", join(dir, "acct")]);
      for (const [a, p] of Object.entries(accounts)) writeFileSync(join(dir, "acct", a), p);
    },
    run(exec: Exec, shell: string, env: Record<string, string> = {}) {
      const command = exec.command[0] === "sh" ? [shell, ...exec.command.slice(1)] : exec.command;
      const r = Bun.spawnSync(command, { stdin: new TextEncoder().encode(exec.stdin), env: { PATH: `${dir}:/usr/bin:/bin`, ...env } });
      const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
      const calls = read("calls.log")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [client, password, args] = line.split("\t");
          return { client, password, args };
        });
      const clients = ["psql", "mysql", "mariadb", "clickhouse-client"];
      const inputs = Object.fromEntries(clients.map((c) => [c, read(`${c}.stdin`)]));
      const stdin = (client: string) => inputs[client] ?? "";
      const out = { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString(), calls, stdin };
      for (const name of ["calls.log", ...clients.map((c) => `${c}.stdin`)]) rmSync(join(dir, name), { force: true });
      // No password is ever an argument: of the script or of a client.
      for (const word of [...exec.command, ...calls.map((c) => c.args ?? "")]) expect(word).not.toMatch(secret);
      return out;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

for (const shell of shells) {
  describe(`scripts under ${shell}`, () => {
    let bin: ReturnType<typeof fakeBin>;
    beforeEach(() => {
      bin = fakeBin();
    });
    afterEach(() => bin.close());

    test("Postgres: the stored password signs in, only the SQL reaches psql, sign-in failures exit signInFailedCode", () => {
      bin.out('{"kind" : "user", "name" : "shop"}\n');
      const exec = listExec("postgres", admin);
      const r = bin.run(exec, shell);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('{"kind" : "user", "name" : "shop"}\n');
      expect(r.calls).toEqual([
        { client: "psql", password: admin.password, args: "-X -q -At -v ON_ERROR_STOP=1 --username=shop --dbname=shop_db" },
      ]);
      expect(r.stdin("psql")).toBe(exec.stdin.slice(admin.password.length + 1));
      expect(r.stdin("psql")).not.toContain(admin.password);
      for (const fake of ["auth", "norole"]) expect(bin.run(exec, shell, { FAKE: fake }).code).toBe(signInFailedCode);
      // A statement's error about a role is not a sign-in failure.
      const sql = bin.run(setPasswordExec("postgres", admin, { name: "app", host: "%", authDatabase: "admin" }, "NewPassword0002"), shell, {
        FAKE: "sql",
      });
      expect(sql.code).toBe(3);
      expect(sql.stderr).toContain('ERROR:  role "app" does not exist');
    });

    test("Postgres: the main user's password as a verifier, the single transaction; the proof over the container's address", () => {
      const r = bin.run(mainPasswordExec("postgres", admin, "NewPassword0002"), shell);
      expect(r.code).toBe(0);
      expect(r.calls[0]?.args).toContain("--single-transaction");
      expect(r.stdin("psql")).toMatch(/^ALTER ROLE "shop" PASSWORD 'SCRAM-SHA-256\$4096:[^']+';\n$/);
      const proof = bin.run(proofExec("postgres", { ...admin, password: "NewPassword0002" }), shell);
      expect(proof.code).toBe(0);
      expect(proof.calls).toEqual([
        {
          client: "psql",
          password: "NewPassword0002",
          args: "-X -q -At -h 172.18.0.5 --username=shop --dbname=shop_db -c SELECT current_user",
        },
      ]);
      expect(bin.run(proofExec("postgres", admin), shell, { FAKE: "auth" }).code).toBe(signInFailedCode);
    });

    for (const engine of ["mysql", "mariadb"] as const) {
      const env = (rootPassword: string) => ({ [rootPasswordVariable(engine)]: rootPassword });

      test(`${engine}: root with the container's password first, then the main user's, and the follow-up statements with --force`, () => {
        bin.accounts({ "root@localhost": "StoredPassword01", "root@%": "StoredPassword01", "shop@%": "StoredPassword01" });
        bin.out('{"user": "shop"}\n');
        // The container still has the first password: root signs in with the stored one on the second try.
        const list = bin.run(listExec(engine, admin), shell, env("EnvPassword00003"));
        expect(list.code).toBe(0);
        expect(list.stdout).toBe('{"user": "shop"}\n');
        expect(list.calls.map((c) => [c.password, c.args])).toEqual([
          ["EnvPassword00003", "-N -B -r -uroot"],
          ["StoredPassword01", "-N -B -r -uroot"],
        ]);
        expect(list.stdin(engine)).toContain("SELECT JSON_OBJECT(");
        expect(list.stdin(engine)).not.toContain(admin.password);
        const del = bin.run(
          deleteUserExec(engine, admin, { name: "app", host: "%", authDatabase: "admin" }, { killSessions: true }),
          shell,
          env("StoredPassword01"),
        );
        expect(del.code).toBe(0);
        // The DROP, then the KILL statements piped from one client into the next (they start together).
        expect(del.calls[0]?.args).toBe("-N -B -r -uroot");
        expect(
          del.calls
            .slice(1)
            .map((c) => c.args)
            .sort(),
        ).toEqual(["--force -uroot", "-N -B -r -uroot"]);
        expect(del.stdin(engine)).toContain("DROP USER 'app'@'%';");
        expect(del.stdin(engine)).toContain("KILL 7;");
      });

      test(`${engine}: nothing signs in as root: signInFailedCode, or root over TCP when root is the main user`, () => {
        bin.accounts({ "root@localhost": "OtherPassword999", "root@%": "StoredPassword01", "shop@%": "StoredPassword01" });
        const r = bin.run(listExec(engine, admin), shell, env("EnvPassword00003"));
        expect(r.code).toBe(signInFailedCode);
        expect(r.calls).toHaveLength(2);
        const root = bin.run(listExec(engine, { ...admin, user: "root" }), shell, env("EnvPassword00003"));
        expect(root.code).toBe(0);
        expect(root.calls.at(-1)?.args).toBe("-N -B -r -h127.0.0.1 -uroot");
        // The main user alone signs in over TCP (the list then shows only it).
        expect(bin.run(mysqlSelfExec(engine, "shop", "StoredPassword01"), shell).code).toBe(0);
        expect(bin.run(mysqlSelfExec(engine, "shop", "WrongPassword01"), shell).code).toBe(signInFailedCode);
      });

      test(`${engine}: a failing statement or a server that is down is the result, after one try`, () => {
        bin.accounts({ "root@localhost": "StoredPassword01" });
        const failing = { ...createUserExec(engine, admin, { name: "app", host: "%", access: "readOnly", password: "NewPassword0002" }) };
        failing.stdin = failing.stdin.replace("CREATE USER", "FAILME CREATE USER");
        const r = bin.run(failing, shell, env("StoredPassword01"));
        expect(r.code).toBe(1);
        expect(r.calls).toHaveLength(1);
        const down = bin.run(listExec(engine, admin), shell, { ...env("StoredPassword01"), FAKE: "down" });
        expect(down.code).toBe(1);
        expect(down.calls).toHaveLength(1);
        expect(down.stderr).toContain("ERROR 2002");
      });
    }

    test("ClickHouse: the container's own user and password, the stored password line not passed on", () => {
      bin.out('{"kind":"user","name":"ch_admin","storage":"users_xml"}\n');
      const env = Object.fromEntries(
        containerEnv("clickhouse", { user: "ch_admin", password: "EnvPassword00003", database: "app" }).map((e) => [e.name, e.value]),
      );
      const exec = listExec("clickhouse", admin);
      const r = bin.run(exec, shell, env);
      expect(r.code).toBe(0);
      expect(r.calls).toEqual([{ client: "clickhouse-client", password: "EnvPassword00003", args: "--user=ch_admin --multiquery" }]);
      expect(r.stdin("clickhouse-client")).toBe(exec.stdin.slice(exec.stdin.indexOf("\n") + 1));
      expect(bin.run(exec, shell, { ...env, FAKE: "auth" }).code).toBe(signInFailedCode);
    });
  });
}

/** Runs mongosh's script (stdin) against a fake db: what it printed and the code it quit with. */
function runMongo(exec: Exec, users: Record<string, string>, fail: Partial<Record<string, string>> = {}) {
  const printed: string[] = [];
  const calls: string[] = [];
  let code: number | null = null;
  class Quit extends Error {}
  const database = (name: string): Record<string, unknown> => {
    const call =
      (method: string, result: unknown = true) =>
      (...args: unknown[]) => {
        calls.push(`${name}.${method}(${args.map((a) => JSON.stringify(a)).join(", ")})`);
        if (fail[method]) throw new Error(fail[method]);
        return result;
      };
    return {
      getSiblingDB: (other: string) => database(other),
      auth: (user: string, password: string) => {
        calls.push(`${name}.auth(${JSON.stringify(user)})`);
        if (users[user] !== password) throw new Error("Authentication failed.");
        return { ok: 1 };
      },
      runCommand: (command: Record<string, unknown>) => {
        calls.push(`${name}.runCommand(${Object.keys(command)[0]})`);
        if ("usersInfo" in command)
          return { ok: 1, users: Object.keys(users).map((user) => ({ user, db: "admin", roles: [{ role: "root", db: "admin" }] })) };
        return { ok: 1, authInfo: { authenticatedUsers: [{ user: "x", db: "admin" }] } };
      },
      createUser: call("createUser"),
      changeUserPassword: call("changeUserPassword"),
      dropUser: call("dropUser"),
      grantRolesToUser: call("grantRolesToUser"),
      getUser: call("getUser", { user: "app", roles: [{ role: "read", db: "shop_db" }] }),
    };
  };
  const quit = (n: number) => {
    code = n;
    throw new Quit();
  };
  try {
    new Function("db", "print", "quit", exec.stdin)(database("shop_db"), (s: string) => printed.push(s), quit);
  } catch (e) {
    if (!(e instanceof Quit)) throw e;
  }
  return { code: code as number | null, printed, calls };
}

describe("MongoDB's script", () => {
  const stored = { shop: admin.password };

  test("signs in with the stored login inside the script, never argv or the container's env", () => {
    const exec = listExec("mongo", admin);
    expect(exec.command).toEqual(["mongosh", "--quiet", "--norc", "mongodb://127.0.0.1:27017/admin"]);
    const r = runMongo(exec, stored);
    expect(r.code).toBe(0);
    expect(r.calls.slice(0, 2)).toEqual(['admin.auth("shop")', "admin.runCommand(usersInfo)"]);
    expect(JSON.parse(r.printed[0] ?? "{}")).toMatchObject({ kind: "user", user: "shop", db: "admin" });
  });

  test("a refused sign-in quits with signInFailedCode, any other error with 3, and nothing runs after it", () => {
    const wrong = runMongo(mainPasswordExec("mongo", { ...admin, password: "WrongPassword01" }, "NewPassword0002"), stored);
    expect(wrong.code).toBe(signInFailedCode);
    expect(wrong.calls).toEqual(['admin.auth("shop")']);
    const failed = runMongo(
      createUserExec("mongo", admin, { name: "app", host: "%", access: "readOnly", password: "NewPassword0002" }),
      stored,
      {
        createUser: "User already exists",
      },
    );
    expect(failed.code).toBe(3);
    expect(failed.printed).toEqual(["seylo: User already exists"]);
  });

  test("a second main password change signs in with the first one's password (the container still has the oldest)", () => {
    const first = mainPasswordExec("mongo", admin, "NewPassword0002");
    expect(runMongo(first, stored).calls).toContain('admin.changeUserPassword("shop", "NewPassword0002")');
    const second = mainPasswordExec("mongo", { ...admin, password: "NewPassword0002" }, "EnvPassword00003");
    expect(runMongo(second, { shop: "NewPassword0002" }).code).toBe(0);
  });

  test("rename makes a new user with the same roles, then drops the old one; a switch grants root to an existing user", () => {
    const rename = runMongo(
      renameUserExec(
        "mongo",
        admin,
        { name: "app", host: "%", authDatabase: "shop_db" },
        { name: "app2", host: "%", password: "NewPassword0002" },
      ),
      stored,
    );
    expect(rename.code).toBe(0);
    expect(rename.calls.slice(1)).toEqual([
      'shop_db.getUser("app")',
      'shop_db.createUser({"user":"app2","pwd":"NewPassword0002","roles":[{"role":"read","db":"shop_db"}]})',
      'shop_db.dropUser("app")',
    ]);
    const existing = runMongo(
      switchPrepareExec("mongo", admin, { name: "app", password: "NewPassword0002", existing: true, grantAdmin: true }),
      stored,
    );
    expect(existing.calls.slice(1)).toEqual([
      'admin.changeUserPassword("app", "NewPassword0002")',
      'admin.grantRolesToUser("app", [{"role":"root","db":"admin"}])',
    ]);
  });
});
