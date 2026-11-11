// MySQL and MariaDB password resets keep root in step with the admin: the
// container gives root the admin's password (containerEnv), so
// changePasswordExec changes root's with it, also for an admin other than
// root. The script runs under sh and dash (the MySQL image's /bin/sh is
// bash, MariaDB's is dash) against a fake client that keeps its accounts in
// files, signs in like the server (user@localhost on the socket, else
// user@%), and refuses what the real one refuses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { databases as dbOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { nodes } from "../src/db/schema";
import {
  changePasswordExec,
  containerEnv,
  enginesCapability,
  rootPasswordVariable,
  rootUnchangedMarker,
} from "../src/modules/databases/engines";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, settleDeploys } from "./seed-helpers";

type Engine = "mysql" | "mariadb";

/**
 * A fake mysql (or mariadb) in its own folder: accounts are files
 * acct/<user>@<host> holding the password. It answers ERROR 1045 to a wrong
 * password, runs the statements of its stdin in order and stops at the
 * first error (batch mode): ALTER USER of another account needs root
 * (ERROR 1227 otherwise), a missing account fails (1396) unless IF
 * EXISTS, an account may change its own password (MySQL: ALTER USER
 * USER(); MariaDB: SET PASSWORD = PASSWORD(), which MySQL 8 no longer
 * has). Every call's MYSQL_PWD and arguments go to calls.log.
 */
