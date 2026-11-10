// Replaces master.key after a leak: every sealed value in panel.db is
// opened with the old key and sealed again with a new one in one
// transaction. What happens to the panel's identity is the caller's choice,
// because it decides whether nodes keep working:
//
// - "new" (panel.db leaked, usually together with master.key in a backup of
//   the data dir): the edge ticket key and the load balancer CA and node
//   certificates are dropped and the panel makes new ones on its next start.
//   The leaked edge key could otherwise mint DB web UI, Box and status
//   tickets and prove itself as this panel to nodes. The agents' TLS key
//   (agent-tls.key, which nodes pin on the agents' TLS port) sits in the
//   same copy, so it is replaced too and its certificate made again on the
//   next start: whoever has the copy could otherwise present the pinned key
//   and relay agent traffic. Nodes pin both keys on their first connect and
//   refuse a panel with other ones, so every node must be joined again
//   (`seylo join --force` with a token from Nodes > Add node and the new
//   pin); the panel id stays the same.
// - "keep" (only master.key leaked, panel.db never did): the edge key was
//   never exposed, so it and the LB CA are sealed again like every other
//   value, agent-tls.key stays, and nodes keep working.
//
// Recovery codes are keyed hashes under the old key and cannot be carried
// over in either case: they are deleted and the people who had them are
// listed, so they make new ones.
//
// Run it with the panel stopped. It holds panel.db's write lock from
// before the new key files exist until the database commit. New key files
// wait as master.key.new and agent-tls.key.new until that commit; then
// agent-tls.crt goes, agent-tls.key.new replaces agent-tls.key, and
// master.key.new replaces master.key last. A failed run removes the new
// files. A run killed half way leaves master.key.new: the next run, and the
// panel's start (finishInterruptedRotation, which waits for the lock),
// finish the rotation when panel.db is already sealed with it, and
// otherwise remove the leftovers, as the run never committed: the panel
// then starts on the old key, and a new run rotates from it.

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Config } from "../config";
import * as schema from "../db/schema";
import { agentJoinTarget, type JoinTarget } from "../modules/nodes/join-target";
import { getSetting } from "../settings";
import { agentTlsFiles, agentTlsPinOf, newAgentTlsKey } from "./agent-tls";
import { loadMasterKey } from "./master-key";
import { createSecretBox, type SealPurpose, type SecretBox, sealPurposes } from "./secret-box";

/** `v1.<12-byte iv>.<16-byte tag>.<ciphertext>`, all base64url (secret-box.ts). */
const sealedPattern = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/;
/**
 * Settings that hold the panel's identity keys; with "new" the panel makes
 * new ones on start (the push key when push is next used).
 */
const identitySettings = ["edgeTicketKey", "lbTlsCa", "lbTlsNodes", "pushVapid"];
/**
 * Rows a leaked panel.db makes dangerous to keep, dropped with "new": push
 * devices hold each browser's endpoint and secret, which with the old push
 * key would let whoever has the copy send notifications to people's phones.
 * People turn push on again on each device.
 */
const identityTables = ["push_devices"];
/** How long a rotation waits for panel.db's write lock (a panel's start check may hold it). */
const rotationLockWaitMs = 5_000;
/** How long the panel's start waits for a rotation still running to commit. */
const startLockWaitMs = 60_000;

export type PanelIdentity = "new" | "keep";

/** The panel's ports as its environment gives them; unset ones come from the stored settings. */
export type RotationConfig = Pick<Config, "hostPort" | "agentTlsPort" | "port" | "host">;

export interface RotationOptions {
  panelIdentity: PanelIdentity;
  /** The rotation container has none of the panel's port variables: the settings the panel stored stand in. */
  config?: RotationConfig;
}

/** A node that must be joined again after a "new" rotation. */
export interface RejoinNode {
  name: string;
  /** Public address, public IPv4 or IPv6, or null when the panel never learned one. */
  address: string | null;
  panelNode: boolean;
  canBuild: boolean;
}

/** Who joins again after a "new" rotation, and where. */
export interface RejoinPlan {
  /** Every enabled node, the panel's own first. */
  nodes: RejoinNode[];
  /** The Add node dialog's URL and trust with the new keys (pin = the new agents' TLS pin); null when it could not be worked out. */
  target: JoinTarget | null;
  /** Why `target` is null. */
  targetError: string | null;
  /** The panel node's own agent joins on loopback, as the installer set it up. */
  localUrl: string;
}

