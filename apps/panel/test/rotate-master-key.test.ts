// scripts/rotate-master-key.ts on a seeded data dir: every sealed value
// (columns and sealed fields inside settings) opens with the new key only;
// with --new-panel-identity the edge ticket key, LB CA and agents' TLS key
// are made anew and the nodes to re-join are listed with their exact
// `seylo join` commands (the new pin in them), with --keep-panel-identity
// they are sealed again and stay; the script refuses to run without exactly
// one of the two; recovery codes are cleared with their owners listed; a
// wrong key, a failed or an interrupted run never loses secrets.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { githubOrg, githubRepo, installUrl } from "@seylo/brand";
import { eq } from "drizzle-orm";
import { issueRecoveryCodes } from "../src/auth/second-factor";
import { loadConfig } from "../src/config";
import { openDatabases } from "../src/db/client";
import { gitCredentials, nodes, recoveryCodes, settings, users } from "../src/db/schema";
import { ensureAgentTls } from "../src/security/agent-tls";
import { ensureEdgeTicketKey } from "../src/security/edge-ticket-key";
import { loadMasterKey } from "../src/security/master-key";
import { RotationError, rotateMasterKey } from "../src/security/rotate-master-key";
import { createSecretBox } from "../src/security/secret-box";
import { ensurePanelId, setSetting } from "../src/settings";

const migrationsDir = loadConfig({}, resolve(import.meta.dir, "..")).migrationsDir;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rotate-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function open() {
  return openDatabases({ panelPath: join(dir, "panel.db"), metricsPath: join(dir, "metrics.db"), migrationsDir });
}

/**
 * A data dir with a git token, a sealed setting, the edge ticket key and
 * recovery codes; with `agentTls` also the agents' TLS key and the ports the
 * installed panel stores (host port 3000, agents' TLS port 3443).
 */
function seed(options: { agentTls?: boolean } = {}) {
  const key = loadMasterKey(join(dir, "master.key"), true);
  const secrets = createSecretBox(key);
  const dbs = open();
  const user = dbs.db.insert(users).values({ email: "owner@example.com", name: "Owner", role: "owner" }).returning().get();
  dbs.db
    .insert(gitCredentials)
    .values({ name: "pat", kind: "token", host: "github.com", secretSealed: secrets.seal("ghp_secret", "git.credential") })
    .run();
  setSetting(dbs.db, "lbTlsCa", { certPem: "-", keySealed: secrets.seal("ca-key", "lb.key"), notAfter: 1 });
  ensureEdgeTicketKey(dbs.db, secrets);
  issueRecoveryCodes(dbs.db, secrets, user.id);
  const key32 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  dbs.db.insert(nodes).values({ name: "edge-1", publicKey: key32(), publicIpv4: "203.0.113.7", isPanelNode: true, canBuild: true }).run();
  dbs.db.insert(nodes).values({ name: "worker-2", publicKey: key32(), publicAddress: "worker-2.example.com" }).run();
  dbs.db.insert(nodes).values({ name: "retired", publicKey: key32(), disabledAt: new Date() }).run();
  if (options.agentTls) {
    setSetting(dbs.db, "panelHostPort", 3000);
    setSetting(dbs.db, "panelAgentTlsPort", 3443);
  }
  dbs.close();
  const pin = options.agentTls ? ensureAgentTls(dir, 3443).pin : null;
  return { key, secrets, pin };
}

const file = (name: string) => join(dir, name);
const read = (name: string) => readFileSync(file(name), "utf8");

