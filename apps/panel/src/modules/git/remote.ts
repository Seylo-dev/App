// Talking to git hosts from the panel without a git binary: listing a
// repository's branches (like `git ls-remote --symref`) over smart HTTP or
// SSH, reading SSH host keys (like ssh-keyscan) and making deploy keys.
// Builds clone on the nodes; this only checks access and finds commits.

import { createHash } from "node:crypto";
import { OpError } from "@seylo/ops";
import { Client, utils } from "ssh2";
import { pinRequest } from "../../http/pinned-fetch";
import { mayRequest } from "../uptime/targets";

const timeoutMs = 15_000;

/**
 * Host keys the panel trusts without known_hosts lines. Only GitHub's,
 * checked against api.github.com/meta; other hosts need scanned and
 * confirmed lines (git.scanHostKeys).
 */
export const builtinKnownHosts: Record<string, string[]> = {
  "github.com": [
    "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  ],
};

export interface RemoteRefs {
  branches: string[];
  defaultBranch: string | null;
  /** Branch name -> commit sha. */
  heads: Map<string, string>;
}

export interface RemoteAuth {
  /** HTTPS token (password); username defaults to "x-access-token". */
  token?: string | null;
  username?: string | null;
  sshPrivateKey?: string | null;
  knownHosts?: string | null;
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  path: string;
}

/** git@host:path and ssh://user@host:port/path; null for HTTPS URLs. */
export function parseSshUrl(url: string): SshTarget | null {
  const scp = /^([^@/\s]+)@([^:/\s]+):(.+)$/.exec(url);
  if (scp && !url.startsWith("ssh://")) return { user: scp[1] as string, host: scp[2] as string, port: 22, path: scp[3] as string };
  if (!url.startsWith("ssh://")) return null;
  const parsed = new URL(url);
  return {
    user: parsed.username || "git",
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 22,
    path: parsed.pathname.replace(/^\//, ""),
  };
}

/** Host of any git URL form, with a port when it is not the default. */
export function urlHost(url: string): string {
  const ssh = parseSshUrl(url);
  if (ssh) return ssh.port === 22 ? ssh.host : `${ssh.host}:${ssh.port}`;
  return new URL(url).host;
}

/** Reads the ref advertisement (pkt-lines) of git-upload-pack. */
export function parseAdvertisement(body: Uint8Array): RemoteRefs {
  const text = new TextDecoder().decode(body);
  const heads = new Map<string, string>();
  let defaultBranch: string | null = null;
  let headSha: string | null = null;
  let i = 0;
  while (i + 4 <= text.length) {
    const len = Number.parseInt(text.slice(i, i + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      i += 4;
      continue;
    }
    const line = text.slice(i + 4, i + len).replace(/\n$/, "");
    i += len;
    if (line.startsWith("#")) continue;
    const [refPart, caps] = line.split("\0");
    const [sha, ref] = (refPart ?? "").split(" ");
    if (caps) {
      const symref = /symref=HEAD:refs\/heads\/(\S+)/.exec(caps);
      if (symref) defaultBranch = symref[1] as string;
    }
    if (!sha || !ref) continue;
    if (ref === "HEAD") headSha = sha;
    if (ref.startsWith("refs/heads/")) heads.set(ref.slice("refs/heads/".length), sha);
  }
  if (!defaultBranch && headSha) {
    for (const [name, sha] of heads) if (sha === headSha) defaultBranch = name;
  }
  const branches = [...heads.keys()].sort((a, b) => (a === defaultBranch ? -1 : b === defaultBranch ? 1 : a.localeCompare(b)));
  return { branches, defaultBranch, heads };
}

/** A URL to vet with the SSRF filter for any git URL form (ssh://host:port for SSH). */
export function targetUrl(url: string): string {
  const ssh = parseSshUrl(url);
  return ssh ? `ssh://${ssh.host.includes(":") ? `[${ssh.host}]` : ssh.host}:${ssh.port}/` : url;
}

/**
 * Branches and default branch of a repository, over HTTPS or SSH. `address`
 * is the vetted address to connect to (uptime/targets.ts checkTarget), so
 * the name is not resolved a second time.
 */
export async function listRemoteRefs(
  url: string,
  auth: RemoteAuth = {},
  options: { address?: string | null; byName?: boolean } = {},
): Promise<RemoteRefs> {
  // A hostname with no vetted address would be resolved again here, unchecked.
  if (!mayRequest(targetUrl(url), options)) throw new OpError("BAD_REQUEST", `The name ${urlHost(url)} did not resolve.`, { field: "url" });
  const ssh = parseSshUrl(url);
  return ssh ? sshRefs(ssh, auth, options.address ?? null) : httpsRefs(url, auth, options.address ?? null);
}

async function httpsRefs(url: string, auth: RemoteAuth, address: string | null): Promise<RemoteRefs> {
  const headers: Record<string, string> = { "user-agent": "git/2.45.0", "git-protocol": "version=0" };
  if (auth.token) headers.authorization = `Basic ${Buffer.from(`${auth.username || "x-access-token"}:${auth.token}`).toString("base64")}`;
  const pinned = pinRequest(`${url.replace(/\/$/, "")}/info/refs?service=git-upload-pack`, address);
  let response: Response;
  try {
    // Redirects are not followed: the token stays with the host it was checked against,
    // and a redirect cannot point the panel at an internal address.
    response = await fetch(pinned.url, {
      headers: { ...headers, ...pinned.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      ...(pinned.tls ? { tls: pinned.tls } : {}),
    } as RequestInit);
  } catch {
    throw new OpError("BAD_REQUEST", `Could not read a git repository at ${urlHost(url)}.`);
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new OpError(
      "BAD_REQUEST",
      auth.token
        ? "The repository was not found or the credential cannot read it."
        : "The repository was not found or is private. Pick a credential that can read it.",
      { reason: "access" },
    );
  }
  const type = response.headers.get("content-type") ?? "";
  if (!response.ok || !type.includes("git-upload-pack-advertisement")) {
    await response.body?.cancel().catch(() => {});
    throw new OpError("BAD_REQUEST", `Could not read a git repository at ${urlHost(url)}.`);
  }
  return parseAdvertisement(new Uint8Array(await response.arrayBuffer()));
}

function knownLinesFor(target: { host: string; port: number }, knownHosts: string | null | undefined): string[] {
  const name = target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
  const lines = (knownHosts ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const own = lines.filter((l) => (l.split(/\s+/)[0] ?? "").split(",").includes(name));
  return own.length > 0 ? own : (builtinKnownHosts[target.host] ?? []);
}

/**
 * Checks known_hosts lines a person or a tool hands in for a credential's
 * host ("git.example.com" or "git.example.com:2222"): empty is fine (the
 * built-in keys of well-known hosts), hashed lines ("|1|...") cannot be
 * matched, and at least one line must name the host the way clones look it
 * up ("[host]:port" off port 22). Otherwise the credential would save and
 * every clone would fail with "No known host key".
 */
export function checkKnownHostsFor(credentialHost: string, knownHosts: string | null | undefined): void {
  const lines = (knownHosts ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  if (lines.length === 0) return;
  const [host = "", portText] = credentialHost.toLowerCase().split(":");
  const port = portText ? Number(portText) : 22;
  const name = port === 22 ? host : `[${host}]:${port}`;
  if (lines.some((l) => l.startsWith("|"))) {
    throw new OpError(
      "BAD_REQUEST",
      `Hashed known_hosts lines cannot be matched. Use lines that start with ${name}, for example from: ssh-keyscan${port === 22 ? "" : ` -p ${port}`} ${host}`,
      {
        field: "knownHosts",
      },
    );
  }
  if (!lines.some((l) => (l.split(/\s+/)[0] ?? "").toLowerCase().split(",").includes(name))) {
    throw new OpError(
      "BAD_REQUEST",
      `None of these lines are for ${name}. Each line starts with the host it is for, for example: ${name} ssh-ed25519 AAAA...`,
      {
        field: "knownHosts",
      },
    );
  }
}

/** Base64 key blobs the known_hosts lines allow. */
export function allowedKeys(target: { host: string; port: number }, knownHosts: string | null | undefined): Set<string> {
  return new Set(knownLinesFor(target, knownHosts).map((l) => l.split(/\s+/)[2] ?? ""));
}

function sshRefs(target: SshTarget, auth: RemoteAuth, address: string | null): Promise<RemoteRefs> {
  if (!auth.sshPrivateKey) throw new OpError("BAD_REQUEST", "SSH URLs need an SSH key credential.", { field: "credentialId" });
  const allowed = allowedKeys(target, auth.knownHosts);
  if (allowed.size === 0) {
    throw new OpError("BAD_REQUEST", `No known host key for ${target.host}. Scan and confirm its host keys on the credential first.`, {
      reason: "knownHosts",
    });
  }
  return new Promise((resolve, reject) => {
    const client = new Client();
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      client.end();
      if (error) reject(error instanceof OpError ? error : new OpError("BAD_REQUEST", `SSH to ${target.host} failed: ${error.message}`));
      else resolve(parseAdvertisement(new Uint8Array(Buffer.concat(chunks))));
    };
    client.on("ready", () => {
      client.exec(`git-upload-pack '${target.path.replace(/'/g, "")}'`, (error, stream) => {
        if (error) return finish(error);
        stream.on("data", (data: Buffer) => {
          chunks.push(data);
          // The advertisement ends with a flush packet; we never send wants.
          if (Buffer.concat(chunks).toString("latin1").endsWith("0000")) finish(null);
        });
        stream.stderr.on("data", (data: Buffer) =>
          finish(new OpError("BAD_REQUEST", data.toString("utf8").trim().slice(0, 300) || "The repository refused the key.")),
        );
        stream.on("close", () =>
          finish(chunks.length > 0 ? null : new OpError("BAD_REQUEST", "The repository was not found or the key cannot read it.")),
        );
      });
    });
    client.on("error", (error) => finish(error));
    try {
      client.connect({
        // The vetted address; the host key check still names the host.
        host: address ?? target.host,
        port: target.port,
        username: target.user,
        privateKey: auth.sshPrivateKey as string,
        readyTimeout: timeoutMs,
        hostVerifier: (key: Buffer) => allowed.has(key.toString("base64")),
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/** Key type ("ssh-ed25519") from an SSH public key blob. */
export function keyType(blob: Buffer): string {
  const len = blob.readUInt32BE(0);
  return blob.subarray(4, 4 + len).toString("latin1");
}

/** OpenSSH SHA256 fingerprint of a public key blob. */
export function fingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Fingerprint of an "ssh-ed25519 AAAA... comment" public key line. */
export function fingerprintOfLine(line: string): string {
  return fingerprint(Buffer.from(line.trim().split(/\s+/)[1] ?? "", "base64"));
}

const scanAlgorithms = ["ssh-ed25519", "ecdsa-sha2-nistp256", "rsa-sha2-512"] as const;

/** Host keys a server offers, as known_hosts lines (like ssh-keyscan). */
export async function scanHostKeys(hostWithPort: string): Promise<{ lines: string[]; fingerprints: string[] }> {
  const [host, portText] = hostWithPort.split(":");
  const port = portText ? Number(portText) : 22;
  const name = port === 22 ? (host as string) : `[${host}]:${port}`;
  const lines: string[] = [];
  const fingerprints: string[] = [];
  let lastError: string | null = null;
  for (const algorithm of scanAlgorithms) {
    const blob = await new Promise<Buffer | null>((resolve) => {
      const client = new Client();
      let found: Buffer | null = null;
      const done = () => {
        client.end();
        resolve(found);
      };
      client.on("error", (error) => {
        if (!found) lastError = error.message;
        done();
      });
      client.on("close", done);
      client.connect({
        host: host as string,
        port,
        username: "git",
        readyTimeout: timeoutMs,
        algorithms: { serverHostKey: [algorithm] },
        hostVerifier: (key: Buffer) => {
          found = Buffer.from(key);
          return false;
        },
      });
    });
    if (!blob) continue;
    lines.push(`${name} ${keyType(blob)} ${blob.toString("base64")}`);
    fingerprints.push(`${keyType(blob)} ${fingerprint(blob)}`);
  }
  if (lines.length === 0)
    throw new OpError("BAD_REQUEST", `Could not read host keys from ${hostWithPort}${lastError ? `: ${lastError}` : "."}`);
  return { lines, fingerprints };
}

/** A new Ed25519 deploy key in OpenSSH format. */
export function generateDeployKey(comment: string): { privateKey: string; publicKey: string; fingerprint: string } {
  const pair = utils.generateKeyPairSync("ed25519", { comment });
  const publicKey = pair.public.trim();
  return { privateKey: pair.private, publicKey, fingerprint: fingerprintOfLine(publicKey) };
}

/** Public key line of a private key, or null when it cannot be parsed (or has a passphrase). */
export function publicKeyOf(privateKey: string, comment: string): { publicKey: string; fingerprint: string } | null {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) return null;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key || key.isPrivateKey() === false) return null;
  const blob = key.getPublicSSH();
  const line = `${key.type} ${Buffer.from(blob).toString("base64")} ${comment}`;
  return { publicKey: line, fingerprint: fingerprint(Buffer.from(blob)) };
}