export interface RotationResult {
  /** Sealed values sealed again, by "table.column"; identity keys a "new" rotation drops are not counted. */
  resealed: Record<string, number>;
  /** Emails of people whose recovery codes were deleted. */
  recoveryCodesCleared: string[];
  /** True when the run only finished an earlier, interrupted rotation. */
  resumed: boolean;
  /** The agents' TLS pin when this run replaced the key, else null. */
  agentTlsPin: string | null;
  /** With a new identity (or when finishing one): who re-joins and how; null when nodes keep working. */
  rejoin: RejoinPlan | null;
}

export class RotationError extends Error {
  override name = "RotationError";
}

interface Paths {
  db: string;
  key: string;
  next: string;
  tlsKey: string;
  tlsNext: string;
  tlsCert: string;
}

function pathsIn(dataDir: string): Paths {
  const key = join(dataDir, "master.key");
  const tlsKey = join(dataDir, agentTlsFiles.key);
  return {
    db: join(dataDir, "panel.db"),
    key,
    next: `${key}.new`,
    tlsKey,
    tlsNext: `${tlsKey}.new`,
    tlsCert: join(dataDir, agentTlsFiles.cert),
  };
}

export function rotateMasterKey(dataDir: string, options: RotationOptions): RotationResult {
  const paths = pathsIn(dataDir);
  if (!existsSync(paths.db)) throw new RotationError(`${paths.db} does not exist.`);
  const sqlite = new Database(paths.db);
  try {
    sqlite.exec(`PRAGMA busy_timeout = ${rotationLockWaitMs}`);
    const oldKey = loadMasterKey(paths.key, false);
    // panel.db's write lock is held from before master.key.new exists until
    // the commit: the panel's start check (finishInterruptedRotation) waits
    // for it, so it never removes the new key of a rotation still running.
    sqlite.exec("BEGIN IMMEDIATE");
    let result: RotationResult;
    try {
      if (settleInterrupted(sqlite, paths) === "committed") {
        // An earlier run committed but did not replace master.key yet. Nodes
        // re-join when it dropped the identity, whichever flag this run has.
        const dropped = getSetting(drizzle({ client: sqlite, schema }), "edgeTicketKey") === undefined;
        const tlsKey = existsSync(paths.tlsNext) ? paths.tlsNext : paths.tlsKey;
        const rejoin = dropped ? rejoinPlan(sqlite, options.config, () => agentTlsPinOf(tlsKey)) : null;
        finishFiles(paths);
        return { resealed: {}, recoveryCodesCleared: [], resumed: true, agentTlsPin: null, rejoin };
      }
      result = resealAndCommit(sqlite, paths, oldKey, options);
    } finally {
      if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    }
    // Committed. The re-join plan was made before the commit, so only the
    // checkpoint and the file moves are left; master.key goes last.
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    finishFiles(paths);
    return result;
  } finally {
    sqlite.close();
  }
}

/** The rotation itself, inside the write transaction rotateMasterKey began; ends with the commit. */
function resealAndCommit(sqlite: Database, paths: Paths, oldKey: Uint8Array, options: RotationOptions): RotationResult {
  const before = createSecretBox(oldKey);
  const first = firstSealed(sqlite);
  if (first !== undefined && !opensWith(first, before)) {
    throw new RotationError("master.key does not open the sealed values in panel.db. Restore the matching key first.");
  }
  const newKey = crypto.getRandomValues(new Uint8Array(32));
  const after = createSecretBox(newKey);
  const fresh = options.panelIdentity === "new";
  const result: RotationResult = { resealed: {}, recoveryCodesCleared: [], resumed: false, agentTlsPin: null, rejoin: null };
  try {
    writeFileSync(paths.next, `${Buffer.from(newKey).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(paths.next, 0o600);
    // A panel with the agents' TLS port on always has the key; one without
    // it may still have one from before it was turned off.
    if (fresh && (existsSync(paths.tlsKey) || storedAgentTlsPort(sqlite, options.config) !== null)) {
      const tls = newAgentTlsKey();
      writeFileSync(paths.tlsNext, tls.keyPem, { mode: 0o600, flag: "wx" });
      chmodSync(paths.tlsNext, 0o600);
      result.agentTlsPin = tls.pin;
    }
    // Dropped first, so the count only has what the panel keeps.
    if (fresh) for (const key of identitySettings) sqlite.query("DELETE FROM settings WHERE key = ?").run(key);
    // A panel.db from before the table existed has nothing to drop.
    const hasTable = (table: string) => sqlite.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
    if (fresh) for (const table of identityTables) if (hasTable(table)) sqlite.query(`DELETE FROM "${table}"`).run();
    for (const { table, column } of textColumns(sqlite)) {
      const rows = sqlite
        .query<{ id: number; value: string }, []>(
          `SELECT rowid AS id, "${column}" AS value FROM "${table}" WHERE ${candidateFilter(column)}`,
        )
        .all();
      for (const row of rows) {
        const { value, count } = resealText(row.value, before, after, `${table}.${column}`);
        if (count === 0) continue;
        sqlite.query(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`).run(value, row.id);
        result.resealed[`${table}.${column}`] = (result.resealed[`${table}.${column}`] ?? 0) + count;
      }
    }
    result.recoveryCodesCleared = sqlite
      .query<{ email: string }, []>(
        "SELECT DISTINCT users.email AS email FROM recovery_codes JOIN users ON users.id = recovery_codes.user_id ORDER BY users.email",
      )
      .all()
      .map((r) => r.email);
    sqlite.exec("DELETE FROM recovery_codes");
    // Before the commit: once the keys are replaced, an error here would
    // report a finished rotation as failed.
    if (fresh) result.rejoin = rejoinPlan(sqlite, options.config, () => result.agentTlsPin);
    sqlite.exec("COMMIT");
  } catch (error) {
    // Nothing was committed: the old keys stay and the new files go.
    rmSync(paths.tlsNext, { force: true });
    rmSync(paths.next, { force: true });
    if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    throw error;
  }
  return result;
}

