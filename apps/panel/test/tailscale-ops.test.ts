// The tailscale ops (added in 0.2.1) against a fake panel node agent that
// reports the server's tailscaled: what tailscale.get shows and to whom,
// who may turn Serve on (the owner, from a fresh browser session over HTTP:
// never an API key, another role, MCP or the assistant), every reason Serve
// cannot be turned on, the switch reaching the agent in NodeSettings,
// turning Serve off while the tailnet is the only way in, and the sign-in
// link: owner only, memory only, never in the audit log, a log line or
// panel.db.

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { type OpInput, tailscale } from "@seylo/ops";
import { StatusCode } from "@seylo/proto";
import { desc, eq } from "drizzle-orm";
import pino from "pino";
import { alerts, auditLog, sessions, settings as settingsTable } from "../src/db/schema";
import * as ipAccess from "../src/modules/settings/ip-access";
import { freshSignInLink } from "../src/modules/tailscale/sign-in";
import type { OpCall } from "../src/ops/pipeline";
import { getSetting, setSetting } from "../src/settings";
import { allCapabilities, type FakeAgent, FakeStatus } from "./fake-agent";
import { callOp, createApiKey, createUser, sessionKeyOf, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen } from "./hub-helpers";

const dnsName = "panel.tail1234.ts.net";
const loginUrl = "https://login.tailscale.com/a/5f3e9c1d2b";
const capabilities = [...allCapabilities, "tailnet.serve.v1"];

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
  expect(got.serve).toEqual({ wanted: false, state: "active", url: `https://${dnsName}`, message: "", panelAnswers: true });
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
  for (let i = 0; i < 200 && agent.requests("SyncDesired").at(-1)?.state?.settings?.tailnet; i++) await Bun.sleep(10);
  expect(agent.requests("SyncDesired").at(-1)?.state?.settings?.tailnet).toBeUndefined();
});

/** Serve on and working (reported active with the panel answering), IP access closed. */
async function closedOverTailnet(onFailure: "reopen" | "stayClosed") {
  setSetting(panel.deps.db, "tailscaleServe", true);
  await report(info({ serve: { state: 3, url: `https://${dnsName}`, panelAnswers: true, proxy: "unix:/x/tailnet.sock" } }));
  setSetting(panel.deps.db, "panelServeOnIp", false);
  setSetting(panel.deps.db, "panelIpAccessOnFailure", onFailure);
  setSetting(panel.deps.db, "panelIpAccessApplied", { closed: true, agentPortClosed: false, at: Date.now(), reason: "test" });
}

test("Serve off while the tailnet is the only way in: reopen mode reopens and says where", async () => {
  await closedOverTailnet("reopen");
  // Stands in for WP-F2b's rule: no working path in reopen mode opens IP access.
  const apply = spyOn(ipAccess, "applyPanelIpAccess").mockImplementation((deps, reason) => {
    const applied = { closed: false, agentPortClosed: false, at: Date.now(), reason };
    setSetting(deps.db, "panelIpAccessApplied", applied);
    return applied;
  });
  try {
    const res = await callOp(panel, tailscale.setServe, { serve: false }, { cookie: owner.cookie });
    expect(res.status).toBe(200);
    expect(res.body.reopenedUrl).toMatch(/^http:\/\/.+:\d+$/);
    expect(apply).toHaveBeenCalledWith(expect.anything(), "Tailscale Serve was turned off");
    expect(getSetting(panel.deps.db, "tailscaleSeen")?.working).toBe(false);
    // The owner's choice is theirs to change: reopen mode does not flip it.
    expect(getSetting(panel.deps.db, "panelServeOnIp")).toBe(false);
  } finally {
    apply.mockRestore();
  }
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
  expect(getSetting(panel.deps.db, "panelServeOnIp")).toBe(true);
  expect(getSetting(panel.deps.db, "tailscaleServe")).toBe(false);
});

test("Serve off when another way in works, or IP access is open: just off", async () => {
  await closedOverTailnet("stayClosed");
  setSetting(panel.deps.db, "panelDomain", "panel.example.com");
  setSetting(panel.deps.db, "panelDomainStatus", { domain: "panel.example.com", state: "active", message: "", checkedAt: Date.now() });
  const key = createApiKey(panel, owner.user.id);
  expect((await callOp(panel, tailscale.setServe, { serve: false }, { bearer: key })).status).toBe(200);
  expect(getSetting(panel.deps.db, "panelServeOnIp")).toBe(false);
});

test("sign-in: owner only, only while signed out; the link is in memory and nowhere else", async () => {
  // Running: nothing to sign in.
  const signedIn = await callOp(panel, tailscale.signIn, {}, { cookie: owner.cookie });
  expect(signedIn.status).toBe(409);
  expect(signedIn.body.error.details).toMatchObject({ reason: "signedIn" });

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