test("--new-panel-identity: every sealed value moves to the new key and the identity keys are made anew", () => {
  const { key: oldKey, secrets: oldBox } = seed();
  const before = open();
  const stored = before.db.select().from(settings).where(eq(settings.key, "edgeTicketKey")).get();
  const edgeKeyBefore = (stored?.value as { publicKey: string } | undefined)?.publicKey;
  expect(edgeKeyBefore).toBeDefined();
  const panelId = ensurePanelId(before.db);
  before.close();

  const result = rotateMasterKey(dir, { panelIdentity: "new" });
  expect(result.resumed).toBe(false);
  expect(result.rejoin?.nodes).toEqual([
    { name: "edge-1", address: "203.0.113.7", panelNode: true, canBuild: true },
    { name: "worker-2", address: "worker-2.example.com", panelNode: false, canBuild: false },
  ]);
  expect(result.resealed["git_credentials.secret_sealed"]).toBe(1);
  expect(result.recoveryCodesCleared).toEqual(["owner@example.com"]);
  expect(existsSync(join(dir, "master.key.new"))).toBe(false);

  const newKey = loadMasterKey(join(dir, "master.key"), false);
  expect(Buffer.from(newKey).equals(Buffer.from(oldKey))).toBe(false);
  const newBox = createSecretBox(newKey);
  const after = open();
  const token = after.db.select().from(gitCredentials).get()?.secretSealed as string;
  expect(newBox.open(token, "git.credential")).toBe("ghp_secret");
  expect(oldBox.open(token, "git.credential")).toBeNull();
  // The LB CA and edge ticket key are gone; the next start makes a new edge key.
  expect(after.db.select().from(settings).where(eq(settings.key, "lbTlsCa")).get()).toBeUndefined();
  expect(after.db.select().from(recoveryCodes).all()).toHaveLength(0);
  const edgeAfter = ensureEdgeTicketKey(after.db, newBox);
  expect(Buffer.from(edgeAfter.publicKey).toString("base64")).not.toBe(edgeKeyBefore);
  // Only the key changes: the panel id nodes also remember stays.
  expect(ensurePanelId(after.db)).toBe(panelId);
  after.close();
});

test("sealed fields inside settings are sealed again too", () => {
  const { secrets } = seed();
  const dbs = open();
  setSetting(dbs.db, "lbTlsNodes", {}); // regenerated, but other settings keep their values
  dbs.db
    .insert(settings)
    .values({ key: "testNested", value: { list: [{ tokenSealed: secrets.seal("nested", "git.provider") }] } })
    .run();
  dbs.close();
  rotateMasterKey(dir, { panelIdentity: "new" });
  const newBox = createSecretBox(loadMasterKey(join(dir, "master.key"), false));
  const after = open();
  const nested = after.db.select().from(settings).where(eq(settings.key, "testNested")).get()?.value as {
    list: { tokenSealed: string }[];
  };
  expect(newBox.open(nested.list[0]?.tokenSealed as string, "git.provider")).toBe("nested");
  after.close();
});

test("a key that does not match the database changes nothing", () => {
  seed();
  const keyPath = join(dir, "master.key");
  const wrong = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const right = readFileSync(keyPath, "utf8");
  writeFileSync(keyPath, `${wrong}\n`);
  expect(() => rotateMasterKey(dir, { panelIdentity: "new" })).toThrow(RotationError);
  writeFileSync(keyPath, right);
  const box = createSecretBox(loadMasterKey(keyPath, false));
  const dbs = open();
  expect(box.open(dbs.db.select().from(gitCredentials).get()?.secretSealed as string, "git.credential")).toBe("ghp_secret");
  expect(existsSync(`${keyPath}.new`)).toBe(false);
  dbs.close();
});

test("a run interrupted after the commit is finished by the next run", () => {
  seed();
  const keyPath = join(dir, "master.key");
  const oldText = readFileSync(keyPath, "utf8");
  rotateMasterKey(dir, { panelIdentity: "new" });
  // As if the process died between the commit and replacing master.key.
  writeFileSync(`${keyPath}.new`, readFileSync(keyPath, "utf8"));
  writeFileSync(keyPath, oldText);
  expect(rotateMasterKey(dir, { panelIdentity: "new" }).resumed).toBe(true);
  const box = createSecretBox(loadMasterKey(keyPath, false));
  const dbs = open();
  expect(box.open(dbs.db.select().from(gitCredentials).get()?.secretSealed as string, "git.credential")).toBe("ghp_secret");
  dbs.close();
});

test("the owner keeps their account", () => {
  seed();
  rotateMasterKey(dir, { panelIdentity: "keep" });
  const dbs = open();
  expect(dbs.db.select().from(users).where(eq(users.email, "owner@example.com")).get()).toBeDefined();
  dbs.close();
});

test("--keep-panel-identity: the edge ticket key and LB CA are sealed again and stay the same", () => {
  const { secrets: oldBox } = seed();
  const before = open();
  const edgeBefore = ensureEdgeTicketKey(before.db, oldBox);
  before.close();

  const result = rotateMasterKey(dir, { panelIdentity: "keep" });
  expect(result.rejoin).toBeNull();
  const newBox = createSecretBox(loadMasterKey(join(dir, "master.key"), false));
  const after = open();
  // Same key pair, now readable with the new master key only.
  const edgeAfter = ensureEdgeTicketKey(after.db, newBox);
  expect(Buffer.from(edgeAfter.publicKey).equals(Buffer.from(edgeBefore.publicKey))).toBe(true);
  const stored = after.db.select().from(settings).where(eq(settings.key, "edgeTicketKey")).get()?.value as { privateKeySealed: string };
  expect(oldBox.open(stored.privateKeySealed, "edge.ticket-key")).toBeNull();
  const ca = after.db.select().from(settings).where(eq(settings.key, "lbTlsCa")).get()?.value as { keySealed: string };
  expect(newBox.open(ca.keySealed, "lb.key")).toBe("ca-key");
  expect(after.db.select().from(recoveryCodes).all()).toHaveLength(0);
  after.close();
});

