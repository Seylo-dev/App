// The panel domain's "Check now" (settings.checkDomain, 0.2.1) and domains
// proxied by Cloudflare: every record a Cloudflare address skips the node
// address comparison and only the HTTPS probe through Cloudflare decides,
// so a proxied domain can become active and an active one stays active
// when the proxy is turned on later.

import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { settings } from "@seylo/ops";
import { desc, eq } from "drizzle-orm";
import { liveDomainTarget } from "../src/agent-hub/move-target";
import { auditLog, jobs, nodes } from "../src/db/schema";
import type { JobContext } from "../src/jobs/queue";
import { checkDomain, checkDomainNow, domainCheckJob, domainCheckJobType, setDomainProbes } from "../src/modules/settings/domain";
import { domainCheckWindowMs } from "../src/modules/settings/ops";
import { getSetting, setSetting } from "../src/settings";
import { callOp, createApiKey, createUser, type TestPanel, testPanel } from "./helpers";

const domain = "panel.example.com";
const nodeIp = "203.0.113.10";
/** Cloudflare proxy addresses (104.16.0.0/13, 2606:4700::/32). */
const cloudflare = ["104.21.32.1", "172.67.180.2", "2606:4700:3030::6815:2001"];

let panel: TestPanel;
let records: string[];
let https: boolean;
let probes: { resolve: number; https: number };

beforeEach(() => {
  panel = testPanel();
  panel.deps.db
    .insert(nodes)
    .values({ name: "here", publicKey: Buffer.alloc(32, 7), publicIpv4: nodeIp, isPanelNode: true })
    .run();
  setSetting(panel.deps.db, "panelDomain", domain);
  records = [nodeIp];
  https = true;
  probes = { resolve: 0, https: 0 };
  setDomainProbes({
    resolve: async () => {
      probes.resolve++;
      return records;
    },
    https: async () => {
      probes.https++;
      return https;
    },
  });
});
afterEach(() => {
  setSystemTime();
  setDomainProbes(null);
  panel.close();
});

const run = (payload: { force?: boolean } = {}) => domainCheckJob.run(payload, panel.deps as JobContext);

test("a proxied domain whose HTTPS answers through Cloudflare is active", async () => {
  records = cloudflare;
  const status = await checkDomain(panel.deps);
  expect(status).toMatchObject({ state: "active", message: "", proxied: true, working: true });
  // Agents move to it like to any active domain, with their system roots (Cloudflare's certificate).
  expect(liveDomainTarget(panel.deps.db)).toEqual({ url: `https://${domain}`, pin: "" });
  const general = await callOp(panel, settings.general, {}, { cookie: (await createUser(panel, "owner")).cookie });
  expect(general.body.domainStatus).toMatchObject({ state: "active", message: "", proxied: true });
  expect(Date.parse(general.body.domainStatus.checkedAt)).toBe(status?.checkedAt as number);
});

test("a proxied domain without HTTPS waits with what to set in Cloudflare", async () => {
  records = cloudflare;
  https = false;
  const status = await checkDomain(panel.deps);
  expect(status).toMatchObject({ state: "issuing_certificate", proxied: true, working: false });
  expect(status?.message).toContain(`${domain} is proxied by Cloudflare`);
  expect(status?.message).toContain(`point the record at ${nodeIp}`);
  expect(status?.message).toContain("Full (strict)");
  expect(status?.message).toContain("turn off Always Use HTTPS");
  expect(status?.message).toContain(`http://${domain}/.well-known/acme-challenge/`);
  // The Cloudflare addresses never count as wrong: the HTTPS probe ran.
  expect(probes.https).toBe(1);
});

test("an active domain that gets proxied later stays active while HTTPS answers", async () => {
  const t0 = new Date("2026-11-08T21:30:00Z");
  expect(await checkDomain(panel.deps, t0)).toMatchObject({ state: "active", proxied: false });
  records = cloudflare;
  const later = await checkDomain(panel.deps, new Date(t0.getTime() + 3_600_000));
  expect(later).toMatchObject({ state: "active", proxied: true, working: true, failedChecks: 0, since: t0.getTime() });
  // Through the job too, at its hourly re-check.
  const rechecked = new Date(t0.getTime() + 3 * 3_600_000);
  setSystemTime(rechecked);
  await run();
  expect(probes.https).toBe(3);
  expect(getSetting(panel.deps.db, "panelDomainStatus")).toMatchObject({ state: "active", proxied: true, checkedAt: rechecked.getTime() });
  // When HTTPS through Cloudflare stops answering, the usual debounce applies.
  https = false;
  expect(await checkDomain(panel.deps)).toMatchObject({ state: "issuing_certificate", working: true, failedChecks: 1 });
});

test("Cloudflare addresses next to an address of another host still point elsewhere", async () => {
  records = [cloudflare[0] as string, "198.51.100.9"];
  const status = await checkDomain(panel.deps);
  expect(status).toMatchObject({ state: "pending_dns", proxied: false });
  expect(status?.message).toContain(`expected ${nodeIp}`);
  expect(probes.https).toBe(0);
});

