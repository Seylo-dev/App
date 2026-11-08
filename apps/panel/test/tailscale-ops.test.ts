// The tailscale ops (added in 0.2.1) against a fake panel node agent that
// reports the server's tailscaled: what tailscale.get shows and to whom,
// who may turn Serve on (the owner, from a fresh browser session over HTTP:
// never an API key, another role, MCP or the assistant), every reason Serve
// cannot be turned on, the switch reaching the agent in NodeSettings,
// turning Serve off while the tailnet is the only way in, and the sign-in
// link: owner only, memory only, never in the audit log, a log line or
// panel.db.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { type OpInput, settings as settingOps, tailscale } from "@seylo/ops";
import { StatusCode } from "@seylo/proto";
import { desc, eq, isNull } from "drizzle-orm";
import pino from "pino";
import { alerts, auditLog, sessions, settings as settingsTable } from "../src/db/schema";
import { ensurePanelService } from "../src/modules/nodes/panel-service";
import { panelPublishBindCapability } from "../src/modules/settings/ip-access";
import { freshSignInLink } from "../src/modules/tailscale/sign-in";
import type { OpCall } from "../src/ops/pipeline";
import { getSetting, setSetting } from "../src/settings";
import { allCapabilities, type FakeAgent, FakeStatus } from "./fake-agent";
import { callOp, createApiKey, createUser, sessionKeyOf, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

const dnsName = "panel.tail1234.ts.net";
const loginUrl = "https://login.tailscale.com/a/5f3e9c1d2b";
// The panel node can publish the panel port on 127.0.0.1 only, so IP access really closes and reopens.
const capabilities = [...allCapabilities, "tailnet.serve.v1", panelPublishBindCapability];

let panel: TestPanel;
let url: string;
let owner: Awaited<ReturnType<typeof createUser>>;
let agent: FakeAgent;
const logLines: string[] = [];

/** tailscaled as the fake agent reports it; `serve` and the rest override the Running defaults. */
function info(overrides: Record<string, unknown> = {}) {
  return {
    version: "1.104.5-t2c2ddf4b5-g8d5e2f9a3",
    backendState: "Running",
    tailnet: "example.com",
    dnsName: `${dnsName}.`,
    addresses: ["100.101.42.7", "fd7a:115c:a1e0::6a01:2a07"],
    magicDns: true,
    https: true,
    acceptDns: true,
    keyExpiry: { seconds: BigInt(Math.floor(Date.now() / 1000) + 150 * 86_400), nanos: 0 },
    loginName: "owner@example.com",
    ...overrides,
  };
}

/** Sends new facts and waits until the panel has them. */
async function report(tailscaleInfo: Record<string, unknown> | null, caps = capabilities) {
  const marker = `host-${crypto.randomUUID().slice(0, 6)}`;
  agent.event({
    payload: { case: "nodeFacts", value: { hostname: marker, capabilities: caps, ...(tailscaleInfo ? { tailscale: tailscaleInfo } : {}) } },
  });
  for (let i = 0; i < 200; i++) {
    if (panel.deps.agents.state.get(agent.nodeId)?.facts?.hostname === marker) return;
    await Bun.sleep(5);
  }
  throw new Error("the panel did not get the facts");
}

beforeEach(async () => {
  logLines.length = 0;
  const logger = pino({ level: "trace" }, { write: (line: string) => logLines.push(line) });
  panel = testPanel({ logger });
  url = listen(panel);
  owner = await createUser(panel, "owner");
  agent = await joinAgent(panel, url, { capabilities, facts: { hostname: "panel-1", tailscale: info() } });
});
afterEach(async () => {
  await agent.close();
  await panel.app.stop(true);
  panel.close();
});

const stale = (userId: string) =>
  panel.deps.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 20 * 60_000), reauthAt: null })
    .where(eq(sessions.userId, userId))
    .run();

const audits = () => panel.deps.db.select().from(auditLog).orderBy(desc(auditLog.id)).all();

