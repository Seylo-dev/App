// Two panels in one process for the service export and import tests:
// side() builds one (its own master key, data folder and captured logs),
// makeApp() a service with something of every kind, exportZip() downloads
// an export and begin() sends a zip's small entries to importBegin like
// the web app does.

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { env, projects, services as serviceOps, serviceTransfer as transferOps } from "@seylo/ops";
import { bytesSource, openZip, readEntry } from "@seylo/zip/read";
import { eq } from "drizzle-orm";
import pino from "pino";
import {
  alertRules,
  cronJobs,
  deployTriggers,
  domains,
  maintenancePages,
  nodes,
  notificationChannels,
  sessions,
  uptimeChecks,
  volumes,
} from "../src/db/schema";
import { FakeFleet } from "./fake-fleet";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

export const secretValue = "s3cr3t-value-that-must-never-leak";
export const passphrase = "correct horse battery staple";

export interface Side {
  panel: TestPanel;
  fleet: FakeFleet;
  cookie: string;
  userId: string;
  nodeId: string;
  projectId: string;
  dataDir: string;
  logs: string[];
}

const sides: Side[] = [];

export async function side(nodeName = "node-a"): Promise<Side> {
  const logs: string[] = [];
  const logger = pino(
    { level: "debug" },
    new Writable({
      write(chunk, _enc, done) {
        logs.push(String(chunk));
        done();
      },
    }),
  );
  const dataDir = mkdtempSync(join(tmpdir(), "transfer-"));
  const panel = testPanel({ dataDir, logger });
  const fleet = new FakeFleet(panel);
  const nodeId = fleet.addNode(nodeName);
  panel.deps.db
    .update(nodes)
    .set({ wildcardDomain: `${nodeName}.example.com` })
    .where(eq(nodes.id, nodeId))
    .run();
  const { cookie, user } = await createUser(panel, "owner");
  fresh(panel, user.id);
  const projectId = (await callOp(panel, projects.create, { name: "shop" }, { cookie })).body.id as string;
  const s: Side = { panel, fleet, cookie, userId: user.id, nodeId, projectId, dataDir, logs };
  sides.push(s);
  return s;
}

/** A recent sign-in, which export and import need. */
export function fresh(panel: TestPanel, userId: string) {
  panel.deps.db.update(sessions).set({ reauthAt: new Date() }).where(eq(sessions.userId, userId)).run();
}

/** Closes every panel side() made; register with afterEach. */
export function closeSides() {
  for (const s of sides.splice(0)) {
    s.panel.close();
    rmSync(s.dataDir, { recursive: true, force: true });
  }
}

