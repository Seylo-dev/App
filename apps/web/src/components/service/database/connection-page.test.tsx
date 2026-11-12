import { expect, test } from "bun:test";
import { databases } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { renderStatic } from "../../../test/render";
import type { ServiceDetail } from "../use-service";
import { ConnectionPage } from "./connection-page";

const db = {
  serviceId: "svc-db",
  projectId: "prj-1",
  nodeId: "node-1",
  nodeName: "de-fsn-1",
  name: "db",
  engine: "postgres",
  version: "17.6",
  variant: null,
  internal: { host: "db", port: 5432, database: "shop", user: "postgres", httpPort: null },
  exposure: {
    enabled: true,
    state: "open",
    host: "203.0.113.10",
    port: 15432,
    user: "postgres",
    allowedCidrs: [],
    needsAllowedCidrs: false,
    tlsHostname: null,
    certificate: "selfSigned",
    certificateIssuer: null,
    certificateExpiresAt: null,
    selfSignedReason: "noHostname",
    certificateError: null,
    certificatePem: null,
  },
  shellClient: "psql",
  webUi: { tool: "pgweb", idleMinutes: 15, running: false, lastActiveAt: null },
  createdAt: "2026-11-01T10:00:00.000Z",
};
const password = "Zq8vN3pXr7Lm2Kd9";
const connection = {
  internal: { url: `postgresql://postgres:${password}@db:5432/shop`, host: "db", port: 5432, database: "shop", user: "postgres", password },
  exposed: {
    url: `postgresql://postgres:${password}@203.0.113.10:15432/shop?sslmode=require`,
    host: "203.0.113.10",
    port: 15432,
    database: "shop",
    user: "postgres",
    password,
    tlsParams: "sslmode=require",
  },
};
const service = { id: "svc-db", projectId: "prj-1", name: "db", kind: "postgres", placements: [] } as unknown as ServiceDetail;

/** The markup of one section of the page, by its aria-label. */
function section(out: string, label: string): string {
  const start = out.indexOf(`<section aria-label="${label}"`);
  if (start < 0) return "";
  const end = out.indexOf("<section", start + 1);
  return out.slice(start, end < 0 ? undefined : end);
}

const usersLink = (change: string) => `href="/p/prj-1/s/svc-db/users?change=${change}"`;

test("the exposed card shows the database's own user and password; both cards' Change links open the Users tab", async () => {
  const out = await renderStatic(
    () => <ConnectionPage service={service} />,
    [
      [databases.get, { serviceId: "svc-db" }, db],
      [databases.connection, { serviceId: "svc-db" }, connection],
    ],
  );
  const exposed = section(out, t("serviceDatabase.exposed"));
  expect(exposed).not.toBe("");
  // The same tiles as inside: the user, and the password behind the eye with copy.
  expect(exposed).toContain(`>${t("serviceDatabase.user")}<`);
  expect(exposed).toContain(">postgres</span>");
  expect(exposed).toMatch(new RegExp(`data-slot="copy-field-value" aria-label="[^"]*${t("serviceDatabase.password")}"`));
  expect(exposed).toContain(t("serviceDatabase.sameUserAfter"));
  // Nothing promises a separate user.
  expect(out).not.toContain("separate user");
  expect(out).not.toContain("exposed password");
  // Next to the user and the password, on both cards: the Users tab with the main user's dialog.
  for (const card of [exposed, section(out, t("serviceDatabase.internal"))]) {
    expect(card).toContain(usersLink("name"));
    expect(card).toContain(usersLink("password"));
    expect(card).toContain(`aria-label="${t("serviceDatabase.changePassword")}"`);
  }
  // The reset itself lives on the Users tab now.
  expect(out).not.toContain("Reset password");
});

test("no Change links without the credentials; the Redis-likes' one user only has its password to change", async () => {
  const pending = await renderStatic(() => <ConnectionPage service={service} />, [[databases.get, { serviceId: "svc-db" }, db]]);
  expect(pending).not.toContain("/users?change=");
  const redis = { ...db, engine: "redis", internal: { ...db.internal, database: "", user: "default", port: 6379 } };
  const out = await renderStatic(
    () => <ConnectionPage service={service} />,
    [
      [databases.get, { serviceId: "svc-db" }, redis],
      [databases.connection, { serviceId: "svc-db" }, connection],
    ],
  );
  const internal = section(out, t("serviceDatabase.internal"));
  expect(internal).toContain(usersLink("password"));
  expect(internal).not.toContain(usersLink("name"));
});

test("an exposure waiting for its node's update stays on, closed: no SSL chip and no address", async () => {
  const render = (database: object, exposed: object | null) =>
    renderStatic(
      () => <ConnectionPage service={service} />,
      [
        [databases.get, { serviceId: "svc-db" }, database],
        [databases.connection, { serviceId: "svc-db" }, { ...connection, exposed }],
      ],
    );
  const waitingNote = t("serviceDatabase.waitingForNode", { node: "de-fsn-1" });
  const out = await render({ ...db, exposure: { ...db.exposure, state: "waitingForNodeUpdate", host: null, port: null } }, null);
  const exposed = section(out, t("serviceDatabase.exposed"));
  // The switch stays on: the setting is kept, and the port opens by itself after the update.
  expect(exposed.match(/<button[^>]*id="db-exposed"[^>]*>/)?.[0]).toContain('aria-checked="true"');
  expect(exposed).toContain(waitingNote);
  expect(exposed).not.toContain(t("serviceDatabase.sslRequired"));
  expect(exposed).not.toContain("203.0.113.10");
  expect(exposed).not.toContain(t("serviceDatabase.opening"));
  expect(exposed).not.toContain(t("serviceDatabase.exposedUrl"));

  // Open, it has the chip and the address, and no note.
  const open = section(await render(db, connection.exposed), t("serviceDatabase.exposed"));
  expect(open).toContain(t("serviceDatabase.sslRequired"));
  expect(open).toContain("203.0.113.10");
  expect(open).not.toContain(waitingNote);
});