test("--new-panel-identity replaces the agents' TLS key; its certificate is made again on the next start", () => {
  const { pin: oldPin } = seed({ agentTls: true });
  const oldKey = read("agent-tls.key");
  const result = rotateMasterKey(dir, { panelIdentity: "new" });
  expect(read("agent-tls.key")).not.toBe(oldKey);
  // The old certificate wrapped the old key: gone, so the panel's start makes one for the new key.
  expect(existsSync(file("agent-tls.crt"))).toBe(false);
  expect(existsSync(file("agent-tls.key.new"))).toBe(false);
  const tls = ensureAgentTls(dir, 3443);
  expect(tls.pin).not.toBe(oldPin);
  expect(result.agentTlsPin).toBe(tls.pin);
  // The re-join target is the Add node dialog's, with the new pin.
  expect(result.rejoin?.target).toEqual({ url: "https://203.0.113.7:3443", pin: tls.pin, insecureTransport: false });
  expect(result.rejoin?.localUrl).toBe("http://127.0.0.1:3000");
});

test("--keep-panel-identity leaves the agents' TLS key and certificate alone", () => {
  const { pin } = seed({ agentTls: true });
  const key = read("agent-tls.key");
  const cert = read("agent-tls.crt");
  const result = rotateMasterKey(dir, { panelIdentity: "keep" });
  expect(result.agentTlsPin).toBeNull();
  expect(read("agent-tls.key")).toBe(key);
  expect(read("agent-tls.crt")).toBe(cert);
  expect(ensureAgentTls(dir, 3443).pin).toBe(pin as string);
});

test("the count leaves out the identity keys a new identity drops", () => {
  seed();
  const result = rotateMasterKey(dir, { panelIdentity: "new" });
  // The edge ticket key and LB CA in settings are deleted, not sealed again.
  expect(result.resealed).toEqual({ "git_credentials.secret_sealed": 1 });
});

test("a failed run leaves the old keys and no new key files", () => {
  seed({ agentTls: true });
  const dbs = open();
  // A value no purpose of this master.key opens: the run must stop with nothing changed.
  const stranger = createSecretBox(crypto.getRandomValues(new Uint8Array(32)));
  dbs.db
    .insert(gitCredentials)
    .values({ name: "foreign", kind: "token", host: "gitlab.com", secretSealed: stranger.seal("x", "git.credential") })
    .run();
  dbs.close();
  const before = { master: read("master.key"), tls: read("agent-tls.key"), cert: read("agent-tls.crt") };
  expect(() => rotateMasterKey(dir, { panelIdentity: "new" })).toThrow(RotationError);
  expect({ master: read("master.key"), tls: read("agent-tls.key"), cert: read("agent-tls.crt") }).toEqual(before);
  expect(existsSync(file("master.key.new"))).toBe(false);
  expect(existsSync(file("agent-tls.key.new"))).toBe(false);
});

test("a new-identity run cut off after the commit is finished by the next run, the agents' TLS key included", () => {
  seed({ agentTls: true });
  const old = { master: read("master.key"), tls: read("agent-tls.key"), cert: read("agent-tls.crt") };
  rotateMasterKey(dir, { panelIdentity: "new" });
  const fresh = { master: read("master.key"), tls: read("agent-tls.key") };
  // As if the process died after the commit, before any file was replaced.
  writeFileSync(file("master.key.new"), fresh.master);
  writeFileSync(file("agent-tls.key.new"), fresh.tls);
  writeFileSync(file("master.key"), old.master);
  writeFileSync(file("agent-tls.key"), old.tls);
  writeFileSync(file("agent-tls.crt"), old.cert);
  // Whatever flag the next run has, it finishes and still lists the re-joins.
  const result = rotateMasterKey(dir, { panelIdentity: "keep" });
  expect(result.resumed).toBe(true);
  expect({ master: read("master.key"), tls: read("agent-tls.key") }).toEqual(fresh);
  expect(existsSync(file("agent-tls.crt"))).toBe(false);
  expect(existsSync(file("master.key.new"))).toBe(false);
  expect(existsSync(file("agent-tls.key.new"))).toBe(false);
  expect(result.rejoin?.target?.pin).toBe(ensureAgentTls(dir, 3443).pin);
});

