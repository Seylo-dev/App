// Demo data for service export and import (service-transfer.spec.ts): what
// serviceTransfer.exportPreview says for the api service, an export file
// written by the panel's own zip writer (and two damaged ones), and the
// import preview the review page starts from.

import { createHash } from "node:crypto";
import { writeZip, type ZipEntryInput } from "../../../packages/zip/src/write";
import { ids } from "./fixtures";

export const exportPreview = {
  name: "api",
  kind: "app",
  blockers: [],
  includes: {
    envKeys: 12,
    fileMounts: 1,
    domains: [{ host: "api.acme.dev", pathPrefix: "/", auto: false, customCertificate: false, basicAuth: true }],
    cronJobs: 2,
    uptimeChecks: 1,
    alerts: 3,
    backups: 0,
    exposures: 0,
    tunnel: false,
    maintenance: true,
    deployTrigger: true,
    sharedVariables: ["SENTRY_DSN"],
    upload: null,
  },
  volumes: [{ name: "uploads", mountPath: "/app/uploads" }],
  sourceLogin: { kind: "gitCredential", name: "deploy-bot" },
  leftOut: [
    { what: "Deploy history, logs and built images", why: "They belong to this panel; the import builds or pulls the service again." },
    { what: "Volume data", why: "Volumes arrive empty. Volume data comes with a later version of export." },
  ],
};

const mtime = new Date("2026-11-11T12:00:00Z");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A real export file of the web service: encrypted, with an uploaded archive of `archiveBytes` bytes. */
export async function exportFile(archiveBytes = 300_000): Promise<Buffer> {
  const enc = new TextEncoder();
  const readme = enc.encode("Seylo service export: web\n");
  const secrets = enc.encode(JSON.stringify({ v: 1, kdf: { name: "scrypt", N: 65536, r: 8, p: 1, salt: "AAAAAAAAAAAAAAAAAAAAAA", check: "AAAAAAAAAAAAAAAAAAAAAA" }, cipher: "aes-256-gcm", iv: "AAAAAAAAAAAAAAAA", tag: "AAAAAAAAAAAAAAAAAAAAAA", data: "" }));
  const archive = new Uint8Array(archiveBytes).map((_, i) => (i * 7) % 251);
  archive[0] = 0x1f;
  archive[1] = 0x8b;
  const manifest = enc.encode(
    JSON.stringify({
      format: "service-export",
      formatVersion: 1,
      panel: { version: "0.2.8", id: "otherpanel000001" },
      exportedAt: mtime.toISOString(),
      secrets: "encrypted",
      requires: [],
      services: [{ name: "web", kind: "app", path: "services/web/", agentVersion: "0.2.8", counts: { envKeys: 4, fileMounts: 0, domains: 1, volumes: 0, cronJobs: 1, uptimeChecks: 0 } }],
      entries: [
        { path: "README.txt", size: readme.length, sha256: sha(readme) },
        { path: "secrets.enc", size: secrets.length, sha256: sha(secrets) },
        { path: "services/web/source/upload.tar.gz", size: archive.length, sha256: sha(archive) },
      ],
    }),
  );
  const entries: ZipEntryInput[] = [
    { name: "README.txt", method: "deflate", mtime, body: readme },
    { name: "secrets.enc", method: "deflate", mtime, body: secrets },
    { name: "services/web/source/upload.tar.gz", method: "store", mtime, body: archive },
    { name: "manifest.json", method: "deflate", mtime, body: manifest },
    { name: "manifest.sig", method: "deflate", mtime, body: enc.encode('{"alg":"HMAC-SHA256","value":"00"}') },
  ];
  const parts: Uint8Array[] = [];
  for await (const chunk of writeZip(entries)) parts.push(chunk);
  return Buffer.concat(parts);
}

/** Offsets of the central directory entries of a zip writeZip made. */
function central(zip: Buffer): number[] {
  const eocd = zip.length - 22;
  const out: number[] = [];
  for (let p = zip.readUInt32LE(eocd + 16); p < eocd && zip.readUInt32LE(p) === 0x02014b50; ) {
    out.push(p);
    p += 46 + zip.readUInt16LE(p + 28) + zip.readUInt16LE(p + 30) + zip.readUInt16LE(p + 32);
  }
  return out;
}