/** What the panel's start found of a master-key rotation that did not finish. */
export type LeftoverRotation = "none" | "finished" | "removed";

/**
 * The panel's start-up check for a rotation that did not finish
 * (master.key.new left behind). It waits for panel.db's write lock, which a
 * rotation holds from writing master.key.new until its commit, so what it
 * finds belongs to a run that ended. "finished": panel.db is sealed with
 * master.key.new, so the rotation is completed (starting on the old key
 * would leave every secret unreadable). "removed": nothing in panel.db
 * opens with it, so the run never committed (or an rc.1 run failed and left
 * it); the new files are removed and the panel keeps the old key.
 */
export function finishInterruptedRotation(dataDir: string): LeftoverRotation {
  const paths = pathsIn(dataDir);
  if (!existsSync(paths.next) || !existsSync(paths.db)) return "none";
  const sqlite = new Database(paths.db);
  try {
    sqlite.exec(`PRAGMA busy_timeout = ${startLockWaitMs}`);
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const settled = settleInterrupted(sqlite, paths);
      if (settled !== "committed") return settled;
      finishFiles(paths);
      return "finished";
    } finally {
      if (sqlite.inTransaction) sqlite.exec("ROLLBACK");
    }
  } finally {
    sqlite.close();
  }
}

/**
 * Files an earlier run left, with panel.db's write lock held: "committed"
 * when the database is sealed with master.key.new (the caller finishes the
 * files), "removed" when it is not (the run never committed: the new files
 * are removed), "none" without master.key.new.
 */
function settleInterrupted(sqlite: Database, paths: Paths): "none" | "committed" | "removed" {
  if (!existsSync(paths.next)) {
    // Never left without master.key.new by a run (see finishFiles): stray.
    rmSync(paths.tlsNext, { force: true });
    return "none";
  }
  const pending = createSecretBox(loadMasterKey(paths.next, false));
  if (committedWith(sqlite, pending)) return "committed";
  rmSync(paths.tlsNext, { force: true });
  rmSync(paths.next);
  return "removed";
}

/**
 * After the commit. master.key.new goes last, so a crash in between is
 * finished by the next run or start. A file already moved was moved by the
 * panel's start check, which may run right after the commit.
 */
function finishFiles(paths: Paths): void {
  if (existsSync(paths.tlsNext)) {
    // The certificate wraps the old key: the panel makes one for the new key on start.
    rmSync(paths.tlsCert, { force: true });
    renameIfThere(paths.tlsNext, paths.tlsKey);
  }
  renameIfThere(paths.next, paths.key);
}

