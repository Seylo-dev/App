// Demo answers for git credentials (git.listCredentials and the ops that
// add, change and delete them, generate a deploy key and read a host's SSH
// keys), in the world of fixtures.ts: a GitLab token two services clone
// with, the deploy key of acme/private-api, and an SSH key for the office
// Gitea on port 2222. They keep state, so a spec can add, rename and delete;
// installDemo puts the list back for every page. Shaped like the op
// contracts (packages/ops/src/ops/git.ts) and loosely typed.

import { DemoRefusal } from "./refusal";

type Input = Record<string, any>;

const now = Date.now();
const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();

/** A made-up Ed25519 public key blob for `seed`: the right prefix, never a real key. */
function fakeKey(seed: string): string {
  const body = Buffer.from(seed.padEnd(32, "-").slice(0, 32)).toString("base64").replace(/=+$/, "");
  return `AAAAC3NzaC1lZDI1NTE5AAAAI${body}`;
}
const fingerprintOf = (seed: string) => `SHA256:${Buffer.from(`fp:${seed}`.padEnd(32, ".")).toString("base64").slice(0, 43)}`;

function credential(over: Input): Input {
  return {
    username: null,
    publicKey: null,
    fingerprint: null,
    knownHosts: "",
    origin: "manual",
    usedBy: 0,
    createdAt: ago(30),
    updatedAt: ago(30),
    ...over,
  };
}

const initial = (): Input[] => [
  credential({ id: "cred000000000001", name: "GitLab read token", kind: "token", host: "gitlab.com", username: "git", usedBy: 2, createdAt: ago(40) }),
  credential({
    id: "cred000000000002",
    name: "acme/private-api",
    kind: "ssh_key",
    host: "github.com",
    publicKey: `ssh-ed25519 ${fakeKey("acme/private-api")} acme/private-api`,
    fingerprint: fingerprintOf("acme/private-api"),
    origin: "generated",
    usedBy: 1,
    createdAt: ago(12),
  }),
  credential({
    id: "cred000000000003",
    name: "Office Gitea",
    kind: "ssh_key",
    host: "gitea.lan:2222",
    publicKey: `ssh-ed25519 ${fakeKey("office-gitea")} ops@acme.dev`,
    fingerprint: fingerprintOf("office-gitea"),
    knownHosts: `[gitea.lan]:2222 ssh-ed25519 ${fakeKey("gitea.lan host")}`,
    createdAt: ago(3),
  }),
];

let credentials = initial();
let nextId = 4;

/** The demo's starting credentials (installDemo runs it for every page). */
export function resetGitDemo(): void {
  credentials = initial();
  nextId = 4;
}

const byName = (a: Input, b: Input) => String(a.name).localeCompare(String(b.name));

function find(id: unknown): Input {
  const found = credentials.find((c) => c.id === id);
  if (!found) throw new DemoRefusal(404, "NOT_FOUND", "No git credential with this id.", { field: "credentialId" });
  return found;
}

function add(fields: Input): Input {
  const id = `cred${String(nextId++).padStart(12, "0")}`;
  const at = new Date().toISOString();
  const created = credential({ id, createdAt: at, updatedAt: at, ...fields });
  credentials = [...credentials, created];
  return created;
}

export const handlers: Record<string, (input: Input) => unknown> = {
  "git.listCredentials": () => ({ items: [...credentials].sort(byName) }),
  "git.createCredential": (input) => {
    const base = { name: String(input.name).trim(), kind: input.kind, host: String(input.host).toLowerCase(), knownHosts: input.knownHosts ?? "" };
    if (input.kind === "token") {
      if (!input.token) throw new DemoRefusal(400, "BAD_REQUEST", "Enter the access token.", { field: "token" });
      return add({ ...base, username: input.username?.trim() || null });
    }
    if (!input.privateKey) throw new DemoRefusal(400, "BAD_REQUEST", "Paste the private key.", { field: "privateKey" });
    return add({ ...base, publicKey: `ssh-ed25519 ${fakeKey(base.name)} ${base.name}`, fingerprint: fingerprintOf(base.name) });
  },
  "git.generateSshKey": (input) => {
    const name = String(input.name).trim();
    return add({
      name,
      kind: "ssh_key",
      host: String(input.host).toLowerCase(),
      knownHosts: input.knownHosts ?? "",
      publicKey: `ssh-ed25519 ${fakeKey(name)} ${name}`,
      fingerprint: fingerprintOf(name),
      origin: "generated",
    });
  },
  "git.updateCredential": (input) => {
    const row = find(input.credentialId);
    const changed = { ...row, ...(input.name !== undefined ? { name: String(input.name).trim() } : {}), updatedAt: new Date().toISOString() };
    credentials = credentials.map((c) => (c.id === row.id ? changed : c));
    return changed;
  },
  "git.deleteCredential": (input) => {
    const row = find(input.credentialId);
    if (row.usedBy > 0)
      throw new DemoRefusal(409, "CONFLICT", `${row.usedBy} service(s) still clone with "${row.name}". Change their source first.`);
    credentials = credentials.filter((c) => c.id !== row.id);
    return {};
  },
  // ssh-keyscan of any host: an Ed25519 and an ECDSA key, named the way known_hosts names a host with a port.
  "git.scanHostKeys": (input) => {
    const [host, port] = String(input.host).split(":");
    const name = port && port !== "22" ? `[${host}]:${port}` : host;
    return {
      lines: [`${name} ssh-ed25519 ${fakeKey(`${host} ed25519`)}`, `${name} ecdsa-sha2-nistp256 ${fakeKey(`${host} ecdsa`)}`],
      fingerprints: [`ssh-ed25519 ${fingerprintOf(`${host} ed25519`)}`, `ecdsa-sha2-nistp256 ${fingerprintOf(`${host} ecdsa`)}`],
    };
  },
};