test("tailscale.get shows the panel server's tailscaled, and only the owner may manage it", async () => {
  const got = await callOp(panel, tailscale.get, {}, { cookie: owner.cookie });
  expect(got.status).toBe(200);
  expect(got.body).toMatchObject({
    detected: true,
    agentOnline: true,
    agentSupported: true,
    version: "1.104.5-t2c2ddf4b5-g8d5e2f9a3",
    versionOk: true,
    backendState: "Running",
    tailnet: "example.com",
    dnsName,
    addresses: ["100.101.42.7", "fd7a:115c:a1e0::6a01:2a07"],
    loginName: "owner@example.com",
    magicDns: true,
    https: true,
    acceptDns: true,
    disabledOnServer: false,
    serve: { wanted: false, state: "off", url: null, message: "", panelAnswers: false },
    owned: null,
    viaTailnet: false,
    canManage: true,
    installCommand: tailscale.tailscaleInstallCommand,
    signInUrl: null,
  });
  expect(JSON.parse(got.body.grantSnippet)).toEqual({ grants: [{ src: ["owner@example.com"], dst: ["100.101.42.7"], ip: ["tcp:443"] }] });
  expect(Date.parse(got.body.keyExpiry)).toBeGreaterThan(Date.now() + 100 * 86_400_000);

  const admin = await createUser(panel, "admin");
  expect((await callOp(panel, tailscale.get, {}, { cookie: admin.cookie })).body.canManage).toBe(false);
  const key = createApiKey(panel, owner.user.id);
  expect((await callOp(panel, tailscale.get, {}, { bearer: key })).body.canManage).toBe(false);
});

test("an active entry shows its URL and the exact Serve entry the agent owns", async () => {
  await report(
    info({
      serve: { state: 3, url: `https://${dnsName}`, panelAnswers: true, proxy: "unix:/var/lib/seylo/panel/tailnet.sock" },
    }),
  );
  const got = (await callOp(panel, tailscale.get, {}, { cookie: owner.cookie })).body;
  expect(got.serve).toEqual({
    wanted: false,
    tailnet: null,
    onOtherTailnet: false,
    state: "active",
    url: `https://${dnsName}`,
    message: "",
    panelAnswers: true,
  });
  expect(got.owned).toEqual({ hostPort: `${dnsName}:443`, path: "/", proxy: "unix:/var/lib/seylo/panel/tailnet.sock" });
  // HTTP mode: no certificates for the tailnet.
  await report(
    info({ https: false, serve: { state: 3, url: `http://${dnsName}`, panelAnswers: true, proxy: "unix:/srv/panel/tailnet.sock" } }),
  );
  const http = (await callOp(panel, tailscale.get, {}, { cookie: owner.cookie })).body;
  expect(http.owned).toEqual({ hostPort: `${dnsName}:80`, path: "/", proxy: "unix:/srv/panel/tailnet.sock" });
  expect(JSON.parse(http.grantSnippet).grants[0].ip).toEqual(["tcp:80"]);
  // A conflict keeps the agent's words.
  await report(info({ serve: { state: 4, message: "Another handler serves panel.tail1234.ts.net:443." } }));
  const conflict = (await callOp(panel, tailscale.get, {}, { cookie: owner.cookie })).body;
  expect(conflict.serve).toMatchObject({ state: "conflict", url: null, message: "Another handler serves panel.tail1234.ts.net:443." });
  expect(conflict.owned).toBeNull();
});

test("turning Serve on: the owner from a fresh browser session over HTTP, never anyone else", async () => {
  const on = { serve: true } satisfies OpInput<typeof tailscale.setServe>;
  const key = createApiKey(panel, owner.user.id);
  const viaKey = await callOp(panel, tailscale.setServe, on, { bearer: key });
  expect(viaKey.status).toBe(403);

  const admin = await createUser(panel, "admin");
  const viaAdmin = await callOp(panel, tailscale.setServe, on, { cookie: admin.cookie });
  expect(viaAdmin.status).toBe(403);
  expect(viaAdmin.body.error.message).toContain("Only the owner");

  // A model, even with the owner's fresh session: MCP and the assistant.
  for (const transport of ["mcp", "ai"] as const) {
    const token = owner.cookie.split("=")[1] as string;
    const outcome = await panel.execute({
      op: tailscale.setServe,
      rawInput: on,
      credentials: { sessionToken: token, sessionKey: sessionKeyOf(owner.cookie) },
      transport,
      coerce: false,
      ip: null,
      userAgent: null,
      http: null,
    } as OpCall);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.code).toBe("FORBIDDEN");
  }

  const fresh = await createUser(panel, "owner");
  stale(fresh.user.id);
  const old = await callOp(panel, tailscale.setServe, on, { cookie: fresh.cookie });
  expect(old.status).toBe(403);
  expect(old.body.error.details).toMatchObject({ reason: "reauth" });
  expect(getSetting(panel.deps.db, "tailscaleServe")).toBeUndefined();
});