/** The markup's text with the entities renderToStaticMarkup writes turned back. */
const text = (html: string) =>
  html
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

test("a self-signed exposure says why, how to get a trusted certificate and what connects meanwhile", async () => {
  const render = async (database: object) =>
    text(
      section(
        await renderStatic(
          () => <ConnectionPage service={service} />,
          [
            [databases.get, { serviceId: "svc-db" }, database],
            [databases.connection, { serviceId: "svc-db" }, connection],
          ],
        ),
        t("serviceDatabase.exposed"),
      ),
    );
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

  // No TLS host name: Postgres clients that verify get node-postgres' setting, and the file to trust.
  const none = await render({ ...db, exposure: { ...db.exposure, certificateIssuer: "database", certificatePem: pem } });
  expect(none).toContain(t("serviceDatabase.selfSigned.title"));
  expect(none).toContain(t("serviceDatabase.selfSigned.body"));
  expect(none).toContain(t("serviceDatabase.selfSigned.reason.noHostname"));
  expect(none).toContain(t("serviceDatabase.selfSigned.getTrusted"));
  expect(none).toContain("sslmode=no-verify");
  expect(none).toContain(t("serviceDatabase.selfSigned.meanwhile.postgres"));
  expect(none).toContain(`>${t("serviceDatabase.selfSigned.download")}</button>`);
  // The file names no host: only verify-ca connects with it, node-postgres with uselibpqcompat.
  expect(none).toContain(t("serviceDatabase.selfSigned.downloadHintNoHost.postgres"));
  expect(none).toContain("sslmode=verify-ca");
  expect(none).not.toContain("tlsCAFile");
  // Its issuer is only its own name.
  expect(none).not.toContain(t("serviceDatabase.certIssuer", { issuer: "database" }));

  // A host name without its Let's Encrypt certificate: the host and the node's last ACME error.
  const error = "Timeout during connect (likely firewall problem)";
  const acme = await render({
    ...db,
    exposure: {
      ...db.exposure,
      host: "db.example.com",
      tlsHostname: "db.example.com",
      certificate: "failed",
      selfSignedReason: "acmeMissing",
      certificateError: error,
    },
  });
  expect(acme).toContain(t("serviceDatabase.selfSigned.reason.acmeMissing", { host: "db.example.com" }));
  expect(acme).toContain(t("serviceDatabase.selfSigned.lastError", { error }));
  expect(acme).toContain(t("serviceDatabase.selfSigned.fixAcme", { host: "db.example.com" }));
  expect(acme).not.toContain(t("serviceDatabase.selfSigned.getTrusted"));
  // No PEM reported (an older node): no download.
  expect(acme).not.toContain(t("serviceDatabase.selfSigned.download"));
  // With the PEM: the file names the host, so any client trusts it by that name.
  const acmePem = await render({
    ...db,
    exposure: { ...db.exposure, tlsHostname: "db.example.com", selfSignedReason: "acmeMissing", certificatePem: pem },
  });
  expect(acmePem).toContain(t("serviceDatabase.selfSigned.downloadHint", { host: "db.example.com" }));
  expect(acmePem).not.toContain("verify-ca");

  // MariaDB's own certificate: no host name advice, its clients' setting.
  const maria = await render({ ...db, engine: "mariadb", exposure: { ...db.exposure, selfSignedReason: "engine" } });
  expect(maria).toContain(t("serviceDatabase.selfSigned.reason.engine"));
  expect(maria).toContain(t("serviceDatabase.selfSigned.meanwhile.mariadb"));
  expect(maria).not.toContain(t("serviceDatabase.selfSigned.getTrusted"));

  // Mongo's exposed URL already accepts it without a host name; with one, the client is told to.
  const mongo = await render({ ...db, engine: "mongo", exposure: { ...db.exposure, certificatePem: pem } });
  expect(mongo).toContain(t("serviceDatabase.selfSigned.meanwhile.mongoInUrl"));
  expect(mongo).toContain(t("serviceDatabase.selfSigned.downloadHintNoHost.mongo"));
  expect(await render({ ...db, engine: "mysql", exposure: { ...db.exposure, certificatePem: pem } })).toContain(
    t("serviceDatabase.selfSigned.downloadHintNoHost.mysql"),
  );
  expect(await render({ ...db, engine: "redis", exposure: { ...db.exposure, certificatePem: pem } })).toContain(
    t("serviceDatabase.selfSigned.downloadHintNoHost.other"),
  );
  expect(
    await render({ ...db, engine: "mongo", exposure: { ...db.exposure, tlsHostname: "m.example.com", selfSignedReason: "acmeMissing" } }),
  ).toContain(t("serviceDatabase.selfSigned.meanwhile.mongo"));

  // A Let's Encrypt certificate: no note, and its issuer shows.
  const valid = await render({
    ...db,
    exposure: {
      ...db.exposure,
      tlsHostname: "db.example.com",
      certificate: "valid",
      certificateIssuer: "Let's Encrypt (R11)",
      selfSignedReason: null,
    },
  });
  expect(valid).not.toContain(t("serviceDatabase.selfSigned.title"));
  expect(valid).toContain(t("serviceDatabase.certIssuer", { issuer: "Let's Encrypt (R11)" }));
});
