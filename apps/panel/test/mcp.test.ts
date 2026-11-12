// The MCP server end to end on app.handle: OAuth 2.1 with PKCE (register,
// consent, code, token, refresh, revoke), the JSON-RPC endpoint (initialize,
// tools/list filtered by token scope, tools/call through the op pipeline),
// destructive calls turning into approvals a person decides, and the two
// safety switches (Ask before destructive actions, New AI tools start
// read-only).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { approvals as approvalOps, auth, databases as dbOps, env as envOps, mcp, projects as projectOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { approvals, auditLog, mcpAuthCodes, mcpClients, nodes, projects, services, sessions } from "../src/db/schema";
import { runOpAs } from "../src/modules/approvals/run-as";
import { enginesCapability } from "../src/modules/databases/engines";
import { writeServiceEnv } from "../src/modules/env/store";
import { setSetting } from "../src/settings";
import { callOp, createUser, sessionKeyOf, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, settleDeploys } from "./seed-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(async () => {
  await settleDeploys(panel);
  panel.close();
});

const origin = "http://panel.test";

async function send(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
  return panel.app.handle(new Request(`${origin}${path}`, { ...init, headers: { host: "panel.test", ...init.headers } }));
}

const formHeaders = { origin, "content-type": "application/x-www-form-urlencoded" };

/** What the bridge page's script posts: the authorize request plus the session key from the web app's storage. */
function review(query: URLSearchParams, cookie?: string, key = cookie ? (sessionKeyOf(cookie) ?? "") : "") {
  const form = new URLSearchParams(query);
  form.set("session_key", key);
  return send("/oauth/authorize", { method: "POST", headers: { ...formHeaders, ...(cookie ? { cookie } : {}) }, body: form.toString() });
}

/** The consent page's own form, as Allow posts it. */
function consentForm(html: string): URLSearchParams {
  const form = new URLSearchParams();
  for (const [, name, value] of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)) {
    form.set(name as string, (value as string).replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'"));
  }
  return form;
}

/** Same authorize request, whatever the order of its parameters. */
function sameRequest(path: string | null, query: URLSearchParams): boolean {
  const url = new URL(path ?? "", origin);
  if (url.pathname !== "/oauth/authorize") return false;
  return [...query].every(([name, value]) => url.searchParams.get(name) === value);
}

async function rpc(token: string, method: string, params?: unknown, id: number | null = 1) {
  const response = await send("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, body: response.status === 202 ? null : ((await response.json()) as any) };
}

/** Registers a client and walks the consent screen; returns the tokens. */
async function connect(cookie: string, access: "read" | "write") {
  const registered = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:33418/callback"] }),
  });
  expect(registered.status).toBe(201);
  const client = (await registered.json()) as { client_id: string };
  const verifier = "v".repeat(20) + crypto.randomUUID().replaceAll("-", "");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:33418/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
  });

  // The GET serves the bridge page whoever asks: it reads no session.
  const bridge = await send(`/oauth/authorize?${query}`, { headers: { cookie } });
  expect(bridge.status).toBe(200);
  expect(bridge.headers.get("content-security-policy")).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
  expect(await bridge.text()).not.toContain("@example.com");
  const signedOut = await review(query);
  expect(signedOut.status).toBe(303);
  expect(signedOut.headers.get("location")).toStartWith(`${origin}/login?redirect=%2Foauth%2Fauthorize`);
  // The cookie without the session key from the web app's storage is no session.
  expect((await review(query, cookie, "")).status).toBe(303);

  const consent = await review(query, cookie);
  const html = await consent.text();
  expect(consent.status).toBe(200);
  expect(consent.headers.get("x-frame-options")).toBe("DENY");
  expect(html).toContain("Connect an app at 127.0.0.1:33418?");
  expect(html).toContain('Claude Code</strong><span class="tag">name not verified</span>');

  const form = consentForm(html);
  form.set("access", access);
  form.set("decision", "allow");
  const crossSite = await send("/oauth/authorize", {
    method: "POST",
    headers: { ...formHeaders, cookie, origin: "https://evil.example" },
    body: form.toString(),
  });
  expect(crossSite.status).toBe(403);
  // The pages ask for same-origin referrers: with no-referrer a browser sends "Origin: null" on these posts.
  expect(consent.headers.get("referrer-policy")).toBe("same-origin");
  expect(html).toContain('<meta name="referrer" content="same-origin" />');
  // "Origin: null" counts only when the browser says the post came from this origin (Sec-Fetch-Site).
  const nullOrigin = (site: string | null) =>
    send("/oauth/authorize", {
      method: "POST",
      headers: { ...formHeaders, cookie, origin: "null", ...(site ? { "sec-fetch-site": site } : {}) },
      body: new URLSearchParams([...form].map(([k, v]): [string, string] => [k, k === "decision" ? "deny" : v])).toString(),
    });
  expect((await nullOrigin("cross-site")).status).toBe(403);
  expect((await nullOrigin(null)).status).toBe(403);
  const withoutKey = new URLSearchParams(form);
  withoutKey.delete("session_key");
  expect(
    (await send("/oauth/authorize", { method: "POST", headers: { ...formHeaders, cookie }, body: withoutKey.toString() })).status,
  ).toBe(401);
  const allowed = await send("/oauth/authorize", {
    method: "POST",
    headers: { ...formHeaders, cookie },
    body: form.toString(),
  });
  expect(allowed.status).toBe(302);
  const back = new URL(allowed.headers.get("location") ?? "");
  expect(back.searchParams.get("state")).toBe("xyz");
  const code = back.searchParams.get("code") ?? "";

  const exchange = (verifierToSend: string) =>
    send("/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: client.client_id,
        redirect_uri: "http://127.0.0.1:33418/callback",
        code_verifier: verifierToSend,
      }).toString(),
    });
  const tokens = (await (await exchange(verifier)).json()) as { access_token: string; refresh_token: string; scope: string };
  expect(tokens.access_token).toStartWith("seylo_mcp_");
  // Codes are single use.
  expect((await exchange(verifier)).status).toBe(400);
  return { clientId: client.client_id, ...tokens };
}

