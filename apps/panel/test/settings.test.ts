// Settings ops: general with the domain check, branding uploads served
// from disk and injected into index.html, owner-only custom CSS, and the
// telemetry opt-in with the exact payload the collector accepts.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settings, telemetry } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { jobs, nodes } from "../src/db/schema";
import { checkDomain, domainCheckJobType, setDomainProbes } from "../src/modules/settings/domain";
import { sendJob, setTelemetryFetch } from "../src/modules/telemetry";
import { getSetting, setSetting } from "../src/settings";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
  panel.deps.config.dataDir = mkdtempSync(join(tmpdir(), "seylo-settings-"));
});
afterEach(() => {
  setDomainProbes(null);
  setTelemetryFetch(null);
  panel.close();
});

const png = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f0500000000" +
    "49454e44ae426082",
  "hex",
);

test("general: name, default node, and a domain that goes from DNS to active", async () => {
  const { cookie } = await createUser(panel, "owner");
  panel.deps.db
    .insert(nodes)
    .values({ name: "a", publicKey: Buffer.alloc(32, 1), publicIpv4: "203.0.113.7", isPanelNode: true })
    .run();
  const before = await callOp(panel, settings.general, {}, { cookie });
  expect(before.body).toMatchObject({ domain: null, domainStatus: { state: "none" }, publicUrl: "http://203.0.113.7:3000" });

  const missing = await callOp(panel, settings.updateGeneral, { defaultNodeId: "z".repeat(16) }, { cookie });
  expect(missing.status).toBe(400);

  const updated = await callOp(panel, settings.updateGeneral, { name: "Acme Cloud", domain: "panel.example.com" }, { cookie });
  expect(updated.body).toMatchObject({ name: "Acme Cloud", domain: "panel.example.com", publicUrl: "https://panel.example.com" });
  expect(updated.body.domainStatus.state).toBe("pending_dns");

  let dns: string[] = ["198.51.100.1"];
  let https = false;
  setDomainProbes({ resolve: async () => dns, https: async () => https });
  expect((await checkDomain(panel.deps))?.message).toContain("expected 203.0.113.7");
  dns = ["203.0.113.7"];
  expect((await checkDomain(panel.deps))?.state).toBe("issuing_certificate");
  https = true;
  expect((await checkDomain(panel.deps))?.state).toBe("active");
  const active = (await callOp(panel, settings.general, {}, { cookie })).body.domainStatus;
  expect(active).toEqual({ state: "active", message: "", checkedAt: expect.any(String), proxied: false });
  expect(Date.parse(active.checkedAt)).toBe(getSetting(panel.deps.db, "panelDomainStatus")?.checkedAt as number);

  const member = await createUser(panel, "member");
  expect((await callOp(panel, settings.general, {}, { cookie: member.cookie })).status).toBe(403);
});

test("general: the domain and the default node can be removed again, and saving the same domain checks it now", async () => {
  const { cookie } = await createUser(panel, "owner");
  const node = panel.deps.db
    .insert(nodes)
    .values({ name: "a", publicKey: Buffer.alloc(32, 2), publicIpv4: "203.0.113.8", isPanelNode: true })
    .returning()
    .get();
  const checks = () => panel.deps.db.select().from(jobs).where(eq(jobs.type, domainCheckJobType)).all();

  expect((await callOp(panel, settings.updateGeneral, { domain: "panel.example.com", defaultNodeId: node.id }, { cookie })).status).toBe(
    200,
  );
  setSetting(panel.deps.db, "panelDomainStatus", { domain: "panel.example.com", state: "issuing_certificate", message: "", checkedAt: 0 });
  panel.deps.db.delete(jobs).run();
  // The same domain again: nothing changes, but the check runs now instead of in up to 5 minutes.
  const again = await callOp(panel, settings.updateGeneral, { domain: "panel.example.com" }, { cookie });
  expect(again.status).toBe(200);
  expect(checks()).toHaveLength(1);
  expect(getSetting(panel.deps.db, "panelDomainStatus")?.state).toBe("issuing_certificate");

  const removed = await callOp(panel, settings.updateGeneral, { domain: null, defaultNodeId: null }, { cookie });
  expect(removed.status).toBe(200);
  expect(removed.body).toMatchObject({
    domain: null,
    defaultNodeId: null,
    domainStatus: { state: "none" },
    publicUrl: "http://203.0.113.8:3000",
  });
  // The old domain's status is gone with it, so nothing keeps treating the panel as served on that domain.
  expect(getSetting(panel.deps.db, "panelDomainStatus")).toBeUndefined();
});

