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
// Run it with the panel stopped. New key files wait as master.key.new and
// agent-tls.key.new until the database commit; then agent-tls.crt goes,
// agent-tls.key.new replaces agent-tls.key, and master.key.new replaces
// master.key last. A failed run removes the new files. A run killed half
// way leaves master.key.new: the next run (and the panel's start, see
// finishInterruptedRotation) finishes the rotation when panel.db is already
// sealed with it; otherwise the next run removes the leftovers and starts
// over, and the panel refuses to start.

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { slug } from "@seylo/brand";
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
/** Settings that hold the panel's identity keys; with "new" the panel makes new ones on start. */
const identitySettings = ["edgeTicketKey", "lbTlsCa", "lbTlsNodes"];

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
  /** The Add node dialog's URL and trust with the new keys (pin = the new agents' TLS pin). */
  target: JoinTarget;
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
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const oldKey = loadMasterKey(paths.key, false);
    if (settleInterrupted(sqlite, paths, true) === "finished") {
      // An earlier run committed but did not replace master.key yet. Nodes
      // re-join when it dropped the identity, whichever flag this run has.
      const dropped = getSetting(drizzle({ client: sqlite, schema }), "edgeTicketKey") === undefined;
      const rejoin = dropped ? rejoinPlan(sqlite, options.config, agentTlsPinOf(paths.tlsKey)) : null;
      return { resealed: {}, recoveryCodesCleared: [], resumed: true, agentTlsPin: null, rejoin };
    }

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
      sqlite.transaction(() => {
        // Dropped first, so the count only has what the panel keeps.
        if (fresh) for (const key of identitySettings) sqlite.query("DELETE FROM settings WHERE key = ?").run(key);
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
      })();
    } catch (error) {
      // Nothing was committed: the old keys stay and the new files go.
      rmSync(paths.tlsNext, { force: true });
      rmSync(paths.next, { force: true });
      throw error;
    }
    sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    finishFiles(paths);
    if (fresh) result.rejoin = rejoinPlan(sqlite, options.config, agentTlsPinOf(paths.tlsKey));
    return result;
  } finally {
    sqlite.close();
  }
}

/**
 * The panel's start-up check for a rotation killed half way (master.key.new
 * left behind): finishes it when panel.db is already sealed with the new
 * key and returns true, returns false when there is nothing to finish, and
 * throws when the rotation never committed. Starting on the old key then
 * would be safe, but master.key.new may belong to a rotation still running,
 * so it is the next rotation run that removes it.
 */
export function finishInterruptedRotation(dataDir: string): boolean {
  const paths = pathsIn(dataDir);
  if (!existsSync(paths.next) || !existsSync(paths.db)) return false;
  const sqlite = new Database(paths.db);
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    return settleInterrupted(sqlite, paths, false) === "finished";
  } finally {
    sqlite.close();
  }
}

/**
 * What to do with files an interrupted run left: "finished" when the
 * database is sealed with master.key.new (the commit happened), "undone"
 * when it is not and `undo` is set (the new files are removed), "none"
 * without master.key.new.
 */
function settleInterrupted(sqlite: Database, paths: Paths, undo: boolean): "none" | "finished" | "undone" {
  if (!existsSync(paths.next)) {
    // Never left without master.key.new by a run (see finishFiles): stray.
    rmSync(paths.tlsNext, { force: true });
    return "none";
  }
  const pending = createSecretBox(loadMasterKey(paths.next, false));
  if (committedWith(sqlite, pending)) {
    finishFiles(paths);
    return "finished";
  }
  if (!undo) {
    throw new RotationError(
      `${paths.next} is left from a master-key rotation that did not finish, and panel.db is not sealed with it. ` +
        `Run the rotation again (\`sudo ${slug} panel rotate-key\` with the same flag): it removes the leftover and rotates again.`,
    );
  }
  rmSync(paths.tlsNext, { force: true });
  rmSync(paths.next);
  return "undone";
}

/** After the commit. master.key.new goes last, so a crash in between is finished by the next run. */
function finishFiles(paths: Paths): void {
  if (existsSync(paths.tlsNext)) {
    // The certificate wraps the old key: the panel makes one for the new key on start.
    rmSync(paths.tlsCert, { force: true });
    renameSync(paths.tlsNext, paths.tlsKey);
  }
  renameSync(paths.next, paths.key);
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

/** The nodes to join again and the commands' URL and pin, as the Add node dialog will show them. */
function rejoinPlan(sqlite: Database, config: RotationConfig | undefined, pin: string | null): RejoinPlan {
  const db = drizzle({ client: sqlite, schema });
  const hostPort = config?.hostPort ?? getSetting(db, "panelHostPort") ?? null;
  const tlsPort = storedAgentTlsPort(sqlite, config);
  const port = config?.port ?? 3000;
  const target = agentJoinTarget({
    db,
    config: { hostPort, port, host: config?.host ?? "0.0.0.0" },
    agentTls: tlsPort !== null && pin ? { port: tlsPort, pin } : null,
  });
  const nodes = sqlite
    .query<{ name: string; address: string | null; panelNode: number; canBuild: number }, []>(
      "SELECT name, coalesce(public_address, public_ipv4, public_ipv6) AS address, is_panel_node AS panelNode, can_build AS canBuild FROM nodes WHERE disabled_at IS NULL ORDER BY is_panel_node DESC, name",
    )
    .all()
    .map((n) => ({ name: n.name, address: n.address, panelNode: n.panelNode === 1, canBuild: n.canBuild === 1 }));
  return { nodes, target, localUrl: `http://127.0.0.1:${hostPort ?? port}` };
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