test("every reason Serve cannot be turned on is a CONFLICT with its details.reason", async () => {
  const expectBlocked = async (reason: tailscale.ServeBlockedReason) => {
    const res = await callOp(panel, tailscale.setServe, { serve: true }, { cookie: owner.cookie });
    expect(res.status).toBe(409);
    expect(res.body.error.details).toMatchObject({ reason });
  };
  await report(null, allCapabilities);
  await expectBlocked("agentTooOld");
  await report(null);
  await expectBlocked("notInstalled");
  await report(info({ disabledOnServer: true }));
  await expectBlocked("disabledOnServer");
  await report(info({ version: "1.104.3" }));
  await expectBlocked("tooOld");
  await report(info({ backendState: "NeedsMachineAuth" }));
  await expectBlocked("needsApproval");
  for (const backendState of ["NeedsLogin", "Stopped", "Starting"]) {
    await report(info({ backendState }));
    await expectBlocked("notSignedIn");
  }
  await report(info({ magicDns: false }));
  await expectBlocked("magicDnsOff");
  await agent.close();
  for (let i = 0; i < 100 && panel.deps.agents.isOnline(agent.nodeId); i++) await Bun.sleep(5);
  await expectBlocked("offline");
  // The page still shows what the agent said last.
  const got = (await callOp(panel, tailscale.get, {}, { cookie: owner.cookie })).body;
  expect(got).toMatchObject({ agentOnline: false, agentSupported: true, detected: true, magicDns: false });
  expect(getSetting(panel.deps.db, "tailscaleServe")).toBeUndefined();
});

test("turning Serve on reaches the agent, raises a security alert and audits the tailnet", async () => {
  const res = await callOp(panel, tailscale.setServe, { serve: true }, { cookie: owner.cookie });
  expect(res.status).toBe(200);
  expect(res.body.tailscale.serve.wanted).toBe(true);
  expect(res.body.reopenedUrl).toBeNull();
  expect(getSetting(panel.deps.db, "tailscaleServe")).toBe(true);
  // NodeSettings.tailnet.panel, on the panel node only.
  for (let i = 0; i < 200; i++) {
    const last = agent.requests("SyncDesired").at(-1) ?? agent.requests("ApplyService").at(-1);
    if (last?.state?.settings?.tailnet?.panel) break;
    await Bun.sleep(10);
  }
  expect(agent.requests("SyncDesired").at(-1)?.state?.settings?.tailnet?.panel).toBe(true);

  const alert = panel.deps.db.select().from(alerts).where(eq(alerts.event, "security_change")).all().at(-1);
  expect(alert?.title).toContain("turned on the panel on the tailnet example.com");
  expect(alert?.message).toContain("owner@example.com");
  expect(alert?.message).toContain(`https://${dnsName}`);
  expect(audits()[0]?.input).toMatchObject({ serve: true, tailnet: "example.com", dnsName });

  // Off again: the agent hears that too, and nothing is alerted.
  const off = await callOp(panel, tailscale.setServe, { serve: false }, { cookie: owner.cookie });
  expect(off.status).toBe(200);
  expect(getSetting(panel.deps.db, "tailscaleServe")).toBe(false);
  expect(getSetting(panel.deps.db, "tailscaleServeTailnet")).toBeUndefined();
  for (let i = 0; i < 200 && agent.requests("SyncDesired").at(-1)?.state?.settings?.tailnet; i++) await Bun.sleep(10);
  expect(agent.requests("SyncDesired").at(-1)?.state?.settings?.tailnet).toBeUndefined();
});

/** Whether the last desired state the agent got asks for the Serve entry, once it is `want` (or after 2 s). */
async function servedToAgent(want: boolean): Promise<boolean> {
  const now = () => agent.requests("SyncDesired").at(-1)?.state?.settings?.tailnet?.panel === true;
  for (let i = 0; i < 200 && now() !== want; i++) await Bun.sleep(10);
  return now();
}

const active = (name: string) => ({ state: 3, url: `https://${name}`, panelAnswers: true, proxy: "unix:/x/tailnet.sock" });