export async function makeApp(s: Side, name = "web") {
  const created = await callOp(
    s.panel,
    serviceOps.create,
    {
      projectId: s.projectId,
      name,
      kind: "app",
      nodeId: s.nodeId,
      source: { type: "image", image: "nginx:1.27", registryId: null },
      ports: [{ containerPort: 8080, protocol: "tcp" }],
    },
    { cookie: s.cookie },
  );
  expect(created.status).toBe(200);
  const id = created.body.id as string;
  const db = s.panel.deps.db;
  const text = `PLAIN=1\nSECRET=${secretValue}\nSELF=http://${name}:8080\nOWN=\${{${name}.PLAIN}}\nSENTRY=\${{project.SENTRY_DSN}}\n`;
  expect((await callOp(s.panel, env.set, { serviceId: id, text }, { cookie: s.cookie })).status).toBe(200);
  expect(
    (
      await callOp(
        s.panel,
        env.setShared,
        { projectId: s.projectId, text: "SENTRY_DSN=https://key@sentry.example/1\n" },
        { cookie: s.cookie },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await callOp(
        s.panel,
        serviceOps.setVolumes,
        { serviceId: id, volumes: [{ name: "uploads", mountPath: "/data" }] },
        { cookie: s.cookie },
      )
    ).status,
  ).toBe(200);
  db.insert(volumes)
    .values({
      serviceId: id,
      name: "nginx-conf",
      mountPath: "/etc/nginx/conf.d/app.conf",
      kind: "file",
      contentSealed: s.panel.deps.secrets.seal(`# ${secretValue}\n`, "volume.file"),
    })
    .run();
  db.insert(domains)
    .values({
      serviceId: id,
      host: name === "web" ? "shop.example.org" : `${name}.example.org`,
      targetPort: 8080,
      isPrimary: true,
      middlewares: {
        basicAuth: { users: [{ username: "admin", hash: `$2y$10$${"a".repeat(53)}` }] },
        ipAllowList: ["10.0.0.0/8"],
        redirects: [{ from: "^http://old/(.*)", to: "https://shop.example.org/$1", permanent: true }],
      },
    })
    .run();
  db.insert(domains)
    .values({ serviceId: id, host: `${name}.${s.nodeId}.auto.example.com`, targetPort: 8080, auto: true })
    .run();
  db.insert(cronJobs).values({ serviceId: id, name: "cleanup", schedule: "0 3 * * *", command: "echo cleanup" }).run();
  db.insert(uptimeChecks).values({ serviceId: id, name: "home", url: "https://shop.example.org/" }).run();
  db.insert(maintenancePages).values({ serviceId: id, enabled: false, message: "Back soon" }).run();
  db.insert(deployTriggers)
    .values({ serviceId: id, tokenHash: sha(id), hint: "abcd" })
    .run();
  const channel = db
    .insert(notificationChannels)
    .values({ name: "ops", kind: "webhook", configSealed: s.panel.deps.secrets.seal("{}", "notification.channel") })
    .returning()
    .get();
  db.insert(alertRules)
    .values({ scopeType: "service", scopeId: id, event: "deploy_failed", channelIds: [channel.id] })
    .run();
  return id;
}

export async function download(s: Side, url: string) {
  const response = await s.panel.app.handle(new Request(`http://panel.test${url}`, { headers: { host: "panel.test" } }));
  return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) };
}

export async function exportZip(
  s: Side,
  serviceId: string,
  input: Partial<{ secrets: "encrypted" | "omitted"; passphrase: string; includeSourceLogin: boolean }> = {},
) {
  const res = await callOp(
    s.panel,
    transferOps.exportService,
    { serviceId, secrets: "encrypted", passphrase, ...input },
    { cookie: s.cookie },
  );
  expect(res.status).toBe(200);
  const file = await download(s, res.body.download.url);
  expect(file.status).toBe(200);
  return { ...file, exportId: res.body.exportId as string, fileName: res.body.fileName as string };
}

/** What the web app sends to importBegin, read from the zip like read-export.ts does. */
export async function entriesOf(zip: Uint8Array) {
  const source = bytesSource(zip);
  const opened = await openZip(source, { accept: transferOps.isExportEntryName });
  const text = async (name: string) => {
    const entry = opened.entries.find((e) => e.name === name);
    return entry ? new TextDecoder().decode(await readEntry(source, entry, { maxBytes: 4 << 20 })) : undefined;
  };
  const manifestText = (await text("manifest.json")) as string;
  const manifest = JSON.parse(manifestText) as transferOps.PortableManifestV1;
  const services = [];
  for (const e of opened.entries.filter((x) => transferOps.entryPatterns.service.test(x.name)))
    services.push({ path: e.name, json: (await text(e.name)) as string });
  return { opened, manifestText, manifest, signature: await text("manifest.sig"), secretsEnc: await text("secrets.enc"), services, text };
}

export async function begin(
  s: Side,
  zip: Uint8Array,
  options: { passphrase?: string; projectId?: string; edit?: (e: Awaited<ReturnType<typeof entriesOf>>) => void } = {},
) {
  const e = await entriesOf(zip);
  options.edit?.(e);
  return callOp(
    s.panel,
    transferOps.importBegin,
    {
      projectId: options.projectId ?? s.projectId,
      manifest: e.manifestText,
      ...(e.signature ? { signature: e.signature } : {}),
      ...(e.secretsEnc ? { secretsEnc: e.secretsEnc } : {}),
      ...(e.services.length ? { services: e.services } : {}),
      ...(options.passphrase !== undefined ? { passphrase: options.passphrase } : e.secretsEnc ? { passphrase } : {}),
    },
    { cookie: s.cookie },
  );
}

export const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