/** The export with its README turned into a symbolic link. */
export async function symlinkFile(): Promise<Buffer> {
  const zip = await exportFile(1000);
  zip.writeUInt32LE((0o120777 << 16) >>> 0, (central(zip)[0] as number) + 38);
  return zip;
}

/** The export whose README's bytes run over the next entry (how zip bombs reuse one stream). */
export async function overlapFile(): Promise<Buffer> {
  const zip = await exportFile(1000);
  const p = central(zip)[0] as number;
  zip.writeUInt32LE(zip.readUInt32LE(p + 20) + 40, p + 20);
  return zip;
}

/** importBegin's answer for the web file, in the acme project where a web already exists. */
export function importPreview(overrides: Record<string, unknown> = {}) {
  const base = {
    importId: "import0000000001",
    projectId: ids.acme,
    status: "previewing",
    file: { panelVersion: "0.2.8", exportedAt: mtime.toISOString(), secrets: "encrypted", samePanel: false, unknownSettings: [] },
    service: { name: "web-2", kind: "app", source: { type: "github", label: "acme/web", branch: "main", builder: "railpack" } },
    choices: {
      name: "web-2",
      nodeId: ids.de,
      commit: "live",
      pinDigest: false,
      deployWhenReady: true,
      deployOnPush: false,
      domains: [
        { host: "shop.acme.dev", pathPrefix: "/", action: "skip" },
        { host: "admin.acme.dev", pathPrefix: "/", action: "add" },
      ],
      autoDomain: true,
      upload: true,
      sharedVariables: "addMissing",
      cronJobs: "asInFile",
      uptimeChecks: "asInFile",
      alerts: "skip",
      backups: "skip",
      exposures: [],
    },
    blockers: [],
    needs: [
      {
        reason: "sourceAccess",
        message: "Nothing on this panel matches GitHub App on acme. Pick what reads it, or import without it (deploys fail until you connect one).",
        field: "sourceAccess",
      },
    ],
    warnings: [{ reason: "tunnel", message: "The Cloudflare tunnel arrives switched off. Turn it on once the old panel's copy is off." }],
    nodes: [
      { id: ids.de, name: "fsn-1", online: true },
      { id: ids.us, name: "ash-1", online: true },
    ],
    env: {
      keys: ["DATABASE_URL", "SECRET_KEY", "SELF_URL", "SENTRY_DSN"],
      empty: false,
      references: [{ key: "SELF_URL", target: "web:3000", via: "hostname", effect: "renamed" }],
      readsFrom: [{ key: "DATABASE_URL", service: "db", kind: "postgres" }],
      missingServices: [],
      shared: [{ name: "SENTRY_DSN", state: "missing" }],
    },
    domains: [
      { host: "shop.acme.dev", pathPrefix: "/", https: "acme", primary: false, status: "usedHere", action: "skip", basicAuthUsers: [], message: "Another service on this panel serves it. Move it there first, or skip it." },
      { host: "admin.acme.dev", pathPrefix: "/", https: "acme", primary: true, status: "needsPassword", action: "add", basicAuthUsers: ["admin"], message: "The file left the passwords of admin out: type new ones, or skip the domain." },
    ],
    autoDomain: { host: "web-2.fsn1.acme.dev", reason: null },
    primaryDomain: "admin.acme.dev",
    source: {
      access: {
        picked: null,
        options: [
          { kind: "githubAccount", id: "credgithub000001", name: "GitHub account octo" },
          { kind: "none", id: null, name: "Import without a source" },
        ],
        wanted: "GitHub App on acme",
      },
      commitSha: "4be1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3",
      imageDigest: null,
    },
    extras: { cronJobs: 1, uptimeChecks: 0, maintenance: false, tunnel: true, deployTrigger: true, exposures: [], alerts: [], backups: [] },
    data: { volumes: [], upload: { fileName: "web.tar.gz", sizeBytes: 300_000 } },
    skipped: [{ what: "Previews", why: "Previews arrive off; turn them on on the Previews tab." }],
    expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
  };
  return { ...base, ...overrides };
}