test("Serve stays on the tailnet it was turned on for: another tailnet gets nothing until the owner turns it on there", async () => {
  expect((await callOp(panel, tailscale.setServe, { serve: true }, { cookie: owner.cookie })).status).toBe(200);
  expect(getSetting(panel.deps.db, "tailscaleServeTailnet")).toEqual({ tailnet: "example.com", dnsName });
  expect(await servedToAgent(true)).toBe(true);
  await report(info({ serve: active(dnsName) }));
  expect(getSetting(panel.deps.db, "tailscaleSeen")?.working).toBe(true);

  // A DNS rename keeps the tailnet: still served.
  const renamed = "panel.cat-crocodile.ts.net";
  await report(info({ dnsName: `${renamed}.`, serve: active(renamed) }));
  expect(getSetting(panel.deps.db, "tailscaleSeen")?.working).toBe(true);
  expect((await callOp(panel, tailscale.get, {}, { cookie: owner.cookie })).body.serve.onOtherTailnet).toBe(false);

  // Signed in to another tailnet (an expired key and the wrong account, or --force-reauth): the
  // agent already moved its entry there. The path stops at once and the entry goes.
  const other = "panel.tail9999.ts.net";
  const onWork = { tailnet: "work.example", dnsName: `${other}.`, loginName: "someone@work.example" };
  await report(info({ ...onWork, serve: active(other) }));
  expect(getSetting(panel.deps.db, "tailscaleSeen")).toMatchObject({ working: false, reported: false });
  expect(await servedToAgent(false)).toBe(false);
  const view = (await callOp(panel, tailscale.get, {}, { cookie: owner.cookie })).body;
  expect(view.serve).toMatchObject({ wanted: true, tailnet: "example.com", onOtherTailnet: true });
  const securityAlerts = () => panel.deps.db.select().from(alerts).where(eq(alerts.event, "security_change")).all();
  const moved = securityAlerts().filter((a) => a.eventKey.startsWith("tailnet-moved:"));
  expect(moved).toHaveLength(1);
  expect(moved[0]?.title).toContain("from the tailnet example.com to work.example");
  expect(moved[0]?.resolvedAt).toBeNull();
  // The tailnet listener serves nothing on the new name meanwhile.
  const onTailnet = await panel.tailnetApp.handle(
    new Request("http://localhost/", { headers: { host: "localhost", "x-forwarded-host": other, "x-forwarded-proto": "https" } }),
  );
  expect(onTailnet.status).toBe(403);
  // The agent reports the entry gone: still one alert.
  await report(info({ ...onWork, serve: { state: 1 } }));
  expect(securityAlerts().filter((a) => a.eventKey.startsWith("tailnet-moved:"))).toHaveLength(1);

  // The owner turns Serve on for the new tailnet.
  const again = await callOp(panel, tailscale.setServe, { serve: true }, { cookie: owner.cookie });
  expect(again.status).toBe(200);
  expect(again.body.tailscale.serve).toMatchObject({ wanted: true, tailnet: "work.example", onOtherTailnet: false });
  expect(getSetting(panel.deps.db, "tailscaleServeTailnet")).toEqual({ tailnet: "work.example", dnsName: other });
  expect(await servedToAgent(true)).toBe(true);
  expect(securityAlerts().find((a) => a.eventKey.startsWith("tailnet-moved:"))?.resolvedAt).not.toBeNull();
  const serveOn = securityAlerts().filter((a) => a.eventKey.startsWith("tailnet-serve-on:"));
  expect(serveOn).toHaveLength(2);
  expect(serveOn.at(-1)?.title).toContain("on the tailnet work.example");
  expect(serveOn.at(-1)?.message).toContain("It was served on example.com before.");
  await report(info({ ...onWork, serve: active(other) }));
  expect(getSetting(panel.deps.db, "tailscaleSeen")?.working).toBe(true);

  // Back on the first tailnet now: that one is the other tailnet.
  await report(info({ serve: active(dnsName) }));
  expect(getSetting(panel.deps.db, "tailscaleSeen")?.working).toBe(false);
  expect(await servedToAgent(false)).toBe(false);
});

/** Serve on and working (reported active with the panel answering), IP access closed on a panel its agent runs. */
async function closedOverTailnet(onFailure: "reopen" | "stayClosed") {
  panel.deps.config.image = `ghcr.io/seylo-dev/seylo:0.2.1@sha256:${"c".repeat(64)}`;
  expect(ensurePanelService(panel.deps)).toBe("created");
  setSetting(panel.deps.db, "tailscaleServe", true);
  await report(info({ serve: { state: 3, url: `https://${dnsName}`, panelAnswers: true, proxy: "unix:/x/tailnet.sock" } }));
  setSetting(panel.deps.db, "panelServeOnIp", false);
  setSetting(panel.deps.db, "panelIpAccessOnFailure", onFailure);
  setSetting(panel.deps.db, "panelIpAccessApplied", { closed: true, agentPortClosed: false, at: Date.now(), reason: "test" });
}

