import { expect, test } from "bun:test";
import { databases, exposures, OpError } from "@seylo/ops";
import { t } from "../../../i18n/t";
import { type Answer, renderStatic } from "../../../test/render";
import { oneHourMore } from "../timed-extend";
import type { ServiceDetail } from "../use-service";
import { ConnectionPage } from "./connection-page";

const password = "Zq8vN3pXr7Lm2Kd9";
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
    enabled: false,
    state: "off",
    host: null,
    port: null,
    user: "postgres",
    allowedCidrs: [],
    needsAllowedCidrs: false,
    tlsHostname: null,
    certificate: "none",
    certificateIssuer: null,
    certificateExpiresAt: null,
    selfSignedReason: null,
    certificateError: null,
    certificatePem: null,
  },
  shellClient: "psql",
  webUi: { tool: "pgweb", idleMinutes: 15, running: false, lastActiveAt: null },
  createdAt: "2026-11-01T10:00:00.000Z",
};
const timed = {
  id: "exp-1",
  serviceId: "svc-db",
  nodeId: "node-1",
  host: "203.0.113.10",
  port: 41000,
  targetPort: 5432,
  allowedCidrs: ["198.51.100.24/32"],
  expiresAt: new Date(Date.now() + 42 * 60_000).toISOString(),
  firewallHint: null,
  openedBy: { kind: "user", name: "owner" },
  database: {
    engine: "postgres",
    user: "postgres",
    database: "shop",
    tls: "none",
    url: "postgresql://postgres@203.0.113.10:41000/shop",
    command: "psql postgresql://postgres@203.0.113.10:41000/shop",
  },
  createdAt: new Date().toISOString(),
};
const access = (list: object[]) => ({
  firstRun: {
    status: "none",
    address: null,
    redirectTo: null,
    closeAt: null,
    domainLiveAt: null,
    closeWhenDomainLive: true,
    redirectToPrimary: true,
    firewallHint: null,
  },
  timed: list,
  database: null,
});
const connection = {
  internal: { url: `postgresql://postgres:${password}@db:5432/shop`, host: "db", port: 5432, database: "shop", user: "postgres", password },
  exposed: null,
  timed: [{ exposureId: "exp-1", host: "203.0.113.10", port: 41000, url: `postgresql://postgres:${password}@203.0.113.10:41000/shop` }],
};
const service = { id: "svc-db", projectId: "prj-1", name: "db", kind: "postgres", placements: [] } as unknown as ServiceDetail;

/** The markup of one section of the page, by its aria-label. */
function section(out: string, label: string): string {
  const start = out.indexOf(`<section aria-label="${label}"`);
  if (start < 0) return "";
  const end = out.indexOf("<section", start + 1);
  return out.slice(start, end < 0 ? undefined : end);
}

/** The markup's text with the entities renderToStaticMarkup writes turned back. */
const text = (html: string) =>
  html
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const card = async (database: object, list: object[], conn: object | null) => {
  const answers: Answer[] = [
    [databases.get, { serviceId: "svc-db" }, database],
    [exposures.get, { serviceId: "svc-db" }, access(list)],
  ];
  if (conn) answers.push([databases.connection, { serviceId: "svc-db" }, conn]);
  return text(section(await renderStatic(() => <ConnectionPage service={service} />, answers), t("serviceDatabase.timed.title")));
};

test("the Connection tab offers a timed expose from the viewer's IP, an hour by default", async () => {
  const out = await card(db, [], connection);
  expect(out).not.toBe("");
  expect(out).toContain(t("serviceDatabase.timed.closed"));
  expect(out).toContain(t("serviceDatabase.timed.body", { name: "db", node: "de-fsn-1" }));
  expect(out).toContain(t("serviceDatabase.timed.openFromMyIp", { duration: t("serviceDomains.dev.hours", { count: 1 }) }));
  expect(out).toContain(`placeholder="${t("serviceDatabase.timed.yourIp")}"`);
  // One port for Postgres: no port choice.
  expect(out).not.toContain(t("serviceDatabase.timed.port"));
  // It sits next to the exposed connection, after it.
  const page = await renderStatic(
    () => <ConnectionPage service={service} />,
    [
      [databases.get, { serviceId: "svc-db" }, db],
      [exposures.get, { serviceId: "svc-db" }, access([])],
    ],
  );
  expect(page.indexOf(`aria-label="${t("serviceDatabase.exposed")}"`)).toBeLessThan(
    page.indexOf(`aria-label="${t("serviceDatabase.timed.title")}"`),
  );
});

