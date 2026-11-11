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
    host: "203.0.113.10",
    port: 15432,
    user: "postgres",
    allowedCidrs: [],
    needsAllowedCidrs: false,
    tlsHostname: null,
    certificate: "selfSigned",
    certificateIssuer: null,
    certificateExpiresAt: null,
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

test("the exposed card shows the database's own user and password, with one reset for the database", async () => {
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
  expect(exposed).toContain(`>${t("serviceDatabase.user")}</span>`);
  expect(exposed).toContain(">postgres</span>");
  expect(exposed).toMatch(new RegExp(`data-slot="copy-field-value" aria-label="[^"]*${t("serviceDatabase.password")}"`));
  expect(exposed).toContain(t("serviceDatabase.sameUserAfter"));
  // Nothing promises a separate user, and the password is reset once, on the internal card.
  expect(out).not.toContain("separate user");
  expect(out).not.toContain("exposed password");
  expect(exposed).not.toContain(t("serviceDatabase.reset.button"));
  expect(section(out, t("serviceDatabase.internal"))).toContain(t("serviceDatabase.reset.button"));
});