test("branding: upload checks the bytes, serves the file and changes the boot data", async () => {
  const { cookie } = await createUser(panel, "owner");
  const fake = await callOp(
    panel,
    settings.uploadBrandAsset,
    { kind: "favicon", dataUrl: `data:image/png;base64,${Buffer.from("<script>").toString("base64")}` },
    { cookie },
  );
  expect(fake.status).toBe(400);

  const uploaded = await callOp(
    panel,
    settings.uploadBrandAsset,
    { kind: "favicon", dataUrl: `data:image/png;base64,${png.toString("base64")}` },
    { cookie },
  );
  expect(uploaded.status).toBe(200);
  expect(uploaded.body.favicon).toMatch(/^\/branding\/favicon\?v=[0-9a-f]{16}$/);
  const served = await panel.app.handle(new Request(`http://panel.test${uploaded.body.favicon}`));
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await served.arrayBuffer()).equals(png)).toBe(true);

  const boot = await callOp(panel, settings.boot, {});
  expect(boot.body.favicon).toBe(uploaded.body.favicon);

  const text = await callOp(panel, settings.updateBranding, { loginMessage: "Staff only", hidePoweredBy: true }, { cookie });
  expect(text.body).toMatchObject({ loginMessage: "Staff only", hidePoweredBy: true });
  const removed = await callOp(panel, settings.removeBrandAsset, { kind: "favicon" }, { cookie });
  expect(removed.body.favicon).toBeNull();
  expect((await panel.app.handle(new Request("http://panel.test/branding/favicon"))).status).toBe(404);
});

test("appearance: admins change the theme; only the owner changes custom CSS", async () => {
  const owner = await createUser(panel, "owner");
  const admin = await createUser(panel, "admin");
  const themed = await callOp(panel, settings.updateAppearance, { preset: "midnight", accent: "#0F8A6A" }, { cookie: admin.cookie });
  expect(themed.body).toMatchObject({ preset: "midnight", colorMode: "system", accent: "#0F8A6A", customCss: "" });
  const css = await callOp(panel, settings.updateAppearance, { customCss: "body{}" }, { cookie: admin.cookie });
  expect(css.status).toBe(403);
  const ownerCss = await callOp(panel, settings.updateAppearance, { customCss: "body{color:red}" }, { cookie: owner.cookie });
  expect(ownerCss.body.customCss).toBe("body{color:red}");
  // Saving the same CSS back (as part of a theme change) is fine for admins.
  const again = await callOp(
    panel,
    settings.updateAppearance,
    { colorMode: "dark", customCss: "body{color:red}" },
    { cookie: admin.cookie },
  );
  expect(again.status).toBe(200);
  const boot = await callOp(panel, settings.boot, {});
  expect(boot.body).toMatchObject({ preset: "midnight", colorMode: "dark", customCss: "body{color:red}" });
});

test("telemetry: off by default, a daily schedule once on, and exactly the collector's four fields", async () => {
  const { cookie } = await createUser(panel, "owner");
  const off = await callOp(panel, settings.telemetry, {}, { cookie });
  expect(off.body).toMatchObject({ enabled: false, lastSentAt: null });
  expect(off.body.installId).toMatch(/^[A-Za-z0-9_-]{16,64}$/);

  const preview = await callOp(panel, telemetry.preview, {}, { cookie });
  expect(Object.keys(preview.body.payload).sort()).toEqual(["installId", "nodes", "services", "version"]);
  expect(preview.body).toMatchObject({ enabled: false, nextSendAt: null, intervalHours: 24, endpoint: "https://api.seylo.dev/telemetry" });

  const on = await callOp(panel, settings.updateTelemetry, { enabled: true }, { cookie });
  expect(on.body.enabled).toBe(true);
  const schedule = panel.deps.schedules.get("telemetry.send");
  expect(schedule).not.toBeNull();

  const sent: unknown[] = [];
  setTelemetryFetch(async (_url, init) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(null, { status: 204 });
  });
  expect(schedule?.jobType).toBe("telemetry.send");
  await sendJob.run({}, { ...panel.deps, jobId: "test", attempt: 1 });
  expect(sent).toEqual([{ installId: off.body.installId, version: "dev", nodes: 0, services: 0 }]);
  expect((await callOp(panel, settings.telemetry, {}, { cookie })).body.lastSentAt).not.toBeNull();

  await callOp(panel, settings.updateTelemetry, { enabled: false }, { cookie });
  expect(panel.deps.schedules.get("telemetry.send")).toBeNull();
});