test("a session signed in long ago confirms it's them on /reauth before the consent page", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  const { user, password, cookie } = await createUser(panel, "owner");
  panel.deps.db
    .update(sessions)
    .set({ createdAt: new Date(Date.now() - 60 * 60 * 1000) })
    .where(eq(sessions.userId, user.id))
    .run();
  const registered = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:33418/callback"] }),
  });
  const client = (await registered.json()) as { client_id: string };
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://127.0.0.1:33418/callback",
    code_challenge: createHash("sha256").update("v".repeat(43)).digest("base64url"),
    code_challenge_method: "S256",
    state: "xyz",
  });
  const stale = await review(query, cookie);
  expect(stale.status).toBe(303);
  const next = new URL(stale.headers.get("location") ?? "");
  expect(next.pathname).toBe("/reauth");
  expect(sameRequest(next.searchParams.get("redirect"), query)).toBe(true);
  // An Allow posted from a page opened earlier is refused too.
  const form = new URLSearchParams(query);
  form.set("decision", "allow");
  form.set("csrf", "x");
  form.set("session_key", sessionKeyOf(cookie) ?? "");
  const posted = await send("/oauth/authorize", { method: "POST", headers: { ...formHeaders, cookie }, body: form.toString() });
  expect(posted.status).toBe(403);
  expect(panel.deps.db.select().from(mcpAuthCodes).all()).toHaveLength(0);

  await callOp(panel, auth.reauth, { password }, { cookie });
  const consent = await review(query, cookie);
  expect(consent.status).toBe(200);
  expect(await consent.text()).toContain("Connect an app at 127.0.0.1:33418?");
});

test("the consent page never preselects changes, whatever scope the app asks for", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  const { cookie } = await createUser(panel, "owner");
  const registered = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Trusted Tool", redirect_uris: ["https://tool.example/callback"] }),
  });
  const client = (await registered.json()) as { client_id: string };
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://tool.example/callback",
    code_challenge: createHash("sha256").update("w".repeat(43)).digest("base64url"),
    code_challenge_method: "S256",
    scope: "mcp:read mcp:write",
  });
  const html = await (await review(query, cookie)).text();
  expect(html).toContain('<input type="radio" name="access" value="read" checked />');
  expect(html).toContain('<input type="radio" name="access" value="write" />');
  expect(html).toContain("It asked for read and change access.");
  // The address the answer goes to identifies the app; its self-chosen name is marked.
  expect(html).toContain("Connect an app at tool.example?");
  expect(html).toContain("name not verified");

  // Allow without picking anything is read only.
  const form = consentForm(html);
  form.set("decision", "allow");
  const allowed = await send("/oauth/authorize", { method: "POST", headers: { ...formHeaders, cookie }, body: form.toString() });
  expect(allowed.status).toBe(302);
  expect(
    panel.deps.db
      .select()
      .from(mcpAuthCodes)
      .all()
      .map((row) => row.readOnly),
  ).toEqual([true]);
});