test("ClickHouse can open its native or its HTTP port", async () => {
  const ch = { ...db, engine: "clickhouse", internal: { ...db.internal, port: 9000, httpPort: 8123 } };
  const out = await card(ch, [], null);
  expect(out).toContain(t("serviceDatabase.timed.port"));
  expect(out).toContain(`aria-label="${t("serviceDatabase.timed.port")}"`);
});

test("an open expose: address, URL with the password behind the eye, the command, a countdown and its own TLS or none", async () => {
  const out = await card(db, [timed], connection);
  expect(out).toContain(t("serviceDatabase.timed.open"));
  expect(out).toContain("203.0.113.10:41000");
  expect(out).toContain(t("serviceDatabase.timed.onlyFrom", { cidrs: "198.51.100.24" }));
  // The password is in the URL, shown as dots until the eye.
  expect(out).toMatch(new RegExp(`data-slot="copy-field-value" aria-label="[^"]*${t("serviceDatabase.timed.url")}"`));
  expect(out).toContain("postgresql://postgres:••••••••••••••••@203.0.113.10:41000/shop");
  expect(out).not.toContain(`${password}@203.0.113.10`);
  // The command asks for the password.
  expect(out).toContain("psql postgresql://postgres@203.0.113.10:41000/shop");
  expect(out).toContain(t("serviceDatabase.timed.asksPassword"));
  // No TLS in this Postgres: said plainly.
  expect(out).toContain(t("serviceDatabase.timed.plain", { engine: "PostgreSQL", cidrs: "198.51.100.24" }));
  expect(out).not.toContain(t("serviceDatabase.timed.tls.postgres"));
  expect(out).toMatch(new RegExp(`${t("serviceDatabase.timed.closesIn")} <b[^>]*>4[12]:\\d\\d</b>`));
  expect(out).toContain(t("serviceDomains.dev.extend"));
  expect(out).toContain(t("serviceDomains.dev.closeNow"));
  // Another one can be opened next to it.
  expect(out).toContain(t("serviceDatabase.timed.openAnother"));

  // TLS on in the database (it is exposed): the note says the URL asks for it.
  const tls = { ...timed, database: { ...timed.database, tls: "database", url: `${timed.database.url}?sslmode=require` } };
  const encrypted = await card({ ...db, exposure: { ...db.exposure, enabled: true, state: "open" } }, [tls], connection);
  expect(encrypted).toContain(t("serviceDatabase.timed.tls.postgres"));
  expect(encrypted).not.toContain(t("serviceDatabase.timed.plain", { engine: "PostgreSQL", cidrs: "198.51.100.24" }));
});

test("without the credentials: the URL without the password, and no password to copy", async () => {
  const out = await card(db, [timed], null);
  expect(out).toContain(t("serviceDatabase.timed.urlNoPassword"));
  expect(out).toContain("postgresql://postgres@203.0.113.10:41000/shop");
  expect(out).not.toContain(password);
  expect(out).toContain(t("serviceDatabase.timed.asksPasswordHidden"));
});

test("before the node reports the port: opening, no URL yet", async () => {
  const out = await card(db, [{ ...timed, port: null, database: { ...timed.database, url: null, command: null } }], connection);
  expect(out).toContain(t("serviceDatabase.timed.opening"));
  expect(out).not.toContain(t("serviceDatabase.timed.command"));
});

test("people who may not see IP:port access get no card", async () => {
  const out = await renderStatic(() => <ConnectionPage service={service} />, [[databases.get, { serviceId: "svc-db" }, db]], {
    errors: [[exposures.get, { serviceId: "svc-db" }, new OpError("FORBIDDEN", "You do not have the exposures.view permission here.", {})]],
  });
  expect(out).toContain(`aria-label="${t("serviceDatabase.exposed")}"`);
  expect(out).not.toContain(t("serviceDatabase.timed.title"));
  expect(out).not.toContain("exposures.view");
});

test("+1 hour adds an hour to what is left, at most 24 hours", () => {
  expect(oneHourMore(42 * 60_000)).toBe(102);
  expect(oneHourMore(3 * 3600_000)).toBe(240);
  expect(oneHourMore(0)).toBe(60);
  expect(oneHourMore(23.5 * 3600_000)).toBe(1440);
});