test("a run cut off before the commit is undone by the next run, which rotates from the old key", () => {
  seed({ agentTls: true });
  const tls = read("agent-tls.key");
  writeFileSync(file("master.key.new"), `${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64")}\n`);
  writeFileSync(file("agent-tls.key.new"), "-");
  const result = rotateMasterKey(dir, { panelIdentity: "keep" });
  expect(result.resumed).toBe(false);
  expect(read("agent-tls.key")).toBe(tls);
  expect(existsSync(file("agent-tls.key.new"))).toBe(false);
  const box = createSecretBox(loadMasterKey(file("master.key"), false));
  const dbs = open();
  expect(box.open(dbs.db.select().from(gitCredentials).get()?.secretSealed as string, "git.credential")).toBe("ghp_secret");
  dbs.close();
});

test("a value sealed with the old key after the commit does not make the next run throw the commit away", () => {
  const { secrets: oldBox } = seed();
  const oldText = read("master.key");
  rotateMasterKey(dir, { panelIdentity: "keep" });
  const newText = read("master.key");
  writeFileSync(file("master.key.new"), newText);
  writeFileSync(file("master.key"), oldText);
  // A panel started on the old key wrote the first sealed column value again.
  const dbs = open();
  dbs.db
    .update(gitCredentials)
    .set({ secretSealed: oldBox.seal("rewritten", "git.credential") })
    .run();
  dbs.close();
  expect(rotateMasterKey(dir, { panelIdentity: "keep" }).resumed).toBe(true);
  expect(read("master.key")).toBe(newText);
  // The settings sealed in the committed run still open.
  const after = open();
  const ca = after.db.select().from(settings).where(eq(settings.key, "lbTlsCa")).get()?.value as { keySealed: string };
  expect(createSecretBox(loadMasterKey(file("master.key"), false)).open(ca.keySealed, "lb.key")).toBe("ca-key");
  after.close();
});

/** The panel node's stored address is no valid host: the Add node URL cannot be worked out. */
function breakJoinUrl() {
  const dbs = open();
  dbs.db.update(nodes).set({ publicAddress: "not a host" }).where(eq(nodes.isPanelNode, true)).run();
  dbs.close();
}

test("a join URL that cannot be worked out does not fail the rotation; the plan says why", () => {
  seed({ agentTls: true });
  breakJoinUrl();
  const old = { master: read("master.key"), tls: read("agent-tls.key") };
  const result = rotateMasterKey(dir, { panelIdentity: "new" });
  expect(result.rejoin?.target).toBeNull();
  expect(result.rejoin?.targetError).toBeTruthy();
  expect(result.rejoin?.nodes.map((n) => n.name)).toEqual(["edge-1", "worker-2"]);
  expect(result.rejoin?.localUrl).toBe("http://127.0.0.1:3000");
  expect(read("master.key")).not.toBe(old.master);
  expect(read("agent-tls.key")).not.toBe(old.tls);
  expect(existsSync(file("master.key.new"))).toBe(false);
  expect(existsSync(file("agent-tls.key.new"))).toBe(false);
  const box = createSecretBox(loadMasterKey(file("master.key"), false));
  const dbs = open();
  expect(box.open(dbs.db.select().from(gitCredentials).get()?.secretSealed as string, "git.credential")).toBe("ghp_secret");
  dbs.close();
});