test("the endpoint is off by default and asks for OAuth without a token", async () => {
  expect((await rpc("x", "ping")).status).toBe(403);
  setSetting(panel.deps.db, "mcpEnabled", true);
  const response = await send("/mcp", { method: "POST", body: "{}" });
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`);
  const meta = (await (await send("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
  expect(meta).toMatchObject({ issuer: origin, code_challenge_methods_supported: ["S256"], token_endpoint: `${origin}/oauth/token` });
  expect((await send("/mcp")).status).toBe(405);
});

test("OAuth read-only token: initialize, filtered tools, calls through the pipeline, refresh and revoke", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  const { cookie } = await createUser(panel, "owner");
  const tokens = await connect(cookie, "read");
  expect(tokens.scope).toBe("mcp:read");
  // Consent is in the audit log: who let which app in, with what access. Anonymous registration is not
  // (a flood of registrations must not fill the activity log).
  const events = panel.deps.db
    .select()
    .from(auditLog)
    .all()
    .filter((r) => r.opId === "mcp.registerClient" || r.opId === "mcp.authorizeClient");
  expect(events.map((r) => [r.opId, r.actorType, (r.input as Record<string, unknown>).clientName])).toEqual([
    ["mcp.authorizeClient", "user", "Claude Code"],
  ]);
  expect(events[0]?.input).toMatchObject({ clientId: tokens.clientId, decision: "allow", access: "read" });

  const init = await rpc(tokens.access_token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "seylo" } });
  expect((await rpc(tokens.access_token, "notifications/initialized", undefined, null)).status).toBe(202);

  const list = await rpc(tokens.access_token, "tools/list");
  const names = list.body.result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain("projects_list");
  expect(names).not.toContain("projects_create");
  expect(list.body.result.tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);

  panel.deps.db.insert(projects).values({ name: "Shop", nameKey: "shop" }).run();
  const called = await rpc(tokens.access_token, "tools/call", { name: "projects_list", arguments: {} });
  expect(called.body.result.isError).toBe(false);
  expect(JSON.stringify(called.body.result.structuredContent)).toContain("Shop");
  const refused = await rpc(tokens.access_token, "tools/call", { name: "projects_create", arguments: { name: "x" } });
  expect(refused.body.result).toMatchObject({ isError: true });
  expect(refused.body.result.content[0].text).toContain("FORBIDDEN");
  expect((await rpc(tokens.access_token, "tools/call", { name: "nope" })).body.error.code).toBe(-32602);
  expect((await rpc(tokens.access_token, "resources/list")).body.error.code).toBe(-32601);
  const audited = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "projects.create")).all();
  expect(audited.at(-1)).toMatchObject({ actorType: "mcp", outcome: "error" });

  const refreshed = await send("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: tokens.clientId }),
  });
  const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
  expect(next.access_token).not.toBe(tokens.access_token);
  expect((await rpc(tokens.access_token, "ping")).status).toBe(401);
  expect((await rpc(next.access_token, "ping")).body.result).toEqual({});

  const clients = await callOp(panel, mcp.clients, {}, { cookie });
  expect(clients.body.clients).toMatchObject([{ name: "Claude Code", activeTokens: 1 }]);
  await send("/oauth/revoke", { method: "POST", body: new URLSearchParams({ token: next.access_token }).toString() });
  expect((await rpc(next.access_token, "ping")).status).toBe(401);
});

test("destructive tool calls wait for a person; approving runs them as the approver", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  const owner = await createUser(panel, "owner");
  const tokens = await connect(owner.cookie, "write");
  const created = await rpc(tokens.access_token, "tools/call", { name: "projects_create", arguments: { name: "Temp" } });
  expect(created.body.result.isError).toBe(false);
  const projectId = created.body.result.structuredContent.id as string;

  const asked = await rpc(tokens.access_token, "tools/call", { name: "projects_delete", arguments: { projectId, confirmName: "Temp" } });
  expect(asked.body.result.isError).toBe(true);
  expect(asked.body.result.content[0].text).toContain("needs a person's approval");
  const pending = await callOp(panel, approvalOps.list, {}, { cookie: owner.cookie });
  expect(pending.body.pendingCount).toBe(1);
  const approval = pending.body.approvals[0];
  expect(approval).toMatchObject({
    opId: "projects.delete",
    opKind: "destructive",
    via: "mcp",
    status: "pending",
    target: { type: "project", id: projectId, name: "Temp" },
    requestedBy: { clientName: "Claude Code" },
  });
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeDefined();

  // The model can read the approval but cannot decide it, not even through the REST API with its token.
  const viaTool = await rpc(tokens.access_token, "tools/call", { name: "approvals_get", arguments: { approvalId: approval.id } });
  expect(viaTool.body.result.structuredContent.status).toBe("pending");
  expect((await callOp(panel, approvalOps.approve, { approvalId: approval.id }, { bearer: tokens.access_token })).status).toBe(403);

  const member = await createUser(panel, "member");
  expect((await callOp(panel, approvalOps.approve, { approvalId: approval.id }, { cookie: member.cookie })).status).toBe(404);

  const approved = await callOp(panel, approvalOps.approve, { approvalId: approval.id }, { cookie: owner.cookie, origin });
  expect(approved.status).toBe(200);
  expect(approved.body).toMatchObject({ status: "executed", decidedBy: { id: owner.user.id } });
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, projectId)).get()).toBeUndefined();
  const audit = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "projects.delete")).all();
  expect(audit.at(-1)).toMatchObject({ outcome: "ok", approvalId: approval.id });
  expect((await callOp(panel, approvalOps.approve, { approvalId: approval.id }, { cookie: owner.cookie })).status).toBe(409);

  // Denied and expired requests never run.
  const again = await rpc(tokens.access_token, "tools/call", { name: "projects_create", arguments: { name: "Keep" } });
  const keepId = again.body.result.structuredContent.id as string;
  await rpc(tokens.access_token, "tools/call", { name: "projects_delete", arguments: { projectId: keepId, confirmName: "Keep" } });
  const second = (await callOp(panel, approvalOps.list, {}, { cookie: owner.cookie })).body.approvals[0];
  const denied = await callOp(panel, approvalOps.deny, { approvalId: second.id, note: "not now" }, { cookie: owner.cookie });
  expect(denied.body.status).toBe("rejected");
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, keepId)).get()).toBeDefined();

  await rpc(tokens.access_token, "tools/call", { name: "projects_delete", arguments: { projectId: keepId, confirmName: "Keep" } });
  panel.deps.db
    .update(approvals)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(approvals.status, "pending"))
    .run();
  const all = await callOp(panel, approvalOps.list, { status: "all" }, { cookie: owner.cookie });
  expect(all.body.approvals.map((a: { status: string }) => a.status)).toEqual(["expired", "rejected", "executed"]);
  expect(all.body.pendingCount).toBe(0);
});

test("mcp.info and switching the server", async () => {
  const { cookie } = await createUser(panel, "owner");
  const info = await callOp(panel, mcp.info, {}, { cookie });
  expect(info.body).toMatchObject({
    enabled: false,
    askBeforeDestructive: true,
    readOnlyByDefault: true,
    url: "http://localhost:3000/mcp",
  });
  expect(info.body.snippets["claude-code"]).toBe("claude mcp add --transport http --scope user seylo http://localhost:3000/mcp");
  expect(info.body.installLinks.cursor).toStartWith("https://cursor.com/en/install-mcp?name=seylo&config=");
  expect(info.body.tools.total).toBeGreaterThan(info.body.tools.destructive);
  const on = await callOp(panel, mcp.update, { enabled: true }, { cookie });
  expect(on.body).toMatchObject({ enabled: true, askBeforeDestructive: true, readOnlyByDefault: true });
  // Each switch on its own: fields left out keep their value.
  const asks = await callOp(panel, mcp.update, { askBeforeDestructive: false }, { cookie });
  expect(asks.body).toMatchObject({ enabled: true, askBeforeDestructive: false, readOnlyByDefault: true });
  const writes = await callOp(panel, mcp.update, { readOnlyByDefault: false }, { cookie });
  expect(writes.body).toMatchObject({ enabled: true, askBeforeDestructive: false, readOnlyByDefault: false });
  const audited = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "mcp.update")).all();
  expect(audited.map((row) => row.input)).toEqual([{ enabled: true }, { askBeforeDestructive: false }, { readOnlyByDefault: false }]);
  const member = await createUser(panel, "member");
  expect((await callOp(panel, mcp.update, { enabled: false }, { cookie: member.cookie })).status).toBe(403);
  expect((await callOp(panel, mcp.update, { askBeforeDestructive: true }, { cookie: member.cookie })).status).toBe(403);
  expect((await callOp(panel, mcp.info, {}, { cookie })).body).toMatchObject({ askBeforeDestructive: false, readOnlyByDefault: false });
});

test("Ask before destructive actions off: an MCP token's destructive call runs right away, audited; read-only tokens and the assistant still cannot", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  const owner = await createUser(panel, "owner");
  const writer = await connect(owner.cookie, "write");
  const reader = await connect(owner.cookie, "read");
  const createProject = async (name: string) => {
    const created = await rpc(writer.access_token, "tools/call", { name: "projects_create", arguments: { name } });
    expect(created.body.result.isError).toBe(false);
    return created.body.result.structuredContent.id as string;
  };
  const deleteProject = (token: string, projectId: string, confirmName: string) =>
    rpc(token, "tools/call", { name: "projects_delete", arguments: { projectId, confirmName } });
  const pendingApprovals = () => panel.deps.db.select().from(approvals).where(eq(approvals.status, "pending")).all();

  // On (the default): the call becomes an approval and nothing is deleted.
  const kept = await createProject("Kept");
  expect((await deleteProject(writer.access_token, kept, "Kept")).body.result.content[0].text).toContain("needs a person's approval");
  expect(pendingApprovals()).toHaveLength(1);
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, kept)).get()).toBeDefined();

  expect((await callOp(panel, mcp.update, { askBeforeDestructive: false }, { cookie: owner.cookie })).status).toBe(200);
  const init = await rpc(writer.access_token, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });
  expect(init.body.result.instructions).toContain("Destructive actions and backup download links run right away");

  // Off: it runs at once, with no approval, and the activity log has it.
  const temp = await createProject("Temp");
  const ran = await deleteProject(writer.access_token, temp, "Temp");
  expect(ran.body.result.isError).toBe(false);
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, temp)).get()).toBeUndefined();
  expect(pendingApprovals()).toHaveLength(1);
  const audit = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "projects.delete")).all();
  expect(audit.at(-1)).toMatchObject({ actorType: "mcp", outcome: "ok", approvalId: null, targetId: temp });

  // The same token over the REST API: MCP tokens skip the approval on any transport.
  const viaRest = await createProject("Rest");
  const rest = await callOp(panel, projectOps.remove, { projectId: viaRest, confirmName: "Rest" }, { bearer: writer.access_token });
  expect(rest.status).toBe(200);

  // A read-only token is still refused, and asks for no approval.
  const refused = await deleteProject(reader.access_token, kept, "Kept");
  expect(refused.body.result).toMatchObject({ isError: true });
  expect(refused.body.result.content[0].text).toContain("FORBIDDEN");
  expect(pendingApprovals()).toHaveLength(1);

  // The assistant's calls (transport "ai", as the person) still need a person's approval.
  const viaAi = await runOpAs(panel.deps, {
    op: projectOps.remove,
    input: { projectId: kept, confirmName: "Kept" },
    userId: owner.user.id,
    transport: "ai",
  });
  expect(viaAi).toMatchObject({ ok: false, error: { code: "APPROVAL_REQUIRED" } });
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, kept)).get()).toBeDefined();

  // Back on: approvals again.
  await callOp(panel, mcp.update, { askBeforeDestructive: true }, { cookie: owner.cookie });
  expect((await deleteProject(writer.access_token, kept, "Kept")).body.result.content[0].text).toContain("needs a person's approval");
  expect(pendingApprovals()).toHaveLength(2);
  expect(panel.deps.db.select().from(projects).where(eq(projects.id, kept)).get()).toBeDefined();
});

test("New AI tools start read-only off: the consent page preselects Read and change, and either choice still works", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  setSetting(panel.deps.db, "mcpReadOnlyByDefault", false);
  const { cookie } = await createUser(panel, "owner");
  const registered = await send("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Agent", redirect_uris: ["https://agent.example/callback"] }),
  });
  const client = (await registered.json()) as { client_id: string };
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "https://agent.example/callback",
    code_challenge: createHash("sha256").update("x".repeat(43)).digest("base64url"),
    code_challenge_method: "S256",
    // Asking for read only does not change what the panel preselects.
    scope: "mcp:read",
  });
  const html = await (await review(query, cookie)).text();
  expect(html).toContain('<input type="radio" name="access" value="read" />');
  expect(html).toContain('<input type="radio" name="access" value="write" checked />');
  expect(html).toContain("It asked for read only access.");
  expect(html).toContain("Deleting anything still waits for your approval.");

  // The person can still pick read only, and an Allow without a choice stays read only.
  const allow = async (access: "read" | "write" | null) => {
    const form = consentForm(html);
    if (access) form.set("access", access);
    form.set("decision", "allow");
    expect((await send("/oauth/authorize", { method: "POST", headers: { ...formHeaders, cookie }, body: form.toString() })).status).toBe(
      302,
    );
  };
  await allow("read");
  await allow(null);
  await allow("write");
  expect(
    panel.deps.db
      .select()
      .from(mcpAuthCodes)
      .all()
      .map((row) => row.readOnly),
  ).toEqual([true, true, false]);

  // The Read and change line says what a change token can do when nothing waits.
  setSetting(panel.deps.db, "mcpAskBeforeDestructive", false);
  const open = await (await review(query, cookie)).text();
  expect(open).toContain("Also deploy, restart, edit and delete, without asking you first.");
  // Back on: read only is preselected again.
  setSetting(panel.deps.db, "mcpReadOnlyByDefault", true);
  const safe = await (await review(query, cookie)).text();
  expect(safe).toContain('<input type="radio" name="access" value="read" checked />');
  expect(safe).toContain('<input type="radio" name="access" value="write" />');
});

test("tool results are redacted like the assistant's: env values and file contents never reach the model host", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  const { cookie, user } = await createUser(panel, "owner");
  const tokens = await connect(cookie, "read");
  const project = panel.deps.db.insert(projects).values({ name: "Shop", nameKey: "shop" }).returning().get();
  const service = panel.deps.db
    .insert(services)
    .values({ projectId: project.id, name: "api", nameKey: "api", kind: "app", spec: {} })
    .returning()
    .get();
  writeServiceEnv(panel.deps.db, panel.deps.secrets, service.id, "STRIPE_SECRET=sk_live_hunter2\nDB_PASSWORD=pw-123456\n", user.id);
  const called = await rpc(tokens.access_token, "tools/call", { name: "env_get", arguments: { serviceId: service.id } });
  expect(called.body.result.isError).toBe(false);
  const everything = JSON.stringify(called.body.result);
  expect(everything).not.toContain("sk_live_hunter2");
  expect(everything).not.toContain("pw-123456");
  // The web app (not a model) still gets the values.
  expect(JSON.stringify((await callOp(panel, envOps.get, { serviceId: service.id }, { cookie })).body)).toContain("sk_live_hunter2");
});

test("database connection details reach the model host without a password, ClickHouse's HTTP URL included", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  const { cookie } = await createUser(panel, "owner");
  const tokens = await connect(cookie, "read");
  const project = seedProject(panel);
  const node = seedNode(panel, { ipv4: "203.0.113.10" });
  panel.deps.db
    .update(nodes)
    .set({ facts: { capabilities: [enginesCapability] } })
    .where(eq(nodes.id, node.id))
    .run();
  const created = await callOp(
    panel,
    dbOps.create,
    { projectId: project.id, name: "events", engine: "clickhouse", nodeId: node.id },
    { cookie },
  );
  expect(created.status).toBe(200);
  const serviceId = created.body.serviceId;
  // The web app gets the secrets view.
  const direct = await callOp(panel, dbOps.connection, { serviceId }, { cookie });
  const { password } = direct.body.internal;
  expect(direct.body.internal.httpUrl).toContain(password);

  const called = await rpc(tokens.access_token, "tools/call", { name: "databases_connection", arguments: { serviceId } });
  expect(called.body.result.isError).toBe(false);
  expect(JSON.stringify(called.body.result)).not.toContain(password);
  expect(called.body.result.structuredContent.internal).toMatchObject({
    url: "[redacted]",
    password: "[redacted]",
    httpUrl: "[redacted]",
    user: direct.body.internal.user,
  });
});

test("registration is rate limited per address and junk clients cannot block a real one", async () => {
  setSetting(panel.deps.db, "mcpEnabled", true);
  const register = () =>
    send("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "junk", redirect_uris: ["https://x.example/cb"] }),
    });
  // The table is full of clients nobody authorized: a new registration still gets in.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (let i = 0; i < 500; i++) {
    panel.deps.db
      .insert(mcpClients)
      .values({ name: `junk ${i}`, redirectUris: ["https://x.example/cb"], createdAt: old })
      .run();
  }
  expect((await register()).status).toBe(201);
  expect(panel.deps.db.select().from(mcpClients).all()).toHaveLength(500);
  // Then the per-address limit answers 429.
  const statuses: number[] = [];
  for (let i = 0; i < 12; i++) statuses.push((await register()).status);
  expect(statuses).toContain(429);
});