test("Serve off while the tailnet is the only way in: reopen mode reopens and says where", async () => {
  await closedOverTailnet("reopen");
  const res = await callOp(panel, tailscale.setServe, { serve: false }, { cookie: owner.cookie });
  expect(res.status).toBe(200);
  expect(res.body.reopenedUrl).toMatch(/^http:\/\/.+:\d+$/);
  expect(getSetting(panel.deps.db, "tailscaleSeen")?.working).toBe(false);
  // No working path in reopen mode opens IP access, and the change is the owner's, not the system's.
  expect(getSetting(panel.deps.db, "panelIpAccessApplied")).toMatchObject({
    closed: false,
    reason: "Tailscale Serve was turned off",
    by: owner.user.email,
  });
  expect(audits().filter((row) => row.opId === "settings.ipAccessChanged")).toEqual([]);
  // The owner's choice is theirs to change: reopen mode does not flip it.
  expect(getSetting(panel.deps.db, "panelServeOnIp")).toBe(false);
});

test("Serve off while the tailnet is the only way in: stayClosed refuses unless IP access reopens too", async () => {
  await closedOverTailnet("stayClosed");
  // Refused: the panel would be left without a way in.
  const res = await callOp(panel, tailscale.setServe, { serve: false }, { cookie: owner.cookie });
  expect(res.status).toBe(409);
  expect(res.body.error.details).toMatchObject({ reason: "stayClosed" });
  expect(getSetting(panel.deps.db, "tailscaleServe")).toBe(true);

  const reopen = await callOp(panel, tailscale.setServe, { serve: false, reopenIpAccess: true }, { cookie: owner.cookie });
  expect(reopen.status).toBe(200);
  expect(reopen.body.reopenedUrl).toMatch(/^http:\/\/.+:\d+$/);
  expect(getSetting(panel.deps.db, "panelServeOnIp")).toBe(true);
  expect(getSetting(panel.deps.db, "tailscaleServe")).toBe(false);
  expect(getSetting(panel.deps.db, "panelAccessChoice")).toMatchObject({ by: owner.user.email });
  expect(getSetting(panel.deps.db, "panelIpAccessApplied")).toMatchObject({ closed: false, by: owner.user.email });
});

test("Serve off when another way in works, or IP access is open: just off", async () => {
  await closedOverTailnet("stayClosed");
  setSetting(panel.deps.db, "panelDomain", "panel.example.com");
  setSetting(panel.deps.db, "panelDomainStatus", { domain: "panel.example.com", state: "active", message: "", checkedAt: Date.now() });
  const key = createApiKey(panel, owner.user.id);
  expect((await callOp(panel, tailscale.setServe, { serve: false }, { bearer: key })).status).toBe(200);
  expect(getSetting(panel.deps.db, "panelServeOnIp")).toBe(false);
});

test("locked to Tailscale and the server moves to another tailnet: IP access reopens at once in reopen mode", async () => {
  // Serve was turned on before the panel kept the tailnet: the first report pins it.
  await closedOverTailnet("reopen");
  expect(getSetting(panel.deps.db, "tailscaleServeTailnet")).toEqual({ tailnet: "example.com", dnsName });
  const other = "panel.tail9999.ts.net";
  await report(info({ tailnet: "work.example", dnsName: `${other}.`, serve: active(other) }));
  expect(getSetting(panel.deps.db, "panelIpAccessApplied")).toMatchObject({ closed: false, by: "system" });
  const open = panel.deps.db.select().from(alerts).where(isNull(alerts.resolvedAt)).all();
  // One alert for the move, saying IP access reopened; no tailnet-stopped alert on top of it.
  expect(open.find((a) => a.eventKey.startsWith("tailnet-moved:"))?.message).toContain("IP access reopened");
  expect(open.filter((a) => a.eventKey.startsWith("tailnet-stopped:"))).toEqual([]);
  // The tailnet path no longer counts, so nothing closes IP access again an hour later.
  const access = (await callOp(panel, settingOps.panelAccess, {}, { cookie: owner.cookie })).body;
  expect(access.privatePaths).toEqual([expect.objectContaining({ kind: "tailnet", url: `https://${dnsName}`, working: false })]);
});