function renameIfThere(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Whether the rotation to `pending` committed: any sealed value opens with
 * it (the key is new, so nothing before the commit was sealed with it), or
 * nothing is sealed at all (then either key reads the database).
 */
function committedWith(sqlite: Database, pending: SecretBox): boolean {
  let any = false;
  for (const sealed of sealedValues(sqlite)) {
    any = true;
    if (opensWith(sealed, pending)) return true;
  }
  return !any;
}

function storedAgentTlsPort(sqlite: Database, config: RotationConfig | undefined): number | null {
  return config?.agentTlsPort ?? getSetting(drizzle({ client: sqlite, schema }), "panelAgentTlsPort") ?? null;
}

/**
 * The nodes to join again and the commands' URL and pin, as the Add node
 * dialog will show them. When the URL cannot be worked out (a stored
 * address that is no valid host, say) `target` is null and `targetError`
 * says why: the rotation is not failed for it.
 */
function rejoinPlan(sqlite: Database, config: RotationConfig | undefined, pin: () => string | null): RejoinPlan {
  const db = drizzle({ client: sqlite, schema });
  const nodes = sqlite
    .query<{ name: string; address: string | null; panelNode: number; canBuild: number }, []>(
      "SELECT name, coalesce(public_address, public_ipv4, public_ipv6) AS address, is_panel_node AS panelNode, can_build AS canBuild FROM nodes WHERE disabled_at IS NULL ORDER BY is_panel_node DESC, name",
    )
    .all()
    .map((n) => ({ name: n.name, address: n.address, panelNode: n.panelNode === 1, canBuild: n.canBuild === 1 }));
  const port = config?.port ?? 3000;
  let hostPort = config?.hostPort ?? null;
  try {
    hostPort ??= getSetting(db, "panelHostPort") ?? null;
    const tlsPort = storedAgentTlsPort(sqlite, config);
    const tlsPin = tlsPort === null ? null : pin();
    // Without the pin the target would fall back to plain HTTP: a wrong command.
    if (tlsPort !== null && !tlsPin) throw new Error("the agents' TLS key could not be read");
    const target = agentJoinTarget({
      db,
      config: { hostPort, port, host: config?.host ?? "0.0.0.0" },
      agentTls: tlsPort !== null && tlsPin ? { port: tlsPort, pin: tlsPin } : null,
    });
    return { nodes, target, targetError: null, localUrl: `http://127.0.0.1:${hostPort ?? port}` };
  } catch (error) {
    const targetError = error instanceof Error ? error.message : String(error);
    return { nodes, target: null, targetError, localUrl: `http://127.0.0.1:${hostPort ?? port}` };
  }
}

function textColumns(sqlite: Database): { table: string; column: string }[] {
  const tables = sqlite
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'",
    )
    .all();
  const out: { table: string; column: string }[] = [];
  for (const { name } of tables) {
    for (const col of sqlite.query<{ name: string; type: string }, []>(`PRAGMA table_info("${name}")`).all()) {
      if (/text|blob|^$/i.test(col.type)) out.push({ table: name, column: col.name });
    }
  }
  return out;
}

/** Values that are, or may hold, sealed strings: a sealed string itself or JSON. */
function candidateFilter(column: string): string {
  return `"${column}" LIKE 'v1.%' OR "${column}" LIKE '{%' OR "${column}" LIKE '[%'`;
}

/** Every sealed string in the database, in columns and inside JSON values. */
function* sealedValues(sqlite: Database): Generator<string> {
  for (const { table, column } of textColumns(sqlite)) {
    const rows = sqlite.query<{ value: unknown }, []>(`SELECT "${column}" AS value FROM "${table}" WHERE ${candidateFilter(column)}`).all();
    for (const row of rows) {
      if (typeof row.value !== "string") continue;
      if (sealedPattern.test(row.value)) {
        yield row.value;
        continue;
      }
      const found: string[] = [];
      walkSealed(parseJson(row.value), (s) => {
        found.push(s);
        return s;
      });
      yield* found;
    }
  }
}

function firstSealed(sqlite: Database): string | undefined {
  for (const sealed of sealedValues(sqlite)) return sealed;
  return undefined;
}

function opensWith(sealed: string, box: SecretBox): boolean {
  return sealPurposes.some((purpose) => box.open(sealed, purpose) !== null);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Calls `visit` on every sealed string inside a JSON value and returns the value with what it answers. */
function walkSealed(node: unknown, visit: (sealed: string) => string): unknown {
  if (typeof node === "string" && sealedPattern.test(node)) return visit(node);
  if (Array.isArray(node)) return node.map((n) => walkSealed(n, visit));
  if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walkSealed(v, visit)]));
  return node;
}

/** Re-seals a sealed string, or every sealed string inside a JSON value. */
function resealText(text: string, before: SecretBox, after: SecretBox, where: string): { value: string; count: number } {
  if (sealedPattern.test(text)) return { value: reseal(text, before, after, where), count: 1 };
  const parsed = parseJson(text);
  if (parsed === undefined) return { value: text, count: 0 };
  let count = 0;
  const walked = walkSealed(parsed, (sealed) => {
    count++;
    return reseal(sealed, before, after, where);
  });
  return count === 0 ? { value: text, count: 0 } : { value: JSON.stringify(walked), count };
}

function reseal(sealed: string, before: SecretBox, after: SecretBox, where: string): string {
  for (const purpose of sealPurposes) {
    const plain = before.open(sealed, purpose);
    if (plain !== null) return after.seal(plain, purpose as SealPurpose);
  }
  // Nothing is changed when a value cannot be read: the transaction rolls back.
  throw new RotationError(`A sealed value in ${where} does not open with master.key; nothing was changed.`);
}