test("Check now runs the check at once, returns the fresh state and is audited", async () => {
  const { cookie } = await createUser(panel, "owner");
  records = cloudflare;
  https = false;
  const pending = await callOp(panel, settings.checkDomain, {}, { cookie });
  expect(pending.status).toBe(200);
  expect(pending.body).toMatchObject({ state: "issuing_certificate", proxied: true });
  expect(pending.body.message).toContain("proxied by Cloudflare");
  expect(Date.parse(pending.body.checkedAt)).toBeGreaterThan(Date.now() - 5_000);
  const row = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "settings.checkDomain")).orderBy(desc(auditLog.id)).get();
  expect(row?.outcome).toBe("ok");

  setSystemTime(new Date(Date.now() + domainCheckWindowMs + 1));
  https = true;
  const active = await callOp(panel, settings.checkDomain, {}, { cookie });
  expect(active.body).toMatchObject({ state: "active", message: "", proxied: true });
  expect(getSetting(panel.deps.db, "panelDomainStatus")?.state).toBe("active");
});

test("Check now: once per 10 seconds for the whole panel", async () => {
  const owner = await createUser(panel, "owner");
  const admin = await createUser(panel, "admin");
  const start = new Date("2026-11-08T21:30:00Z");
  setSystemTime(start);
  expect((await callOp(panel, settings.checkDomain, {}, { cookie: owner.cookie })).status).toBe(200);

  setSystemTime(new Date(start.getTime() + 3_000));
  const again = await callOp(panel, settings.checkDomain, {}, { cookie: admin.cookie });
  expect(again.status).toBe(429);
  expect(again.body.error).toMatchObject({ code: "RATE_LIMITED", details: { reason: "domainCheck", retryAfter: "7" } });
  expect(again.body.error.message).toBe("The domain was checked a moment ago. Try again in 7 seconds.");
  expect(again.headers.get("retry-after")).toBe("7");
  expect(probes.resolve).toBe(1);

  setSystemTime(new Date(start.getTime() + domainCheckWindowMs));
  expect((await callOp(panel, settings.checkDomain, {}, { cookie: admin.cookie })).status).toBe(200);
  expect(probes.resolve).toBe(2);
});

test("Check now needs settings.manage and a domain", async () => {
  const owner = await createUser(panel, "owner");
  const member = await createUser(panel, "member");
  expect((await callOp(panel, settings.checkDomain, {}, { cookie: member.cookie })).status).toBe(403);
  const readOnly = createApiKey(panel, owner.user.id, { readOnly: true });
  expect((await callOp(panel, settings.checkDomain, {}, { bearer: readOnly })).status).toBe(403);
  const viewOnly = createApiKey(panel, owner.user.id, { actions: ["settings.view"] });
  expect((await callOp(panel, settings.checkDomain, {}, { bearer: viewOnly })).status).toBe(403);
  // Refusals never probed or used up the window.
  expect(probes.resolve).toBe(0);
  const manage = createApiKey(panel, owner.user.id, { actions: ["settings.manage"] });
  expect((await callOp(panel, settings.checkDomain, {}, { bearer: manage })).status).toBe(200);

  setSystemTime(new Date(Date.now() + domainCheckWindowMs + 1));
  setSetting(panel.deps.db, "panelDomain", null);
  const none = await callOp(panel, settings.checkDomain, {}, { cookie: owner.cookie });
  expect(none.status).toBe(409);
  expect(none.body.error.details).toMatchObject({ reason: "noDomain" });
});

test("a check while one runs waits for it instead of probing twice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  setDomainProbes({
    resolve: async () => {
      probes.resolve++;
      await gate;
      return records;
    },
    https: async () => true,
  });
  const scheduled = run({ force: true });
  const now = checkDomainNow(panel.deps);
  release();
  await scheduled;
  expect((await now)?.state).toBe("active");
  expect(probes.resolve).toBe(1);
  // Done: the next one probes again.
  await checkDomainNow(panel.deps);
  expect(probes.resolve).toBe(2);
});

test("every check refreshes the card; a change refreshes the rest too", async () => {
  const published: string[][] = [];
  const publish = panel.deps.live.publish.bind(panel.deps.live);
  panel.deps.live.publish = ((topic: string, event: { type: string; ops?: string[] }) => {
    if (event.type === "invalidate" && event.ops) published.push(event.ops);
    return publish(topic as never, event as never);
  }) as typeof panel.deps.live.publish;
  await checkDomain(panel.deps);
  await checkDomain(panel.deps);
  expect(published[0]).toContain("settings.panelAccess");
  expect(published[1]).toEqual(["settings.general"]);
  records = cloudflare;
  await checkDomain(panel.deps);
  expect(published[2]).toContain("settings.panelAccess");
});

test("saving the domain checks an active one too, past its hourly re-check", async () => {
  const { cookie } = await createUser(panel, "owner");
  await checkDomain(panel.deps);
  panel.deps.db.delete(jobs).run();
  expect((await callOp(panel, settings.updateGeneral, { domain }, { cookie })).status).toBe(200);
  const queued = panel.deps.db.select().from(jobs).where(eq(jobs.type, domainCheckJobType)).all();
  expect(queued.map((job) => job.payload)).toEqual([{ force: true }]);
  // The scheduled run skips an active domain checked within the hour; the forced one does not.
  await run();
  expect(probes.resolve).toBe(1);
  await run({ force: true });
  expect(probes.resolve).toBe(2);
});
