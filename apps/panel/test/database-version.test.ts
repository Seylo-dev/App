import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databases as dbOps, deployments as deploymentOps, services as serviceOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { backupRuns, type DatabaseEngine, deploymentLogs, deployments, nodes, serviceDatabases, services } from "../src/db/schema";
import {
  containerCommand,
  containerEnv,
  databaseSpec,
  type EngineVersion,
  engines,
  enginesCapability,
  engineVersions,
  withNativePassword,
} from "../src/modules/databases/engines";
import {
  compareVersions,
  customImage,
  imageRelease,
  judgeVersion,
  lineOfImage,
  mongoFcvExec,
  mysqlNativeUsersExec,
  nativePasswordPlan,
  nativePasswordRefusal,
  type VersionPoint,
} from "../src/modules/databases/version";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { serviceSpecFor } from "../src/modules/services/desired";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, settleDeploys } from "./seed-helpers";

/** A catalog line as a VersionPoint. */
function point(engine: DatabaseEngine, version: string, variant: string | null = null): VersionPoint {
  const line = engineVersions(engine, variant)?.find((v) => v.version === version);
  if (!line) throw new Error(`${engine} ${version} is not in the catalog`);
  return line;
}
const lines = (engine: DatabaseEngine, variant: string | null = null) => (engineVersions(engine, variant) ?? []).map((v) => v.version);
const judge = (engine: DatabaseEngine, from: string, to: string, variant: string | null = null) =>
  judgeVersion(engine, point(engine, from, variant), point(engine, to, variant), lines(engine, variant));

