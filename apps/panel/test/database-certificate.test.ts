// Why an exposed database serves a self-signed certificate (0.2.12):
// databases.get says the reason (no TLS host name, no Let's Encrypt
// certificate for it yet with the node's ACME error, or MariaDB's own),
// and carries the PEM the node reports so a client can trust it. The
// status caps keep a whole PEM.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { databases as dbOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { capServiceStatus } from "../src/agent-hub/field-caps";
import { nodes } from "../src/db/schema";
import { servedPem } from "../src/modules/databases/certificate";
import { enginesCapability, exposureCapability } from "../src/modules/databases/engines";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { fakeAgent, seedNode, seedProject, settleDeploys } from "./seed-helpers";

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

/** PEM-shaped, about as long as the agent's P-256 certificate. */
const pem = `-----BEGIN CERTIFICATE-----\n${`${"MIIBkTCB+wIJAKHBfpegPjMCMA0GCSqGSIb3DQEBCwUAMBExDzANBgNVBAMMBmRi".slice(0, 64)}\n`.repeat(10)}-----END CERTIFICATE-----\n`;
const acmeError = "Invalid response from http://db.example.com/.well-known/acme-challenge/x: 404";
const seconds = (d: Date) => ({ seconds: BigInt(Math.floor(d.getTime() / 1000)), nanos: 0 });

async function exposedDb(engine: "postgres" | "mariadb" | "mongo", capabilities = [enginesCapability, exposureCapability]) {
  const project = seedProject(panel);
  const node = seedNode(panel, { ipv4: "203.0.113.10", wildcard: "n1.example.com" });
  panel.deps.db.update(nodes).set({ facts: { capabilities } }).where(eq(nodes.id, node.id)).run();
  const res = await callOp(panel, dbOps.create, { projectId: project.id, name: "shop-db", engine, nodeId: node.id }, { cookie });
  const serviceId = res.body.serviceId as string;
  await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, port: 45432 }, { cookie });
  return { serviceId, nodeId: node.id };
}

test("a self-signed Postgres exposure says why, with the certificate to trust", async () => {
  const { serviceId, nodeId } = await exposedDb("postgres");
  const agent = fakeAgent(panel, nodeId, {}, [], [enginesCapability, exposureCapability]);
  const expires = new Date(Date.now() + 3650 * 86_400_000);
  const report = (port: Record<string, unknown>, epoch: bigint) =>
    agent.snapshot({ epoch, services: [{ serviceId, openPorts: [{ hostPort: 45432, containerPort: 5432, ...port }] }] });
  const get = async () => (await callOp(panel, dbOps.get, { serviceId }, { cookie })).body.exposure;

  // No host name: self-signed by choice, with the PEM the node reports.
  report({ certificateIssuer: "database", certificateExpiresAt: seconds(expires), certificateSelfSigned: true, certificatePem: pem }, 1n);
  expect(await get()).toMatchObject({
    certificate: "selfSigned",
    selfSignedReason: "noHostname",
    certificateError: null,
    certificatePem: pem,
    certificateIssuer: "database",
  });

  // A host name the CA could not reach: failed, with the node's ACME error.
  await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, tlsHostname: "db.example.com" }, { cookie });
  report({ certificateIssuer: "db.example.com", certificateSelfSigned: true, certificatePem: pem, certificateError: acmeError }, 2n);
  expect(await get()).toMatchObject({
    certificate: "failed",
    selfSignedReason: "acmeMissing",
    certificateError: acmeError,
    certificatePem: pem,
  });
  // No error known yet: still being issued.
  report({ certificateIssuer: "db.example.com", certificateSelfSigned: true, certificatePem: pem }, 3n);
  expect(await get()).toMatchObject({ certificate: "pending", selfSignedReason: "acmeMissing", certificateError: null });

  // The Let's Encrypt certificate arrived: valid, nothing to explain.
  report({ certificateIssuer: "R11", certificateExpiresAt: seconds(new Date(Date.now() + 60 * 86_400_000)) }, 4n);
  expect(await get()).toMatchObject({
    certificate: "valid",
    certificateIssuer: "Let's Encrypt (R11)",
    selfSignedReason: null,
    certificateError: null,
    certificatePem: null,
  });

  // A PEM cut short (or anything else) is not offered as a certificate.
  report({ certificateSelfSigned: true, certificatePem: pem.slice(0, 256) }, 5n);
  expect(await get()).toMatchObject({ selfSignedReason: "acmeMissing", certificatePem: null });
  agent.disconnect();
});

test("a self-signed Mongo port with a host name is not counted valid", async () => {
  const { serviceId, nodeId } = await exposedDb("mongo");
  await callOp(panel, dbOps.setExposure, { serviceId, enabled: true, tlsHostname: "mongo.example.com" }, { cookie });
  const agent = fakeAgent(panel, nodeId, {}, [], [enginesCapability, exposureCapability]);
  // The fallback's issuer is its own name and it lasts ten years: before 0.2.12 that read as valid.
  agent.snapshot({
    epoch: 1n,
    services: [
      {
        serviceId,
        openPorts: [
          {
            hostPort: 45432,
            containerPort: 27017,
            tls: true,
            certificateIssuer: "mongo.example.com",
            certificateExpiresAt: seconds(new Date(Date.now() + 3650 * 86_400_000)),
            certificateSelfSigned: true,
            certificatePem: pem,
          },
        ],
      },
    ],
  });
  const got = await callOp(panel, dbOps.get, { serviceId }, { cookie });
  expect(got.body.exposure).toMatchObject({ certificate: "pending", selfSignedReason: "acmeMissing", certificatePem: pem });
  agent.disconnect();
});

test("MariaDB's own certificate is the reason, whatever the host name; a closed port says nothing", async () => {
  const maria = await exposedDb("mariadb");
  await callOp(panel, dbOps.setExposure, { serviceId: maria.serviceId, enabled: true, tlsHostname: "maria.example.com" }, { cookie });
  const got = await callOp(panel, dbOps.get, { serviceId: maria.serviceId }, { cookie });
  expect(got.body.exposure).toMatchObject({ certificate: "selfSigned", selfSignedReason: "engine", certificatePem: null });

  // Waiting for the node's update: the port is closed, so nothing is served.
  const waiting = await exposedDb("postgres", [enginesCapability, exposureCapability]);
  panel.deps.db
    .update(nodes)
    .set({ facts: { capabilities: [enginesCapability] } })
    .where(eq(nodes.id, waiting.nodeId))
    .run();
  const closed = await callOp(panel, dbOps.get, { serviceId: waiting.serviceId }, { cookie });
  expect(closed.body.exposure).toMatchObject({ state: "waitingForNodeUpdate", certificate: "selfSigned", selfSignedReason: null });
});

test("the status caps keep an open port's whole PEM and a long ACME error", () => {
  const status = capServiceStatus({
    instances: [],
    routes: [],
    openPorts: [{ certificatePem: pem, certificateError: "e".repeat(5000), certificateIssuer: "i".repeat(1000) }],
  });
  const port = status.openPorts[0];
  expect(port?.certificatePem).toBe(pem);
  expect(servedPem(port?.certificatePem ?? "")).toBe(pem);
  expect(port?.certificateError.length).toBe(2048);
  expect(port?.certificateIssuer.length).toBe(256);
  // A node cannot pin a huge one.
  const huge = capServiceStatus({ instances: [], routes: [], openPorts: [{ certificatePem: "x".repeat(64 << 10) }] });
  expect(huge.openPorts[0]?.certificatePem.length).toBe(4096);
});