describe("the script", () => {
  const script = resolve(import.meta.dir, "../scripts/rotate-master-key.ts");
  const run = (...args: string[]) => runWith({}, ...args);
  const runWith = (env: Record<string, string>, ...args: string[]) => {
    const out = Bun.spawnSync(["bun", script, ...args], { env: { ...process.env, SEYLO_DATA_DIR: dir, ...env } });
    return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
  };

  test("refuses without exactly one identity flag and changes nothing", () => {
    seed();
    const keyBefore = readFileSync(join(dir, "master.key"), "utf8");
    for (const args of [[], ["--new-panel-identity", "--keep-panel-identity"], ["--yes"]]) {
      const out = run(...args);
      expect({ args, code: out.code }).toEqual({ args, code: 2 });
      expect(out.stderr).toContain("--new-panel-identity");
      expect(out.stderr).toContain("join --force");
    }
    expect(readFileSync(join(dir, "master.key"), "utf8")).toBe(keyBefore);
  });

  test("--new-panel-identity lists the nodes with the exact re-join command for each, the new pin in it", () => {
    seed({ agentTls: true });
    const out = run("--new-panel-identity");
    expect(out.code).toBe(0);
    const pin = ensureAgentTls(dir, 3443).pin;
    expect(out.stdout).toContain(`The agents' TLS key was replaced too; its new pin is ${pin}.`);
    expect(out.stdout).toContain("Nodes > Add node");
    // The panel's own node joins on loopback as the installer set it up; the others over the TLS port.
    expect(out.stdout).toContain(
      "  edge-1  203.0.113.7  (runs the panel)\n    sudo seylo join http://127.0.0.1:3000 --token '<token>' --can-build --force\n",
    );
    expect(out.stdout).toContain(
      `  worker-2  worker-2.example.com\n    sudo seylo join 'https://203.0.113.7:3443' --token '<token>' --pin '${pin}' --force\n`,
    );
    expect(out.stdout).not.toContain("retired");
    expect(out.stdout).not.toContain("install.seylo.dev");
    expect(out.stdout).toContain("Start the agent now (`sudo systemctl start seylo`); it starts the panel.");
  });

  test("a join URL it cannot work out: exit 0, the new pin, and the Add node dialog named for the URL", () => {
    seed({ agentTls: true });
    breakJoinUrl();
    const oldKey = read("master.key");
    const out = run("--new-panel-identity");
    expect(out.code).toBe(0);
    expect(read("master.key")).not.toBe(oldKey);
    const pin = ensureAgentTls(dir, 3443).pin;
    expect(out.stdout).toContain(`its new pin is ${pin}.`);
    expect(out.stdout).toContain("The panel's join URL could not be worked out here (");
    expect(out.stdout).toContain("Take <url> and <pin> from\nthe command Nodes > Add node shows (leave out --pin when it has none)");
    expect(out.stdout).toContain(
      "  edge-1  not a host  (runs the panel)\n    sudo seylo join http://127.0.0.1:3000 --token '<token>' --can-build --force\n",
    );
    expect(out.stdout).toContain("  worker-2  worker-2.example.com\n    sudo seylo join '<url>' --token '<token>' --pin '<pin>' --force\n");
  });

  test("the count it prints leaves out the dropped identity keys", () => {
    seed();
    const out = run("--new-panel-identity");
    expect(out.stdout).toContain("New master.key written; 1 sealed value sealed again:\n  git_credentials.secret_sealed: 1\n");
  });

  test("a fresh install whose only sealed values are the identity keys: no count and no colon left hanging", () => {
    const secrets = createSecretBox(loadMasterKey(join(dir, "master.key"), true));
    const dbs = open();
    dbs.db.insert(users).values({ email: "owner@example.com", name: "Owner", role: "owner" }).run();
    setSetting(dbs.db, "lbTlsCa", { certPem: "-", keySealed: secrets.seal("ca-key", "lb.key"), notAfter: 1 });
    ensureEdgeTicketKey(dbs.db, secrets);
    dbs.close();
    const out = run("--new-panel-identity", "--from-cli");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(
      "New master.key written; no other sealed values to seal again.\nThe panel makes a new edge ticket key and load balancer CA when it starts",
    );
    expect(out.stdout).not.toContain("sealed again:");
    expect(out.stdout).not.toContain("0 sealed");
  });

  test("the printed re-join commands keep the node's agent: no installer, so never the install host's latest", () => {
    seed({ agentTls: true });
    const out = runWith({ SEYLO_VERSION: "0.2.0-rc.2" }, "--new-panel-identity");
    expect(out.code).toBe(0);
    // A joined node has the CLI already; `seylo join --force` re-joins without installing another
    // release's agent. New nodes get the panel's own release from the Add node dialog (join-command.ts).
    expect(out.stdout).toContain("    sudo seylo join 'https://203.0.113.7:3443' --token '<token>' --pin '");
    expect(out.stdout).not.toContain(installUrl);
    expect(out.stdout).not.toContain(`github.com/${githubOrg}/${githubRepo}/releases`);
    expect(out.stdout).not.toContain("curl ");
  });

  test("--keep-panel-identity says nodes keep working", () => {
    seed();
    const out = run("--keep-panel-identity");
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("nodes keep working");
    expect(out.stdout).not.toContain("--force");
  });

  test("--from-cli (seylo panel rotate-key) leaves out the start step the command does itself", () => {
    seed();
    const out = run("--keep-panel-identity", "--from-cli");
    expect(out.code).toBe(0);
    expect(out.stdout).not.toContain("systemctl start");
    expect(out.stdout).toContain("Delete old copies of the data dir");
    expect(run("--from-cli").code).toBe(2);
  });
});