describe("version rules", () => {
  test("every engine: an older catalog line is refused, the same image is current, a newer pinned image is a patch", () => {
    for (const engine of Object.keys(engines) as DatabaseEngine[]) {
      for (const variant of [null, ...engines[engine].variants.map((v) => v.id)]) {
        const catalog = engineVersions(engine, variant) ?? [];
        for (const [i, newer] of catalog.entries()) {
          for (const older of catalog.slice(i + 1)) {
            expect({ engine, variant, j: judgeVersion(engine, newer, older, lines(engine, variant)) }).toMatchObject({
              j: { kind: "downgrade", allowed: false, reason: "downgrade" },
            });
          }
          expect(judgeVersion(engine, newer, newer, lines(engine, variant))).toMatchObject({
            kind: "current",
            allowed: false,
            reason: "current",
          });
          // The catalog moved on since the database was created: same line, newer image.
          const old = { ...newer, image: `${newer.image}-old` };
          expect(judgeVersion(engine, old, newer, lines(engine, variant))).toMatchObject({ kind: "patch", allowed: true });
        }
      }
    }
  });

  test("Postgres and pgvector never change major in place", () => {
    for (const variant of [null, "pgvector"]) {
      expect(judge("postgres", "17", "18", variant)).toMatchObject({ kind: "major", allowed: false, reason: "postgresMajor" });
      expect(judge("postgres", "15", "16", variant)).toMatchObject({ allowed: false, reason: "postgresMajor" });
      expect(judge("postgres", "17", "18", variant).message).toContain("dump and restore");
    }
    // pgvector images carry the extension's release first; a newer one on the same major is a patch.
    expect(
      judgeVersion(
        "postgres",
        { ...point("postgres", "17", "pgvector"), image: "pgvector/pgvector:0.8.0-pg17" },
        point("postgres", "17", "pgvector"),
        [],
      ),
    ).toMatchObject({ kind: "patch", allowed: true });
  });

  test("MySQL 8.0 to 8.4, MariaDB and MongoDB one line at a time", () => {
    expect(judge("mysql", "8.0", "8.4")).toMatchObject({ kind: "upgrade", allowed: true });
    expect(judge("mariadb", "10.11", "11.4")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("mariadb", "11.4", "11.8")).toMatchObject({ kind: "upgrade", allowed: true });
    expect(judge("mariadb", "10.11", "11.8")).toMatchObject({ allowed: false, reason: "oneStep" });
    expect(judge("mariadb", "10.11", "11.8").message).toContain("go to 11.4 first");
    expect(judge("mongo", "7.0", "8.0")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("mongo", "8.0", "9.0")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("mongo", "7.0", "9.0")).toMatchObject({ allowed: false, reason: "oneStep" });
  });

  test("Redis, Valkey and ClickHouse take any newer line; KeyDB and Dragonfly patches only", () => {
    expect(judge("redis", "7.4", "8.2")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("valkey", "8.1", "9.1")).toMatchObject({ kind: "major", allowed: true });
    expect(judge("valkey", "9.0", "9.1")).toMatchObject({ kind: "upgrade", allowed: true });
    expect(judge("clickhouse", "26.3", "26.8")).toMatchObject({ kind: "upgrade", allowed: true });
    for (const engine of ["keydb", "dragonfly"] as const) {
      const from = engines[engine].versions[0] as VersionPoint;
      const next = { ...from, version: `${Number(from.version.split(".")[0]) + 1}.0`, image: `${from.image}-next` };
      expect(judgeVersion(engine, from, next, [from.version, next.version])).toMatchObject({ allowed: false, reason: "patchOnly" });
    }
  });

  test("an older image of the same line and another data folder are refused", () => {
    const now = point("mongo", "8.0");
    expect(judgeVersion("mongo", { ...now, image: "mongo:8.0.99" }, now, lines("mongo"))).toMatchObject({
      kind: "downgrade",
      allowed: false,
      reason: "olderImage",
    });
    expect(
      judgeVersion("redis", point("redis", "7.4"), { ...point("redis", "8.2"), dataPath: "/elsewhere" }, lines("redis")),
    ).toMatchObject({
      allowed: false,
      reason: "dataPath",
    });
  });

  test("the line a database runs on its newest catalog image: another exact tag of it is a patch, the same or an older one is refused", () => {
    const tagOf = (engine: DatabaseEngine, variant: string | null, from: VersionPoint, image: string) =>
      judgeVersion(engine, from, { ...from, image: customImage(engine, variant, from.version, image) }, lines(engine, variant));
    const pg = point("postgres", "17");
    expect(pg.image).toBe("postgres:17.6-alpine");
    expect(tagOf("postgres", null, pg, "postgres:17.7-alpine")).toMatchObject({ kind: "patch", allowed: true });
    for (const same of ["postgres:17.6-alpine", "docker.io/library/postgres:17.6-alpine"]) {
      const j = tagOf("postgres", null, pg, same);
      expect(j).toMatchObject({ kind: "current", allowed: false, reason: "current" });
      expect(j.message).toBe("The database already runs postgres:17.6-alpine: nothing to change.");
    }
    expect(tagOf("postgres", null, pg, "postgres:17.5-alpine")).toMatchObject({ kind: "downgrade", allowed: false, reason: "olderImage" });

    const vec = point("postgres", "17", "pgvector");
    expect(tagOf("postgres", "pgvector", vec, "pgvector/pgvector:0.8.8-pg17-trixie")).toMatchObject({ kind: "patch", allowed: true });
    expect(tagOf("postgres", "pgvector", vec, vec.image)).toMatchObject({ kind: "current", allowed: false, reason: "current" });
    expect(tagOf("postgres", "pgvector", vec, "pgvector/pgvector:0.8.6-pg17-trixie")).toMatchObject({ reason: "olderImage" });

    // The same release on another base, where the engine allows that (Postgres does not: customImage).
    const mongo = point("mongo", "8.0");
    expect(tagOf("mongo", null, mongo, "mongo:8.0.38-noble")).toMatchObject({ kind: "patch", allowed: true });
    expect(tagOf("mongo", null, mongo, "mongo:8.0.39")).toMatchObject({ kind: "patch", allowed: true });
    expect(tagOf("mongo", null, mongo, "mongo:8.0.37")).toMatchObject({ kind: "downgrade", allowed: false, reason: "olderImage" });
    expect(tagOf("mongo", null, mongo, "mongo:8.0.38")).toMatchObject({ kind: "current", allowed: false, reason: "current" });
  });

  test("versions compare number by number; images give their release and line", () => {
    expect(compareVersions("10.11", "11.4")).toBe(-1);
    expect(compareVersions("11.10", "11.8")).toBe(1);
    expect(compareVersions("8.0", "8")).toBe(0);
    expect(imageRelease("mongo:8.0.38")).toBe("8.0.38");
    expect(imageRelease("postgres:17.6-alpine")).toBe("17.6");
    expect(imageRelease("ghcr.io/dragonflydb/dragonfly:v2.0.2")).toBe("2.0.2");
    expect(imageRelease("eqalpha/keydb@sha256:6537505c42355ca1f571276bddf83f5b750f760f07b2a185a676481791e388ac")).toBeNull();
    expect(imageRelease("localhost:5000/mongo")).toBeNull();
    expect(lineOfImage("mongo:7.0.21", engines.mongo.versions)).toBe("7.0");
    expect(lineOfImage("mongo:8.0.38", engines.mongo.versions)).toBe("8.0");
    expect(lineOfImage("mariadb:10.11.9", engines.mariadb.versions)).toBe("10.11");
    expect(lineOfImage("pgvector/pgvector:0.8.0-pg16", engineVersions("postgres", "pgvector") ?? [])).toBe("16");
    expect(lineOfImage("mongo:6.0.1", engines.mongo.versions)).toBeNull();
  });

  test("custom images: the engine's official repository with an exact release of the line it claims", () => {
    expect(customImage("mongo", null, "8.0", "mongo:8.0.40")).toBe("mongo:8.0.40");
    expect(customImage("mongo", null, "8.0", "docker.io/library/mongo:8.0.40")).toBe("mongo:8.0.40");
    expect(customImage("postgres", null, "17", "postgres:17.7-alpine")).toBe("postgres:17.7-alpine");
    expect(customImage("postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg17-trixie")).toBe("pgvector/pgvector:0.8.8-pg17-trixie");
    expect(customImage("valkey", null, "9.1", "valkey/valkey:9.1.4-alpine")).toBe("valkey/valkey:9.1.4-alpine");
    expect(customImage("clickhouse", null, "26.8", "clickhouse/clickhouse-server:26.8.40.1")).toBe(
      "clickhouse/clickhouse-server:26.8.40.1",
    );
    const refused = (engine: DatabaseEngine, variant: string | null, version: string, image: string) => {
      try {
        customImage(engine, variant, version, image);
        return null;
      } catch (error) {
        return (error as { details?: { reason?: string } }).details?.reason ?? "thrown";
      }
    };
    for (const [engine, variant, version, image] of [
      ["mongo", null, "8.0", "mongo:latest"],
      ["mongo", null, "8.0", "mongo"],
      ["mongo", null, "8.0", "mongo:8.0"],
      ["mongo", null, "8.0", "mongo:9.0.8"],
      ["mongo", null, "8.0", "bitnami/mongodb:8.0.4"],
      ["mongo", null, "8.0", "ghcr.io/acme/mongo:8.0.40"],
      ["postgres", null, "17", "pgvector/pgvector:0.8.8-pg17"],
      ["postgres", "pgvector", "17", "postgres:17.7"],
      ["postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg18"],
      // A digest could be any version: a downgrade or a major would pass as a patch.
      ["mongo", null, "8.0", `mongo@sha256:${"a".repeat(64)}`],
      ["mongo", null, "8.0", `mongo:8.0.40@sha256:${"a".repeat(64)}`],
      ["postgres", null, "17", `postgres@sha256:${"a".repeat(64)}`],
      // Debian instead of the catalog's Alpine (or another Debian than pgvector's trixie): another C library's collation.
      ["postgres", null, "17", "postgres:17.7"],
      ["postgres", null, "17", "postgres:17.7-bookworm"],
      ["postgres", null, "17", "postgres:17.7-trixie"],
      ["postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg17"],
      ["postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg17-bookworm"],
      ["keydb", null, "6.3", "eqalpha/keydb:x86_64_v6.3.4"],
      ["dragonfly", null, "2.0", "ghcr.io/dragonflydb/dragonfly:v2.0.3"],
    ] as const) {
      expect({ image, reason: refused(engine, variant, version, image) }).toEqual({ image, reason: "customImage" });
    }
  });

  test("a refused tag says why: a release of another line names that line, a moving tag says it moves", () => {
    const message = (engine: DatabaseEngine, variant: string | null, version: string, image: string) => {
      try {
        customImage(engine, variant, version, image);
        return null;
      } catch (error) {
        return (error as Error).message;
      }
    };
    const pickInList = "to move to another version, pick it in the list above.";
    // 8.2 was MongoDB's short-lived rapid release: an exact release, but of a line the catalog does not have.
    expect(message("mongo", null, "8.0", "mongo:8.2.12")).toBe(
      `mongo:8.2.12 is MongoDB 8.2, not 8.0. Seylo does not offer MongoDB 8.2. Another tag takes 8.0.<patch> releases; ${pickInList}`,
    );
    // Another line the catalog has: the list is the way to it.
    expect(message("mongo", null, "8.0", "mongo:9.0.8")).toBe(
      `mongo:9.0.8 is MongoDB 9.0, not 8.0. Another tag takes 8.0.<patch> releases; ${pickInList}`,
    );
    expect(message("mongo", null, "8.0", "mongo:7.0.45-jammy")).toBe(
      `mongo:7.0.45-jammy is MongoDB 7.0, not 8.0. Another tag takes 8.0.<patch> releases; ${pickInList}`,
    );
    // Moving tags: a line's tag and latest.
    expect(message("mongo", null, "8.0", "mongo:8.2")).toBe(
      "mongo:8.2 is not an exact release: it moves to each new MongoDB 8.2 release. Use a tag such as mongo:8.0.<patch>.",
    );
    expect(message("mongo", null, "8.0", "mongo:8.0")).toBe(
      "mongo:8.0 is not an exact release: it moves to each new MongoDB 8.0 release. Use a tag such as mongo:8.0.<patch>.",
    );
    expect(message("mongo", null, "8.0", "mongo:latest")).toBe(
      "mongo:latest is not an exact release: a tag without a full release number moves to each new release. Use a tag such as mongo:8.0.<patch>.",
    );
    expect(message("mongo", null, "8.0", "mongo:8.0.38")).toBeNull();
    // Postgres lines are majors; pgvector's tags name theirs after the release.
    expect(message("postgres", null, "17", "postgres:16.10-alpine")).toBe(
      `postgres:16.10-alpine is PostgreSQL 16, not 17. Another tag takes 17.<patch>-alpine releases; ${pickInList}`,
    );
    expect(message("postgres", null, "17", "postgres:17-alpine")).toBe(
      "postgres:17-alpine is not an exact release: it moves to each new PostgreSQL 17 release. Use a tag such as postgres:17.<patch>-alpine.",
    );
    expect(message("postgres", "pgvector", "17", "pgvector/pgvector:0.8.8-pg19-trixie")).toBe(
      `pgvector/pgvector:0.8.8-pg19-trixie is PostgreSQL 19, not 17. Seylo does not offer PostgreSQL 19 with pgvector. Another tag takes <release>-pg17-trixie releases; ${pickInList}`,
    );
    expect(message("postgres", "pgvector", "17", "pgvector/pgvector:pg17")).toBe(
      "pgvector/pgvector:pg17 is not an exact release: a tag without a full release number moves to each new release. Use a tag such as pgvector/pgvector:<release>-pg17-trixie.",
    );
    // The other refusals keep their own wording.
    expect(message("mongo", null, "8.0", "bitnami/mongodb:8.0.4")).toBe("Use MongoDB's official image, mongo, with an exact release tag.");
    expect(message("mongo", null, "8.0", `mongo:8.0.40@sha256:${"a".repeat(64)}`)).toStartWith(
      "Give mongo an exact release tag without a digest",
    );
  });

  test("MongoDB's compatibility step keeps the password off the command line and fails loudly", () => {
    const exec = mongoFcvExec("root", "S3cretPassword1", "7.0");
    expect(exec.command.join(" ")).not.toContain("S3cretPassword1");
    expect(exec.stdin).toContain('admin.auth("root", "S3cretPassword1")');
    expect(exec.stdin).toContain('setFeatureCompatibilityVersion: "7.0", confirm: true');
    // mongosh reading stdin goes on after an error; quit() sets the exit code.
    expect(exec.stdin).toContain("quit(2)");
    expect(exec.stdin).toContain("quit(3)");
    expect(exec.stdin.trim().split("\n")).toHaveLength(1);
  });

  test("MySQL's mysql_native_password check keeps the password off the command line and leaves out MySQL's own accounts", () => {
    const exec = mysqlNativeUsersExec("root", "S3cretPassword1");
    expect(exec.command.join(" ")).not.toContain("S3cretPassword1");
    // The admin user is an argument of the script, not part of it.
    expect(exec.command).toEqual(["sh", "-c", expect.stringContaining('-u"$1"'), "sh", "root"]);
    expect(exec.command[2]).toContain('MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot');
    const [password, query, ...rest] = exec.stdin.split("\n");
    expect(password).toBe("S3cretPassword1");
    expect(query).toContain("plugin = 'mysql_native_password'");
    expect(query).toContain("NOT IN ('mysql.sys', 'mysql.session', 'mysql.infoschema')");
    expect(rest).toEqual([""]);
  });

  describe("MySQL's mysql_native_password check run by sh against a fake mysql", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "mysql-native-"));
      // Answers like MySQL: root on the socket with rootPassword reads mysql.user; any other user
      // signs in with adminPassword but has its own database only (ERROR 1142). Every call's
      // MYSQL_PWD and arguments go to calls.log.
      writeFileSync(
        join(dir, "mysql"),
        [
          "#!/bin/sh",
          `printf '%s\\t%s\\n' "$MYSQL_PWD" "$*" >> "${dir}/calls.log"`,
          "user=; query=",
          'while [ $# -gt 0 ]; do case "$1" in -u*) user=${1#-u} ;; -e) shift; query=$1 ;; esac; shift; done',
          '[ -n "$query" ] || query=$(cat)',
          `[ "$FAKE_DOWN" = 1 ] && { echo "ERROR 2002 (HY000): Can't connect to local MySQL server through socket" >&2; exit 1; }`,
          'if [ "$user" = root ]; then want=$FAKE_ROOT_PASSWORD; else want=$FAKE_ADMIN_PASSWORD; fi',
          `[ "$MYSQL_PWD" = "$want" ] || { echo "ERROR 1045 (28000): Access denied for user '$user'@'localhost' (using password: YES)" >&2; exit 1; }`,
          `[ "$user" = root ] || { echo "ERROR 1142 (42000): SELECT command denied to user '$user'@'localhost' for table 'user'" >&2; exit 1; }`,
          `case "$query" in *mysql_native_password*) echo 'legacy@%' ;; esac`,
        ].join("\n"),
        { mode: 0o755 },
      );
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const rootPassword = "RootPassword111";
    const adminPassword = "AdminPassword222";
    /** Runs the check as the panel sends it, in a container whose MYSQL_ROOT_PASSWORD is rootEnv. */
    const check = (user: string, password: string, rootEnv: string | null, down = false) => {
      const exec = mysqlNativeUsersExec(user, password);
      const result = Bun.spawnSync(exec.command, {
        stdin: new TextEncoder().encode(exec.stdin),
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          FAKE_ROOT_PASSWORD: rootPassword,
          FAKE_ADMIN_PASSWORD: adminPassword,
          FAKE_DOWN: down ? "1" : "",
          ...(rootEnv === null ? {} : { MYSQL_ROOT_PASSWORD: rootEnv }),
        },
      });
      const log = existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "";
      rmSync(join(dir, "calls.log"), { force: true });
      const calls = log
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [pwd, args] = line.split("\t");
          return { pwd, args };
        });
      // No password is ever an argument of mysql.
      for (const call of calls) expect(call.args).not.toMatch(/RootPassword|AdminPassword|WrongPassword/);
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), calls };
    };

    test("an admin other than root: root reads the accounts with the container's root password", () => {
      const r = check("shop", adminPassword, rootPassword);
      expect(r).toMatchObject({ code: 0, stdout: "legacy@%\n" });
      expect(r.calls).toEqual([{ pwd: rootPassword, args: expect.stringMatching(/^-uroot -N -B -e SELECT /) }]);
    });

    test("root's sign-in refused: the admin signs in over TCP with the password from stdin", () => {
      // Root as the admin: its stored password still works over TCP.
      const asRoot = check("root", rootPassword, "WrongPassword333");
      expect(asRoot).toMatchObject({ code: 0, stdout: "legacy@%\n" });
      expect(asRoot.calls.map((c) => c.pwd)).toEqual(["WrongPassword333", rootPassword]);
      expect(asRoot.calls[1]?.args).toMatch(/^-h127\.0\.0\.1 -uroot -N -B -e SELECT /);
      // No MYSQL_ROOT_PASSWORD at all: the admin right away.
      const noRoot = check("root", rootPassword, null);
      expect(noRoot).toMatchObject({ code: 0, stdout: "legacy@%\n" });
      expect(noRoot.calls).toHaveLength(1);
      // An admin other than root cannot read the accounts: the check fails with MySQL's last word.
      const shop = check("shop", adminPassword, "WrongPassword333");
      expect(shop.code).not.toBe(0);
      expect(shop.stdout).toBe("");
      expect(shop.stderr.trim().split("\n").at(-1)).toContain("ERROR 1142 (42000): SELECT command denied to user 'shop'");
      expect(shop.calls.map((c) => c.pwd)).toEqual(["WrongPassword333", adminPassword]);
    });

    test("any other failure of root's is the result: no second try as the admin", () => {
      const r = check("root", rootPassword, rootPassword, true);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("ERROR 2002 (HY000)");
      expect(r.calls).toHaveLength(1);
    });
  });

  test("mysql_native_password: new databases and other engines never get the option; 8.4 takes it on and off", () => {
    const flag = "--mysql-native-password=ON";
    for (const version of engines.mysql.versions) expect(databaseSpec("mysql", version).container.command).toEqual([]);
    // An import asks for it (its file ran with it): only a line with the option takes it.
    const [mysql84, mysql80] = engines.mysql.versions;
    expect(databaseSpec("mysql", mysql84 as EngineVersion, { nativePassword: true }).container.command).toEqual(["mysqld", flag]);
    expect(databaseSpec("mysql", mysql80 as EngineVersion, { nativePassword: true }).container.command).toEqual([]);
    expect(databaseSpec("postgres", engines.postgres.versions[0] as EngineVersion, { nativePassword: true }).container.command).toEqual([]);
    expect(containerCommand("mysql", { nativePassword: true })).toEqual(["mysqld", flag]);
    expect(containerCommand("redis", { nativePassword: true })).toEqual(containerCommand("redis"));
    expect(engines.mysql.versions.filter((v) => v.nativePasswordOption).map((v) => v.version)).toEqual(["8.4"]);

    expect(withNativePassword([], true)).toEqual(["mysqld", flag]);
    expect(withNativePassword(["mysqld", flag], true)).toEqual(["mysqld", flag]);
    expect(withNativePassword(["mysqld", "--max-connections=500"], true)).toEqual(["mysqld", "--max-connections=500", flag]);
    expect(withNativePassword(["--max-connections=500"], true)).toEqual(["--max-connections=500", flag]);
    expect(withNativePassword(["sh", "-c", "exec mysqld"], true)).toBeNull();
    expect(withNativePassword(["mysqld", flag], false)).toEqual([]);
    expect(withNativePassword(["mysqld", "--max-connections=500", flag], false)).toEqual(["mysqld", "--max-connections=500"]);

    const plan = (command: string[], from: string, to: string, keep?: boolean) => nativePasswordPlan("mysql", command, from, to, keep);
    // 8.0 has the plugin on by itself: without the opt-in its accounts are checked first.
    expect(plan([], "8.0", "8.4")).toEqual({ on: false, check: true, command: null });
    expect(plan([], "8.0", "8.4", false)).toEqual({ on: false, check: true, command: null });
    expect(plan([], "8.0", "8.4", true)).toEqual({ on: true, check: false, command: ["mysqld", flag] });
    // Patch updates of 8.4 keep what it runs with, and checking is only for turning it off.
    expect(plan(["mysqld", flag], "8.4", "8.4")).toEqual({ on: true, check: false, command: null });
    expect(plan([], "8.4", "8.4")).toEqual({ on: false, check: false, command: null });
    expect(plan([], "8.4", "8.4", true)).toEqual({ on: true, check: false, command: ["mysqld", flag] });
    expect(plan(["mysqld", flag], "8.4", "8.4", false)).toEqual({ on: false, check: true, command: [] });
    // Staying on 8.0 after a failed change to 8.4 with it: 8.0 runs without the option.
    expect(plan(["mysqld", flag], "8.4", "8.0")).toEqual({ on: false, check: false, command: [] });

    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error as { code: string; details?: Record<string, string> };
      }
      throw new Error("not refused");
    };
    expect(refused(() => plan([], "8.4", "8.0", true))).toMatchObject({ code: "BAD_REQUEST", details: { field: "keepNativePassword" } });
    expect(refused(() => nativePasswordPlan("mariadb", [], "11.4", "11.8", true))).toMatchObject({ code: "BAD_REQUEST" });
    expect(nativePasswordPlan("postgres", [], "17", "17", false)).toEqual({ on: false, check: false, command: null });
    expect(refused(() => plan(["sh", "-c", "exec mysqld"], "8.0", "8.4", true))).toMatchObject({
      code: "CONFLICT",
      details: { reason: "customCommand" },
    });
  });

  test("the mysql_native_password refusal names at most 10 accounts and both ways out", () => {
    const one = nativePasswordRefusal(["legacy@%"], "8.4");
    expect(one.code).toBe("CONFLICT");
    expect(one.details).toEqual({ reason: "nativePasswordUsers", accounts: "legacy@%", count: "1" });
    expect(one.message).toContain("this account signs in with it, so it could not sign in");
    expect(one.message).toContain(": legacy@%. Nothing changed.");
    expect(one.message).toContain("IDENTIFIED WITH caching_sha2_password BY");
    expect(one.message).toContain("keep mysql_native_password logins on in MySQL 8.4");

    const accounts = Array.from({ length: 12 }, (_, i) => `app${String(i).padStart(2, "0")}@%`);
    const many = nativePasswordRefusal(accounts, "8.4");
    expect(many.message).toContain("these 12 accounts sign in with it, so they could not sign in");
    expect(many.message).toContain("app08@%, app09@% and 2 more.");
    expect(many.message).not.toContain("app10@%");
    expect(many.details?.accounts?.split("\n")).toEqual(accounts.slice(0, 10));
    expect(many.details?.count).toBe("12");
  });

  test("MariaDB containers upgrade their system tables on start; MySQL's need nothing", () => {
    const creds = { user: "root", password: "pw", database: "app" };
    expect(containerEnv("mariadb", creds)).toContainEqual({ name: "MARIADB_AUTO_UPGRADE", value: "1", secret: false });
    expect(containerEnv("mysql", creds).map((v) => v.name)).not.toContain("MYSQL_AUTO_UPGRADE");
  });
});