test("sign-in: owner only, only while signed out; the link is in memory and nowhere else", async () => {
  // Running: nothing to sign in.
  const signedIn = await callOp(panel, tailscale.signIn, {}, { cookie: owner.cookie });
  expect(signedIn.status).toBe(409);
  expect(signedIn.body.error.details).toMatchObject({ reason: "signedIn" });
  // Stopped (`tailscale down`): signed in too, and the agent would refuse the link. Only the server starts it.
  await report(info({ backendState: "Stopped" }));
  const stopped = await callOp(panel, tailscale.signIn, {}, { cookie: owner.cookie });
  expect(stopped.status).toBe(409);
  expect(stopped.body.error.details).toMatchObject({ reason: "stopped" });
  expect(stopped.body.error.message).toContain("sudo tailscale up --accept-dns=false");

  await report(info({ backendState: "NeedsLogin", tailnet: "", dnsName: "", addresses: [], loginName: "" }));
  agent.handle("TailscaleLogin", () => ({ authUrl: loginUrl, info: info({ backendState: "NeedsLogin" }) }));
  const admin = await createUser(panel, "admin");
  expect((await callOp(panel, tailscale.signIn, {}, { cookie: admin.cookie })).status).toBe(403);
  expect((await callOp(panel, tailscale.signIn, {}, { bearer: createApiKey(panel, owner.user.id) })).status).toBe(403);
  const fresh = await createUser(panel, "owner");
  stale(fresh.user.id);
  expect((await callOp(panel, tailscale.signIn, {}, { cookie: fresh.cookie })).body.error.details).toMatchObject({ reason: "reauth" });
  expect(agent.requests("TailscaleLogin")).toHaveLength(0);

  const res = await callOp(panel, tailscale.signIn, {}, { cookie: owner.cookie });
  expect(res.status).toBe(200);
  expect(res.body.url).toBe(loginUrl);
  expect(Date.parse(res.body.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
  expect(agent.requests("TailscaleLogin")).toHaveLength(1);

  // The owner's page has it while it is fresh; nobody else's does.
  expect((await callOp(panel, tailscale.get, {}, { cookie: owner.cookie })).body.signInUrl).toBe(loginUrl);
  expect((await callOp(panel, tailscale.get, {}, { cookie: admin.cookie })).body.signInUrl).toBeNull();
  expect(freshSignInLink(panel.deps, Date.now() + 11 * 60_000)).toBeNull();

  // Never stored, audited or logged.
  const stored = JSON.stringify(panel.deps.db.select().from(settingsTable).all());
  expect(stored).not.toContain("login.tailscale.com");
  expect(JSON.stringify(audits())).not.toContain("login.tailscale.com");
  expect(audits().some((row) => row.opId === "tailscale.signIn" && row.outcome === "ok")).toBe(true);
  expect(logLines.join("\n")).not.toContain("login.tailscale.com");

  // Signed in: the link is forgotten.
  await report(info());
  expect(freshSignInLink(panel.deps)).toBeNull();
});

test("sign-in refuses a link that is not http(s), and passes the agent's refusals on", async () => {
  await report(info({ backendState: "NeedsLogin" }));
  agent.handle("TailscaleLogin", () => ({ authUrl: "javascript:alert(1)" }));
  expect((await callOp(panel, tailscale.signIn, {}, { cookie: owner.cookie })).status).toBe(503);
  agent.handle("TailscaleLogin", () => {
    throw new FakeStatus(StatusCode.PERMISSION_DENIED, "no_tailnet is set in config.yml");
  });
  const refused = await callOp(panel, tailscale.signIn, {}, { cookie: owner.cookie });
  expect(refused.status).toBe(403);
  expect(refused.body.error.message).toContain("no_tailnet");
  await report(info({ backendState: "NeedsMachineAuth" }));
  expect((await callOp(panel, tailscale.signIn, {}, { cookie: owner.cookie })).body.error.details).toMatchObject({
    reason: "needsApproval",
  });
});

test("setDns turns Tailscale DNS off through the agent, for the owner only", async () => {
  agent.handle("TailscaleSetDns", (request: { acceptDns: boolean }) => ({ info: info({ acceptDns: request.acceptDns }) }));
  const admin = await createUser(panel, "admin");
  expect((await callOp(panel, tailscale.setDns, { acceptDns: false }, { cookie: admin.cookie })).status).toBe(403);
  const res = await callOp(panel, tailscale.setDns, { acceptDns: false }, { cookie: owner.cookie });
  expect(res.status).toBe(200);
  expect(res.body.acceptDns).toBe(false);
  expect(agent.requests("TailscaleSetDns")).toEqual([expect.objectContaining({ acceptDns: false })]);
  // Only false is accepted.
  expect((await callOp(panel, tailscale.setDns, { acceptDns: true } as never, { cookie: owner.cookie })).status).toBe(400);
});