function fakeClient(engine: Engine) {
  const dir = mkdtempSync(join(tmpdir(), `fake-${engine}-`));
  mkdirSync(join(dir, "acct"));
  const own = engine === "mysql" ? `"ALTER USER USER() IDENTIFIED BY '"*` : `"SET PASSWORD = PASSWORD('"*`;
  writeFileSync(
    join(dir, engine),
    [
      "#!/bin/sh",
      `d='${dir}'`,
      `printf '%s\\t%s\\n' "$MYSQL_PWD" "$*" >> "$d/calls.log"`,
      "user=; host=localhost",
      'for a in "$@"; do case "$a" in -u*) user=${a#-u} ;; -h*) host=${a#-h} ;; esac; done',
      `[ "$FAKE_DOWN" = 1 ] && { echo "ERROR 2002 (HY000): Can't connect to local server through socket" >&2; exit 1; }`,
      "acct=$user@%",
      '[ "$host" = localhost ] && [ -f "$d/acct/$user@localhost" ] && acct=$user@localhost',
      `{ [ -f "$d/acct/$acct" ] && [ "$MYSQL_PWD" = "$(cat "$d/acct/$acct")" ]; } || { echo "ERROR 1045 (28000): Access denied for user '$user'@'$host' (using password: YES)" >&2; exit 1; }`,
      "sql=$(cat)",
      `printf '%s\\n' "$sql" | tr ';' '\\n' | while IFS= read -r st; do`,
      `  st=$(printf '%s' "$st" | sed 's/^ *//')`,
      `  new=$(printf '%s' "$st" | sed -n -e "s/.*IDENTIFIED BY '\\([^']*\\)'.*/\\1/p" -e "s/.*PASSWORD('\\([^']*\\)').*/\\1/p")`,
      '  case "$st" in',
      '    ""|"FLUSH PRIVILEGES"|"SELECT "*) ;;',
      `    ${own}) printf '%s' "$new" > "$d/acct/$acct" ;;`,
      '    "ALTER USER USER()"*|"SET PASSWORD"*) echo "ERROR 1064 (42000): You have an error in your SQL syntax" >&2; exit 1 ;;',
      '    "ALTER USER "*)',
      `      target=$(printf '%s' "$st" | sed "s/^ALTER USER \\(IF EXISTS \\)\\{0,1\\}'\\([^']*\\)'@'\\([^']*\\)'.*/\\2@\\3/")`,
      `      [ "$user" = root ] || { echo "ERROR 1227 (42000): Access denied; you need (at least one of) the CREATE USER privilege(s) for this operation" >&2; exit 1; }`,
      `      if [ -f "$d/acct/$target" ]; then printf '%s' "$new" > "$d/acct/$target"`,
      `      else case "$st" in "ALTER USER IF EXISTS"*) ;; *) echo "ERROR 1396 (HY000): Operation ALTER USER failed for '$target'" >&2; exit 1 ;; esac; fi ;;`,
      `    *) echo "ERROR 1064 (42000): You have an error in your SQL syntax near '$st'" >&2; exit 1 ;;`,
      "  esac",
      "done || exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  const accountsDir = join(dir, "acct");
  return {
    dir,
    /** Sets accounts: { "root@%": "pw", ... }. */
    set(accounts: Record<string, string>) {
      for (const [account, password] of Object.entries(accounts)) writeFileSync(join(accountsDir, account), password);
    },
    accounts(): Record<string, string> {
      return Object.fromEntries(readdirSync(accountsDir).map((a) => [a, readFileSync(join(accountsDir, a), "utf8")]));
    },
    /** Runs argv with stdin in a container whose environment is env; with shell, under that shell. */
    run(argv: string[], stdin: string, env: Record<string, string>, shell?: string) {
      const command = shell && argv[0] === "sh" ? [shell, ...argv.slice(1)] : argv;
      const result = Bun.spawnSync(command, { stdin: new TextEncoder().encode(stdin), env: { PATH: `${dir}:/usr/bin:/bin`, ...env } });
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
      return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), calls };
    },
    /** Root signs in on the socket with the container's root password, as a person or a tool reading the env would. */
    rootSignsIn(env: Record<string, string>) {
      const variable = rootPasswordVariable(engine);
      return this.run(["sh", "-c", `MYSQL_PWD="$${variable}" ${engine} -uroot`], "SELECT 1;\n", env).code === 0;
    },
    /** The admin signs in over TCP with its password. */
    adminSignsIn(user: string, password: string) {
      return this.run(["sh", "-c", `MYSQL_PWD="$1" ${engine} -h127.0.0.1 -u"$2"`, "sh", password, user], "SELECT 1;\n", {}).code === 0;
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** The container's environment as containerEnv gives it for the admin and password. */
function envOf(engine: Engine, user: string, password: string): Record<string, string> {
  return Object.fromEntries(containerEnv(engine, { user, password, database: "app" }).map((v) => [v.name, v.value]));
}

const passwords = ["Password0Initial", "Password1Second", "Password2Third", "Password3Fourth"] as const;
const [p0, p1, p2, p3] = passwords;

for (const engine of ["mysql", "mariadb"] as const) {
  for (const shell of ["sh", "dash"]) {
    describe(`${engine} password change under ${shell}`, () => {
      let client: ReturnType<typeof fakeClient>;
      beforeEach(() => {
        client = fakeClient(engine);
      });
      afterEach(() => client.close());

      const change = (user: string, current: string, password: string, env: Record<string, string>) => {
        const exec = changePasswordExec(engine, user, password, current);
        if (!exec) throw new Error("no exec");
        const r = client.run(exec.command, exec.stdin, env, shell);
        // No password is ever an argument: of the script or of the client.
        for (const word of [...exec.command, ...r.calls.map((c) => c.args)]) expect(word).not.toMatch(/Password\d/);
        return r;
      };

      test("an admin other than root: root gets the new password with it, and signs in with the env after the next deploy", () => {
        // As the image's first start makes them from containerEnv.
        client.set({ "root@%": p0, "root@localhost": p0, "shop@%": p0 });
        expect(envOf(engine, "shop", p0)[rootPasswordVariable(engine)]).toBe(p0);
        const r = change("shop", p0, p1, envOf(engine, "shop", p0));
        expect(r).toMatchObject({ code: 0, stdout: "" });
        // Root signed in with the container's root password, for the admin's change and then root's.
        expect(r.calls).toEqual([
          { pwd: p0, args: "-uroot" },
          { pwd: p0, args: "-uroot" },
        ]);
        expect(client.accounts()).toEqual({ "root@%": p1, "root@localhost": p1, "shop@%": p1 });
        // The next deploy gives the container the new password as root's: root and the admin sign in with it.
        const deployed = envOf(engine, "shop", p1);
        expect(client.rootSignsIn(deployed)).toBe(true);
        expect(client.adminSignsIn("shop", p1)).toBe(true);
        // And the next reset signs in as root again.
        expect(change("shop", p1, p2, deployed)).toMatchObject({ code: 0, stdout: "" });
        expect(client.accounts()).toEqual({ "root@%": p2, "root@localhost": p2, "shop@%": p2 });
      });

      test("root as the admin: both of root's accounts in one sign-in", () => {
        client.set({ "root@%": p0, "root@localhost": p0 });
        const r = change("root", p0, p1, envOf(engine, "root", p0));
        expect(r).toMatchObject({ code: 0, stdout: "" });
        expect(r.calls).toHaveLength(1);
        expect(client.accounts()).toEqual({ "root@%": p1, "root@localhost": p1 });
      });

      test("a second reset before the deploy: the container's root password is the old one, the admin's current one signs root in", () => {
        client.set({ "root@%": p1, "root@localhost": p1, "shop@%": p1 });
        const r = change("shop", p1, p2, envOf(engine, "shop", p0));
        expect(r).toMatchObject({ code: 0, stdout: "" });
        expect(r.calls.map((c) => [c.pwd, c.args])).toEqual([
          [p0, "-uroot"],
          [p1, "-uroot"],
          [p1, "-uroot"],
        ]);
        expect(client.accounts()).toEqual({ "root@%": p2, "root@localhost": p2, "shop@%": p2 });
        // Root as the admin the same way.
        client.set({ "root@%": p1, "root@localhost": p1 });
        rmSync(join(client.dir, "acct", "shop@%"));
        expect(change("root", p1, p2, envOf(engine, "root", p0))).toMatchObject({ code: 0, stdout: "" });
        expect(client.accounts()).toEqual({ "root@%": p2, "root@localhost": p2 });
      });

      test("root out of step (a reset before 0.2.11): the admin changes its own password, and the script says root kept its older one", () => {
        // The old reset changed shop@% only; the container gives root shop's password.
        client.set({ "root@%": p0, "root@localhost": p0, "shop@%": p1 });
        const env = envOf(engine, "shop", p1);
        expect(client.rootSignsIn(env)).toBe(false);
        const r = change("shop", p1, p2, env);
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe(rootUnchangedMarker);
        expect(r.stderr).toContain("ERROR 1045");
        // Root once (the admin's current password is the env's, not tried twice), then the admin over TCP.
        expect(r.calls.map((c) => [c.pwd, c.args])).toEqual([
          [p1, "-uroot"],
          [p1, "-h127.0.0.1 -ushop"],
        ]);
        expect(client.accounts()).toEqual({ "root@%": p0, "root@localhost": p0, "shop@%": p2 });
        expect(client.adminSignsIn("shop", p2)).toBe(true);
        // Once root has the new password by hand, the next reset keeps both in step again.
        client.set({ "root@%": p2, "root@localhost": p2 });
        expect(change("shop", p2, p3, envOf(engine, "shop", p2))).toMatchObject({ code: 0, stdout: "" });
        expect(client.accounts()).toEqual({ "root@%": p3, "root@localhost": p3, "shop@%": p3 });
      });

      test("root's change failing after the admin's: the admin's password changed, the script says root's did not", () => {
        // A root that signs in on the socket but whose root@% the fake refuses to change: an IF EXISTS on a
        // missing account is not an error, so a broken statement stands in for any failure there.
        client.set({ "root@%": p0, "root@localhost": p0, "shop@%": p0 });
        const exec = changePasswordExec(engine, "shop", p1, p0);
        if (!exec) throw new Error("no exec");
        const [current, forAdmin, , forSelf] = exec.stdin.split("\n");
        const r = client.run(exec.command, `${current}\n${forAdmin}\nBROKEN;\n${forSelf}\n`, envOf(engine, "shop", p0), shell);
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe(rootUnchangedMarker);
        expect(client.accounts()).toEqual({ "root@%": p0, "root@localhost": p0, "shop@%": p1 });
      });

      test("nothing signs in, or the server is down: the change fails and nothing changes", () => {
        client.set({ "root@%": p0, "root@localhost": p0, "shop@%": p0 });
        const wrong = change("shop", p3, p2, envOf(engine, "shop", p1));
        expect(wrong.code).not.toBe(0);
        expect(wrong.stdout).toBe("");
        expect(wrong.stderr.trim().split("\n").at(-1)).toContain("ERROR 1045");
        // The server down: no second try with another password or user.
        const down = client.run(changePasswordExec(engine, "shop", p1, p0)?.command ?? [], `${p0}\nSELECT 1;\n\n\n`, {
          ...envOf(engine, "shop", p0),
          FAKE_DOWN: "1",
        });
        expect(down.code).not.toBe(0);
        expect(down.stderr).toContain("ERROR 2002");
        expect(down.calls).toHaveLength(1);
        expect(client.accounts()).toEqual({ "root@%": p0, "root@localhost": p0, "shop@%": p0 });
      });
    });
  }
}

describe("databases.resetPassword on MySQL and MariaDB with an admin other than root", () => {
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

  for (const engine of ["mysql", "mariadb"] as const) {
    test(`${engine}: root keeps the admin's password, and the panel says when root could not get it`, async () => {
      const project = seedProject(panel);
      const node = seedNode(panel, { ipv4: "203.0.113.10" });
      panel.deps.db
        .update(nodes)
        .set({ facts: { capabilities: [enginesCapability] } })
        .where(eq(nodes.id, node.id))
        .run();
      const created = await callOp(
        panel,
        dbOps.create,
        { projectId: project.id, name: "shop-db", engine, nodeId: node.id, user: "shop", password: p0 },
        { cookie },
      );
      expect(created.status).toBe(200);
      const serviceId = created.body.serviceId as string;
      const client = fakeClient(engine);
      try {
        // The container's environment as the panel deploys it now.
        const deployedEnv = () => Object.fromEntries(resolveServiceEnv(panel.deps, serviceId).map((v) => [v.name, v.value]));
        let env = deployedEnv();
        expect(env[rootPasswordVariable(engine)]).toBe(p0);
        client.set({ "root@%": p0, "root@localhost": p0, "shop@%": p0 });
        // The agent's Exec runs the panel's script in the container, with the container's environment.
        const agent = fakeAgent(panel, node.id, {
          exec: (req: { command: string[]; stdin: Uint8Array }) => {
            const r = client.run(req.command, new TextDecoder().decode(req.stdin), env);
            return { exitCode: r.code, stdout: new TextEncoder().encode(r.stdout), stderr: new TextEncoder().encode(r.stderr) };
          },
        });

        const reset = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: p1 }, { cookie });
        expect(reset.status).toBe(200);
        expect(reset.body).toMatchObject({ password: p1, warning: null });
        expect(client.accounts()).toEqual({ "root@%": p1, "root@localhost": p1, "shop@%": p1 });
        // Redeployed: root signs in with the container's root password, the admin with the new one.
        env = deployedEnv();
        expect(env[rootPasswordVariable(engine)]).toBe(p1);
        expect(client.rootSignsIn(env)).toBe(true);
        expect(client.adminSignsIn("shop", p1)).toBe(true);

        // A database that an older panel's reset left with root on its first password.
        client.set({ "root@%": p0, "root@localhost": p0 });
        const kept = await callOp(panel, dbOps.resetPassword, { serviceId, user: "internal", password: p2 }, { cookie });
        expect(kept.status).toBe(200);
        expect(kept.body.password).toBe(p2);
        const label = engine === "mysql" ? "MySQL" : "MariaDB";
        expect(kept.body.warning).toContain(`The password of shop changed, but ${label}'s root user kept an older password`);
        expect(kept.body.warning).toContain(rootPasswordVariable(engine));
        expect(kept.body.warning).not.toContain(p2);
        expect(client.accounts()).toEqual({ "root@%": p0, "root@localhost": p0, "shop@%": p2 });
        // The new password is stored: the connection gives it, and the admin signs in with it.
        expect((await callOp(panel, dbOps.connection, { serviceId }, { cookie })).body.internal.password).toBe(p2);
        expect(client.adminSignsIn("shop", p2)).toBe(true);
        agent.disconnect();
      } finally {
        client.close();
      }
    });
  }
});