describe("databases.versionChoices and setVersion", () => {
  let panel: TestPanel;
  let cookie: string;
  beforeEach(async () => {
    panel = testPanel();
    cookie = (await createUser(panel, "owner")).cookie;
  });
  afterEach(async () => {
    await settleDeploys(panel);
    panel.close();
  });

  async function createDb(engine: DatabaseEngine, version: string) {
    const project = seedProject(panel);
    const node = seedNode(panel);
    panel.deps.db
      .update(nodes)
      .set({ facts: { capabilities: [enginesCapability] } })
      .where(eq(nodes.id, node.id))
      .run();
    const res = await callOp(panel, dbOps.create, { projectId: project.id, name: "shop-db", engine, version, nodeId: node.id }, { cookie });
    expect(res.status).toBe(200);
    // No agent answers here: the create deploy goes live by hand.
    await settleDeploys(panel);
    goLive(res.body.serviceId);
    return { node, serviceId: res.body.serviceId as string };
  }

  /** Ends the service's open deploys as if its node reported them healthy; the newest is live. */
  function goLive(serviceId: string) {
    const rows = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all();
    for (const d of rows) {
      if (["live", "failed", "cancelled", "superseded"].includes(d.status)) continue;
      panel.deps.db.update(deployments).set({ status: "live", finishedAt: new Date() }).where(eq(deployments.id, d.id)).run();
    }
    const newest = rows.sort((a, b) => b.generation - a.generation)[0];
    if (newest) {
      panel.deps.db
        .update(services)
        .set({ liveDeploymentId: newest.id, targetDeploymentId: newest.id })
        .where(eq(services.id, serviceId))
        .run();
    }
  }

  const specImage = (serviceId: string) => {
    const spec = panel.deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, serviceId)).get()?.spec as {
      source: { image: string };
    };
    return spec.source.image;
  };
  const setImage = (serviceId: string, image: string) => {
    const row = panel.deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, serviceId)).get();
    const spec = row?.spec as { source: Record<string, unknown> };
    panel.deps.db
      .update(services)
      .set({ spec: { ...spec, source: { ...spec.source, image } } })
      .where(eq(services.id, serviceId))
      .run();
  };
  const deployCount = (serviceId: string) =>
    panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all().length;
  const backup = (serviceId: string, finishedAt: Date) =>
    panel.deps.db
      .insert(backupRuns)
      .values({ serviceId, kind: "backup", target: "database", status: "succeeded", startedAt: finishedAt, finishedAt })
      .run();

  test("lists every catalog line with what a change would do", async () => {
    const { serviceId } = await createDb("mongo", "7.0");
    const res = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ engine: "mongo", version: "7.0", image: "mongo:7.0.45", pendingImage: null, blocked: null });
    expect(res.body.backupFresh).toBe(false);
    expect(res.body.recentBackupAt).toBeNull();
    expect(
      res.body.choices.map((c: { version: string; kind: string; allowed: boolean; reason?: string }) => [
        c.version,
        c.kind,
        c.allowed,
        c.reason ?? null,
      ]),
    ).toEqual([
      ["9.0", "major", false, "oneStep"],
      ["8.0", "major", true, null],
      ["7.0", "current", false, "current"],
    ]);
  });

  test("a patch update needs no backup and deploys the newer pinned image", async () => {
    const { serviceId } = await createDb("mongo", "8.0");
    // Created before the catalog moved on: it runs the older pinned image.
    setImage(serviceId, "mongo:8.0.12");
    const live = panel.deps.db.select({ id: services.liveDeploymentId }).from(services).where(eq(services.id, serviceId)).get()?.id ?? "";
    panel.deps.db.update(deployments).set({ imageRef: "mongo:8.0.12" }).where(eq(deployments.id, live)).run();
    const choices = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(choices.body.choices.find((c: { version: string }) => c.version === "8.0")).toMatchObject({
      kind: "patch",
      allowed: true,
      image: "mongo:8.0.38",
    });
    const before = deployCount(serviceId);
    // No agent is connected: a patch update runs no exec.
    const res = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0" }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.database).toMatchObject({ engine: "mongo", version: "8.0" });
    expect(res.body.deploymentId).toBeString();
    expect(specImage(serviceId)).toBe("mongo:8.0.38");
    expect(deployCount(serviceId)).toBe(before + 1);
  });

  test("a MongoDB upgrade needs a backup, raises the compatibility version first and changes nothing when that fails", async () => {
    const { serviceId, node } = await createDb("mongo", "7.0");
    const refused = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0" }, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("backupRequired");
    // A backup older than a day does not count.
    backup(serviceId, new Date(Date.now() - 25 * 60 * 60 * 1000));
    expect((await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0" }, { cookie })).body.error.details.reason).toBe(
      "backupRequired",
    );

    const before = deployCount(serviceId);
    const failing = fakeAgent(panel, node.id, {
      exec: () => ({ exitCode: 3, stdout: new TextEncoder().encode("Authentication failed.\n") }),
    });
    const failed = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0", confirmNoBackup: true }, { cookie });
    expect(failed.status).toBe(409);
    expect(failed.body.error.details.reason).toBe("fcvFailed");
    expect(failed.body.error.message).toContain("Authentication failed.");
    expect(panel.deps.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, serviceId)).get()?.version).toBe("7.0");
    expect(specImage(serviceId)).toBe("mongo:7.0.45");
    expect(deployCount(serviceId)).toBe(before);
    failing.disconnect();

    backup(serviceId, new Date(Date.now() - 60 * 60 * 1000));
    const fresh = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(fresh.body.backupFresh).toBe(true);
    let request: { command: string[]; stdin: Uint8Array } | null = null;
    const agent = fakeAgent(panel, node.id, {
      exec: (req: { command: string[]; stdin: Uint8Array }) => {
        request = req;
        return { exitCode: 0 };
      },
    });
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    const res = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.0" }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.database.version).toBe("8.0");
    expect(specImage(serviceId)).toBe("mongo:8.0.38");
    expect(deployCount(serviceId)).toBe(before + 1);
    const sent = request as unknown as { command: string[]; stdin: Uint8Array };
    const stdin = new TextDecoder().decode(sent.stdin);
    // The running 7.0 is set to its own line before 8.0 starts on its files.
    expect(stdin).toContain('setFeatureCompatibilityVersion: "7.0"');
    expect(stdin).toContain(conn.body.internal.password);
    expect(sent.command.join(" ")).not.toContain(conn.body.internal.password);
    agent.disconnect();
  });

  const specCommand = (serviceId: string) => {
    const spec = panel.deps.db.select({ spec: services.spec }).from(services).where(eq(services.id, serviceId)).get()?.spec as {
      container: { command: string[] };
    };
    return spec.container.command;
  };
  const dbVersion = (serviceId: string) =>
    panel.deps.db.select().from(serviceDatabases).where(eq(serviceDatabases.serviceId, serviceId)).get()?.version;
  const nativeFlag = "--mysql-native-password=ON";
  type ExecRequest = { command: string[]; stdin: Uint8Array };
  /** A fake agent whose exec answers MySQL's account list with these user@host lines. */
  const mysqlAccounts = (nodeId: string, accounts: string[], sent: ExecRequest[] = []) =>
    fakeAgent(panel, nodeId, {
      exec: (req: ExecRequest) => {
        sent.push(req);
        return { exitCode: 0, stdout: new TextEncoder().encode(accounts.map((a) => `${a}\n`).join("")) };
      },
    });

  test("MySQL 8.0 to 8.4 with no account on mysql_native_password: the accounts are listed first, then it deploys as before", async () => {
    const { serviceId, node } = await createDb("mysql", "8.0");
    const choices = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(choices.body.nativePassword).toEqual({ on: false, lines: ["8.4"] });
    const sent: ExecRequest[] = [];
    const agent = mysqlAccounts(node.id, [], sent);
    const conn = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
    const before = deployCount(serviceId);
    const res = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.4", confirmNoBackup: true }, { cookie });
    expect(res.status).toBe(200);
    expect(res.body.database.version).toBe("8.4");
    expect(specImage(serviceId)).toBe("mysql:8.4.6");
    expect(specCommand(serviceId)).toEqual([]);
    expect(deployCount(serviceId)).toBe(before + 1);
    // One exec in the running 8.0: root signs in from the container's environment, the admin (when root
    // cannot) with the password on stdin only.
    expect(sent).toHaveLength(1);
    const req = sent[0] as ExecRequest;
    expect(req.command.at(-1)).toBe(conn.body.internal.user);
    expect(req.command.join(" ")).not.toContain(conn.body.internal.password);
    expect(new TextDecoder().decode(req.stdin).split("\n")[0]).toBe(conn.body.internal.password);
    agent.disconnect();
  });

  test("MySQL 8.0 to 8.4 with accounts on mysql_native_password is refused with their names, and nothing changes", async () => {
    const { serviceId, node } = await createDb("mysql", "8.0");
    const agent = mysqlAccounts(node.id, ["legacy@%", "shop@10.0.0.%"]);
    const before = deployCount(serviceId);
    for (const keepNativePassword of [undefined, false]) {
      const res = await callOp(
        panel,
        dbOps.setVersion,
        { serviceId, version: "8.4", confirmNoBackup: true, keepNativePassword },
        { cookie },
      );
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual({ reason: "nativePasswordUsers", accounts: "legacy@%\nshop@10.0.0.%", count: "2" });
      expect(res.body.error.message).toContain(": legacy@%, shop@10.0.0.%. Nothing changed.");
      expect(res.body.error.message).toContain("caching_sha2_password");
      expect(res.body.error.message).toContain("keepNativePassword");
    }
    expect(dbVersion(serviceId)).toBe("8.0");
    expect(specImage(serviceId)).toBe("mysql:8.0.43");
    expect(specCommand(serviceId)).toEqual([]);
    expect(deployCount(serviceId)).toBe(before);
    agent.disconnect();
  });

  test("MySQL keepNativePassword: 8.4 runs with mysql_native_password on, later deploys and patch updates keep it, off is checked", async () => {
    const { serviceId, node } = await createDb("mysql", "8.0");
    const sent: ExecRequest[] = [];
    let agent = mysqlAccounts(node.id, ["legacy@%"], sent);
    const res = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId, version: "8.4", confirmNoBackup: true, keepNativePassword: true },
      { cookie },
    );
    expect(res.status).toBe(200);
    // The old logins keep working either way: nothing to list.
    expect(sent).toHaveLength(0);
    expect(dbVersion(serviceId)).toBe("8.4");
    expect(specImage(serviceId)).toBe("mysql:8.4.6");
    expect(specCommand(serviceId)).toEqual(["mysqld", nativeFlag]);
    await settleDeploys(panel);
    goLive(serviceId);
    // What the node gets: mysqld through the image's entrypoint with the option.
    const compiled = serviceSpecFor(panel.deps.db, panel.deps.secrets, serviceId, node.id);
    expect(compiled?.container?.command).toEqual(["mysqld", nativeFlag]);
    expect(compiled?.container?.entrypoint).toEqual([]);
    const choices = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(choices.body.nativePassword).toEqual({ on: true, lines: ["8.4"] });
    // A clone runs with it too.
    const projectId = panel.deps.db.select().from(services).where(eq(services.id, serviceId)).get()?.projectId ?? "";
    const clone = await callOp(panel, serviceOps.clone, { serviceId, projectId, nodeId: node.id, data: "empty" }, { cookie });
    expect(clone.status).toBe(200);
    expect(specCommand(clone.body.service.id)).toEqual(["mysqld", nativeFlag]);

    // A patch update to another tag of 8.4 keeps it without asking, and lists nothing.
    const patch = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.4", image: "mysql:8.4.7" }, { cookie });
    expect(patch.status).toBe(200);
    expect(specCommand(serviceId)).toEqual(["mysqld", nativeFlag]);
    expect(sent).toHaveLength(0);
    await settleDeploys(panel);
    goLive(serviceId);
    expect(serviceSpecFor(panel.deps.db, panel.deps.secrets, serviceId, node.id)?.container?.command).toEqual(["mysqld", nativeFlag]);

    // Turning it off is checked like the upgrade: refused while an account needs it...
    const off = () =>
      callOp(panel, dbOps.setVersion, { serviceId, version: "8.4", image: "mysql:8.4.8", keepNativePassword: false }, { cookie });
    const refused = await off();
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("nativePasswordUsers");
    expect(specCommand(serviceId)).toEqual(["mysqld", nativeFlag]);
    expect(specImage(serviceId)).toBe("mysql:8.4.7");
    agent.disconnect();
    // ...and back to the image's own command once none does.
    agent = mysqlAccounts(node.id, [], sent);
    const done = await off();
    expect(done.status).toBe(200);
    expect(specCommand(serviceId)).toEqual([]);
    expect(specImage(serviceId)).toBe("mysql:8.4.8");
    agent.disconnect();
  });

  test("MySQL 8.4 on the image it runs: keepNativePassword alone turns the option on or off and deploys that image again", async () => {
    const { serviceId, node } = await createDb("mysql", "8.4");
    const sent: ExecRequest[] = [];
    let agent = mysqlAccounts(node.id, ["legacy@%"], sent);
    const logOf = (deploymentId: string) =>
      panel.deps.db
        .select({ text: deploymentLogs.text })
        .from(deploymentLogs)
        .where(eq(deploymentLogs.deploymentId, deploymentId))
        .all()
        .map((r) => r.text);
    const set = (input: { keepNativePassword?: boolean; image?: string }) =>
      callOp(panel, dbOps.setVersion, { serviceId, version: "8.4", ...input }, { cookie });
    // The same image as it runs, as it runs: nothing to change.
    for (const input of [{}, { keepNativePassword: false }]) {
      const same = await set(input);
      expect(same.status).toBe(409);
      expect(same.body.error.details.reason).toBe("current");
    }
    const before = deployCount(serviceId);

    const on = await set({ keepNativePassword: true });
    expect(on.status).toBe(200);
    // Turning it on locks no one out: nothing to list.
    expect(sent).toHaveLength(0);
    expect(dbVersion(serviceId)).toBe("8.4");
    expect(specImage(serviceId)).toBe("mysql:8.4.6");
    expect(specCommand(serviceId)).toEqual(["mysqld", nativeFlag]);
    expect(deployCount(serviceId)).toBe(before + 1);
    const onLog = logOf(on.body.deploymentId);
    expect(onLog).toContain("mysql_native_password logins on (--mysql-native-password=ON), on the image it runs (mysql:8.4.6).");
    expect(onLog.some((line) => line.startsWith("Version change"))).toBe(false);
    await settleDeploys(panel);
    goLive(serviceId);
    expect((await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie })).body.nativePassword).toEqual({
      on: true,
      lines: ["8.4"],
    });
    const again = await set({ keepNativePassword: true });
    expect([again.status, again.body.error.details.reason]).toEqual([409, "current"]);

    // Off lists the running database's accounts first, like the upgrade: refused while one needs it...
    const refused = await set({ keepNativePassword: false });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("nativePasswordUsers");
    expect(sent).toHaveLength(1);
    expect(specCommand(serviceId)).toEqual(["mysqld", nativeFlag]);
    expect(deployCount(serviceId)).toBe(before + 1);
    agent.disconnect();
    // ...and deploys the image without it once none does.
    agent = mysqlAccounts(node.id, [], sent);
    const off = await set({ keepNativePassword: false });
    expect(off.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(specCommand(serviceId)).toEqual([]);
    expect(specImage(serviceId)).toBe("mysql:8.4.6");
    expect(logOf(off.body.deploymentId)).toContain("mysql_native_password logins off, on the image it runs (mysql:8.4.6).");
    await settleDeploys(panel);
    goLive(serviceId);

    // A custom tag that runs takes it the same way.
    expect((await set({ image: "mysql:8.4.7" })).status).toBe(200);
    await settleDeploys(panel);
    goLive(serviceId);
    const custom = await set({ image: "mysql:8.4.7", keepNativePassword: true });
    expect(custom.status).toBe(200);
    expect(specImage(serviceId)).toBe("mysql:8.4.7");
    expect(specCommand(serviceId)).toEqual(["mysqld", nativeFlag]);
    expect(logOf(custom.body.deploymentId)).toContain(
      "mysql_native_password logins on (--mysql-native-password=ON), on the image it runs (mysql:8.4.7).",
    );
    agent.disconnect();
  });

  test("MySQL's account list failing refuses the change and changes nothing; keepNativePassword is MySQL 8.4's only", async () => {
    const { serviceId, node } = await createDb("mysql", "8.0");
    const before = deployCount(serviceId);
    const unchanged = () => {
      expect(dbVersion(serviceId)).toBe("8.0");
      expect(specImage(serviceId)).toBe("mysql:8.0.43");
      expect(specCommand(serviceId)).toEqual([]);
      expect(deployCount(serviceId)).toBe(before);
    };
    // No agent answers.
    const offline = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.4", confirmNoBackup: true }, { cookie });
    expect(offline.status).toBe(409);
    expect(offline.body.error.details.reason).toBe("nativePasswordCheckFailed");
    unchanged();
    // MySQL refuses the sign-in.
    const agent = fakeAgent(panel, node.id, {
      exec: () => ({ exitCode: 1, stderr: new TextEncoder().encode("ERROR 1045 (28000): Access denied for user 'root'@'127.0.0.1'\n") }),
    });
    const failed = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.4", confirmNoBackup: true }, { cookie });
    expect(failed.status).toBe(409);
    expect(failed.body.error.details.reason).toBe("nativePasswordCheckFailed");
    expect(failed.body.error.message).toContain("MySQL said: ERROR 1045 (28000): Access denied");
    expect(failed.body.error.message).toContain("nothing changed");
    unchanged();
    agent.disconnect();

    const mongo = await createDb("mongo", "7.0");
    const wrong = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId: mongo.serviceId, version: "7.0", keepNativePassword: true },
      { cookie },
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.field).toBe("keepNativePassword");
    expect((await callOp(panel, dbOps.versionChoices, { serviceId: mongo.serviceId }, { cookie })).body.nativePassword).toBeNull();
  });

  test("two changes at once: the second refuses once the first queued its deploy", async () => {
    const { serviceId, node } = await createDb("mongo", "7.0");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = fakeAgent(panel, node.id, {
      exec: async () => {
        await gate;
        return { exitCode: 0 };
      },
    });
    const before = deployCount(serviceId);
    const first = callOp(panel, dbOps.setVersion, { serviceId, version: "8.0", confirmNoBackup: true }, { cookie });
    const second = callOp(panel, dbOps.setVersion, { serviceId, version: "8.0", confirmNoBackup: true }, { cookie });
    // Both wait in the MongoDB step.
    await Bun.sleep(100);
    release();
    const statuses = (await Promise.all([first, second])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(deployCount(serviceId)).toBe(before + 1);
    agent.disconnect();
  });

  test("downgrades, Postgres majors and skipped lines are refused; custom images are checked", async () => {
    const mongo = await createDb("mongo", "8.0");
    const down = await callOp(panel, dbOps.setVersion, { serviceId: mongo.serviceId, version: "7.0", confirmNoBackup: true }, { cookie });
    expect(down.status).toBe(409);
    expect(down.body.error.details.reason).toBe("downgrade");
    const unknown = await callOp(panel, dbOps.setVersion, { serviceId: mongo.serviceId, version: "6.0" }, { cookie });
    expect(unknown.status).toBe(400);
    const latest = await callOp(panel, dbOps.setVersion, { serviceId: mongo.serviceId, version: "8.0", image: "mongo:latest" }, { cookie });
    expect(latest.status).toBe(400);
    expect(latest.body.error.details.reason).toBe("customImage");
    // A digest-only image of another version would pass as a patch of the line it claims.
    const digest = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId: mongo.serviceId, version: "8.0", image: `mongo@sha256:${"b".repeat(64)}` },
      { cookie },
    );
    expect(digest.status).toBe(400);
    expect(digest.body.error.details.reason).toBe("customImage");
    expect(specImage(mongo.serviceId)).toBe("mongo:8.0.38");
    // A custom image of the same line is a patch update.
    const custom = await callOp(panel, dbOps.setVersion, { serviceId: mongo.serviceId, version: "8.0", image: "mongo:8.0.40" }, { cookie });
    expect(custom.status).toBe(200);
    expect(specImage(mongo.serviceId)).toBe("mongo:8.0.40");

    const pg = await createDb("postgres", "17");
    const major = await callOp(panel, dbOps.setVersion, { serviceId: pg.serviceId, version: "18", confirmNoBackup: true }, { cookie });
    expect(major.status).toBe(409);
    expect(major.body.error.details.reason).toBe("postgresMajor");
    expect(major.body.error.message).toContain("dump and restore");
    // The Debian image of the same major is no patch: its C library sorts text in another order.
    const debian = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId: pg.serviceId, version: "17", image: "postgres:17.7-bookworm" },
      { cookie },
    );
    expect(debian.status).toBe(400);
    expect(debian.body.error.details.reason).toBe("customImage");
    expect(debian.body.error.message).toContain("sorts text differently");
    expect(specImage(pg.serviceId)).toBe("postgres:17.6-alpine");
    const alpine = await callOp(
      panel,
      dbOps.setVersion,
      { serviceId: pg.serviceId, version: "17", image: "postgres:17.7-alpine" },
      { cookie },
    );
    expect(alpine.status).toBe(200);
    expect(specImage(pg.serviceId)).toBe("postgres:17.7-alpine");

    const maria = await createDb("mariadb", "10.11");
    const skip = await callOp(panel, dbOps.setVersion, { serviceId: maria.serviceId, version: "11.8", confirmNoBackup: true }, { cookie });
    expect(skip.body.error.details.reason).toBe("oneStep");
    // The change deploys with the container env that upgrades MariaDB's system tables.
    const env = Object.fromEntries(resolveServiceEnv(panel.deps, maria.serviceId).map((v) => [v.name, v.value]));
    expect(env.MARIADB_AUTO_UPGRADE).toBe("1");
    const step = await callOp(panel, dbOps.setVersion, { serviceId: maria.serviceId, version: "11.4", confirmNoBackup: true }, { cookie });
    expect(step.status).toBe(200);
    expect(specImage(maria.serviceId)).toBe("mariadb:11.4.7");
  });

  test("the line it runs on its newest catalog image takes another exact tag of it: newer is a patch, the same or an older one is refused", async () => {
    const { serviceId } = await createDb("postgres", "17");
    const choices = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(choices.body).toMatchObject({ version: "17", image: "postgres:17.6-alpine", customOnCurrent: true, backupFresh: false });
    // No catalog choice of 17 can be picked: it runs the newest pinned image.
    expect(choices.body.choices.find((c: { version: string }) => c.version === "17")).toMatchObject({ kind: "current", allowed: false });

    const set = (image: string) => callOp(panel, dbOps.setVersion, { serviceId, version: "17", image }, { cookie });
    const before = deployCount(serviceId);
    for (const same of ["postgres:17.6-alpine", "docker.io/library/postgres:17.6-alpine"]) {
      const res = await set(same);
      expect(res.status).toBe(409);
      expect(res.body.error.details.reason).toBe("current");
      expect(res.body.error.message).toContain("nothing to change");
    }
    const older = await set("postgres:17.5-alpine");
    expect(older.status).toBe(409);
    expect(older.body.error.details.reason).toBe("olderImage");
    for (const refused of [
      "postgres:17.7",
      "postgres:17.7-bookworm",
      `postgres@sha256:${"c".repeat(64)}`,
      "bitnami/postgresql:17.7.0",
      "postgres:17",
    ]) {
      const res = await set(refused);
      expect({ refused, status: res.status, reason: res.body.error.details.reason }).toEqual({
        refused,
        status: 400,
        reason: "customImage",
      });
    }
    expect(deployCount(serviceId)).toBe(before);
    expect(specImage(serviceId)).toBe("postgres:17.6-alpine");

    // A newer release of the line is a patch update: no backup, no confirmNoBackup.
    const newer = await set("postgres:17.7-alpine");
    expect(newer.status).toBe(200);
    expect(newer.body.database.version).toBe("17");
    expect(specImage(serviceId)).toBe("postgres:17.7-alpine");
    expect(deployCount(serviceId)).toBe(before + 1);

    // Once it runs, the catalog's image of its line is older, and another tag still goes.
    await settleDeploys(panel);
    goLive(serviceId);
    const live = panel.deps.db.select({ id: services.liveDeploymentId }).from(services).where(eq(services.id, serviceId)).get()?.id ?? "";
    panel.deps.db.update(deployments).set({ imageRef: "postgres:17.7-alpine" }).where(eq(deployments.id, live)).run();
    const after = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(after.body).toMatchObject({ image: "postgres:17.7-alpine", pendingImage: null, customOnCurrent: true });
    expect(after.body.choices.find((c: { version: string }) => c.version === "17")).toMatchObject({
      kind: "downgrade",
      allowed: false,
      reason: "olderImage",
    });
    expect((await set("postgres:17.6-alpine")).body.error.details.reason).toBe("olderImage");
    expect((await set("postgres:17.7-alpine")).body.error.details.reason).toBe("current");
    expect((await set("postgres:17.8-alpine")).status).toBe(200);
  });

  test("another tag of the line it runs: not for KeyDB or Dragonfly, nor while blocked", async () => {
    for (const [engine, version, image] of [
      ["keydb", "6.3", "eqalpha/keydb:x86_64_v6.3.5"],
      ["dragonfly", "2.0", "ghcr.io/dragonflydb/dragonfly:v2.0.3"],
    ] as const) {
      const { serviceId } = await createDb(engine, version);
      const choices = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
      expect({ engine, customOnCurrent: choices.body.customOnCurrent }).toEqual({ engine, customOnCurrent: false });
      const res = await callOp(panel, dbOps.setVersion, { serviceId, version, image }, { cookie });
      expect({ engine, status: res.status, reason: res.body.error.details.reason }).toEqual({ engine, status: 400, reason: "customImage" });
    }
    const { serviceId } = await createDb("mongo", "8.0");
    expect((await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie })).body.customOnCurrent).toBe(true);
    panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, serviceId)).run();
    const stopped = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(stopped.body).toMatchObject({ blocked: { reason: "stopped" }, customOnCurrent: false });
  });

  test("a stopped database, a running deploy or no node blocks every change", async () => {
    const { serviceId } = await createDb("redis", "7.4");
    panel.deps.db.update(services).set({ stopped: true }).where(eq(services.id, serviceId)).run();
    const stopped = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(stopped.body.blocked).toMatchObject({ reason: "stopped" });
    const refused = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.2", confirmNoBackup: true }, { cookie });
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("stopped");
    panel.deps.db.update(services).set({ stopped: false }).where(eq(services.id, serviceId)).run();

    const first = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.2", confirmNoBackup: true }, { cookie });
    expect(first.status).toBe(200);
    // Its deploy is queued or running: a second change waits for it.
    const second = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(second.body.blocked).toMatchObject({ reason: "deployRunning" });
    expect(second.body.pendingImage).toBe("redis:8.2.1-alpine");
  });

  test("a rollback never takes a database back to the image it ran before a version change", async () => {
    const { serviceId, node } = await createDb("mysql", "8.0");
    // No account signs in with mysql_native_password.
    const agent = fakeAgent(panel, node.id, { exec: () => ({ exitCode: 0 }) });
    const res = await callOp(panel, dbOps.setVersion, { serviceId, version: "8.4", confirmNoBackup: true }, { cookie });
    expect(res.status).toBe(200);
    agent.disconnect();
    await settleDeploys(panel);
    // 8.4 went live; the 8.0 deployment is kept for rollbacks.
    const rows = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).all();
    const old = rows.find((d) => d.id !== res.body.deploymentId);
    if (!old) throw new Error("no earlier deployment");
    const at = new Date();
    panel.deps.db.update(deployments).set({ status: "superseded", imageRef: "mysql:8.0.43" }).where(eq(deployments.id, old.id)).run();
    panel.deps.db
      .update(deployments)
      .set({ status: "live", imageRef: "mysql:8.4.6", finishedAt: at })
      .where(eq(deployments.id, res.body.deploymentId))
      .run();
    panel.deps.db
      .update(services)
      .set({ liveDeploymentId: res.body.deploymentId, targetDeploymentId: res.body.deploymentId })
      .where(eq(services.id, serviceId))
      .run();
    // The 8.0 image is kept, but list and get do not offer what rollback refuses.
    const rollbackFlags = async () => {
      const view = await callOp(panel, deploymentOps.get, { serviceId, deploymentId: old.id }, { cookie });
      const listed = await callOp(panel, deploymentOps.list, { serviceId }, { cookie });
      const row = listed.body.deployments.find((d: { id: string }) => d.id === old.id);
      return { get: view.body.deployment.canRollback, list: row?.canRollback };
    };
    expect(await rollbackFlags()).toEqual({ get: false, list: false });

    const rb = await callOp(panel, deploymentOps.rollback, { serviceId, deploymentId: old.id }, { cookie });
    expect(rb.status).toBe(409);
    expect(rb.body.error.details.reason).toBe("databaseVersion");
    expect(rb.body.error.message).toContain("mysql:8.0.43");
    expect(deployCount(serviceId)).toBe(2);

    // A deployment of the image it runs only restarts it.
    panel.deps.db.update(deployments).set({ imageRef: "mysql:8.4.6" }).where(eq(deployments.id, old.id)).run();
    expect(await rollbackFlags()).toEqual({ get: true, list: true });
    const same = await callOp(panel, deploymentOps.rollback, { serviceId, deploymentId: old.id }, { cookie });
    expect(same.status).toBe(200);
  });

  test("a database with no live deployment offers no rollback, and refuses one for its version", async () => {
    const { serviceId } = await createDb("mysql", "8.0");
    await settleDeploys(panel);
    const row = panel.deps.db.select().from(deployments).where(eq(deployments.serviceId, serviceId)).get();
    if (!row) throw new Error("no deployment");
    // Nothing is live: only a superseded deployment of 8.0 is left.
    panel.deps.db.update(deployments).set({ status: "superseded", imageRef: "mysql:8.0.43" }).where(eq(deployments.id, row.id)).run();
    panel.deps.db.update(services).set({ liveDeploymentId: null }).where(eq(services.id, serviceId)).run();
    const view = await callOp(panel, deploymentOps.get, { serviceId, deploymentId: row.id }, { cookie });
    expect(view.body.deployment.canRollback).toBe(false);
    const rb = await callOp(panel, deploymentOps.rollback, { serviceId, deploymentId: row.id }, { cookie });
    expect({ status: rb.status, reason: rb.body.error.details.reason }).toEqual({ status: 409, reason: "databaseVersion" });
  });

  test("after a failed change the database is judged by what still runs: retry or stay", async () => {
    const { serviceId } = await createDb("mongo", "7.0");
    // The 7.0 deploy went live; then a change to 8.0 failed, so 7.0 still runs.
    panel.deps.db.update(serviceDatabases).set({ version: "8.0" }).where(eq(serviceDatabases.serviceId, serviceId)).run();
    setImage(serviceId, "mongo:8.0.38");
    const res = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(res.body).toMatchObject({ version: "7.0", image: "mongo:7.0.45", pendingImage: "mongo:8.0.38" });
    expect(res.body.choices.map((c: { version: string; allowed: boolean }) => [c.version, c.allowed])).toEqual([
      ["9.0", false],
      ["8.0", true],
      ["7.0", true],
    ]);
    // Staying on 7.0 is no line change: no backup, no exec.
    const stay = await callOp(panel, dbOps.setVersion, { serviceId, version: "7.0" }, { cookie });
    expect(stay.status).toBe(200);
    expect(stay.body.database.version).toBe("7.0");
    expect(specImage(serviceId)).toBe("mongo:7.0.45");
  });

  test("after a failed change to another tag, the custom tag that still runs is set again as itself", async () => {
    const { serviceId } = await createDb("postgres", "17");
    // It runs postgres:17.7-alpine (not the catalog's 17.6); then a change to postgres:17.99-alpine failed.
    const live = panel.deps.db.select({ id: services.liveDeploymentId }).from(services).where(eq(services.id, serviceId)).get()?.id ?? "";
    panel.deps.db.update(deployments).set({ imageRef: "postgres:17.7-alpine" }).where(eq(deployments.id, live)).run();
    setImage(serviceId, "postgres:17.99-alpine");
    const res = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(res.body).toMatchObject({
      version: "17",
      image: "postgres:17.7-alpine",
      pendingImage: "postgres:17.99-alpine",
      blocked: null,
      customOnCurrent: true,
    });
    // The catalog's image of 17 cannot be the way to stay: it is older than what runs.
    expect(res.body.choices.find((c: { version: string }) => c.version === "17")).toMatchObject({ allowed: false, reason: "olderImage" });

    const set = (image: string) => callOp(panel, dbOps.setVersion, { serviceId, version: "17", image }, { cookie });
    expect((await set("postgres:17.6-alpine")).body.error.details.reason).toBe("olderImage");
    // The tag it runs, given as the image of its own line: no backup, the spec runs it again.
    const before = deployCount(serviceId);
    const stay = await set("postgres:17.7-alpine");
    expect(stay.status).toBe(200);
    expect(stay.body.database.version).toBe("17");
    expect(specImage(serviceId)).toBe("postgres:17.7-alpine");
    expect(deployCount(serviceId)).toBe(before + 1);
    const after = await callOp(panel, dbOps.versionChoices, { serviceId }, { cookie });
    expect(after.body.pendingImage).toBeNull();
  });
});
