// env.setVariable and env.setSharedVariable: one variable changed, every
// other byte of the .env kept, so a model that gets env.get redacted can fix
// a hardcoded URL without wiping the values it cannot see. Also the
// hardcoded-reference hint the panel returns with every save.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { domains as domainOps, env as envOps } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { auditLog } from "../src/db/schema";
import { setDnsLookups } from "../src/modules/domains/dns";
import { resolveServiceEnv } from "../src/modules/env/desired";
import { setSetting } from "../src/settings";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService, settleDeploys } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
let ownerId: string;
beforeEach(async () => {
  panel = testPanel();
  const owner = await createUser(panel, "owner");
  cookie = owner.cookie;
  ownerId = owner.user.id;
  setDnsLookups({ resolve4: async () => [], resolve6: async () => [], resolveCname: async () => [], resolveNs: async () => [] });
});
afterEach(async () => {
  setDnsLookups(null);
  await settleDeploys(panel);
  panel.close();
});

/** api (with a domain) and web on de-fsn-1; web has a live deployment. */
async function world() {
  const project = seedProject(panel);
  const fsn = seedNode(panel, { name: "de-fsn-1", ipv4: "203.0.113.10", wildcard: "fsn.example.com" });
  const api = seedService(panel, { projectId: project.id, name: "api", ports: [3000], nodeIds: [fsn.id] });
  const web = seedService(panel, { projectId: project.id, name: "web", ports: [8080], nodeIds: [fsn.id], deployed: true });
  expect((await callOp(panel, domainOps.addAuto, { serviceId: api.id }, { cookie })).status).toBe(200);
  return { project, api, web };
}

const setText = (serviceId: string, text: string) => callOp(panel, envOps.set, { serviceId, text }, { cookie });
const setVariable = (input: { serviceId: string; key: string; value: string | null; expectedUpdatedAt?: string | null }, who = cookie) =>
  callOp(panel, envOps.setVariable, input as never, { cookie: who });
const textOf = async (serviceId: string) => (await callOp(panel, envOps.get, { serviceId }, { cookie })).body.text as string;
const codes = (body: { diagnostics: { code: string; range: { startLine: number } }[] }) =>
  body.diagnostics.map((d) => [d.code, d.range.startLine]);

describe("hardcoded-reference from the panel", () => {
  test("a saved value that spells out another service's URL comes back as a hint, without the value", async () => {
    const { web } = await world();
    const saved = await setText(web.id, "NEXT_PUBLIC_API=https://api.fsn.example.com/v1\nDB=postgres://u:p@203.0.113.10:5432/x\n");
    expect(saved.status).toBe(200);
    expect(codes(saved.body)).toEqual([["hardcoded-reference", 1]]);
    const [hint] = saved.body.diagnostics;
    expect(hint).toMatchObject({
      severity: "info",
      message: "NEXT_PUBLIC_API can use ${{api.URL}}",
      params: { key: "NEXT_PUBLIC_API", reference: "${{api.URL}}", internalReference: "${{api.INTERNAL_URL}}" },
      fixes: [{ kind: "edit", title: "Use ${{api.URL}}", edits: [{ text: "${{api.URL}}" }] }],
    });
    expect(JSON.stringify(saved.body.diagnostics)).not.toContain("fsn.example.com");
    const analyzed = await callOp(panel, envOps.analyze, { serviceId: web.id }, { cookie });
    expect(analyzed.body.diagnostics).toEqual(saved.body.diagnostics);
  });
});

describe("env.setVariable", () => {
  test("replaces the value of the last line with the key, keeping its quotes, export, comments and # @public", async () => {
    const { web } = await world();
    const before = [
      "# The browser calls the API",
      "NEXT_PUBLIC_API=https://old.example.com",
      "SECRET_TOKEN=s3cr3t-token-value",
      "# @public",
      'export NEXT_PUBLIC_API="https://api.fsn.example.com/v1" # browser',
      "",
    ].join("\n");
    await setText(web.id, before);

    const res = await setVariable({ serviceId: web.id, key: "NEXT_PUBLIC_API", value: "${{api.URL}}/v1" });
    expect(res.status).toBe(200);
    expect(await textOf(web.id)).toBe(before.replace('"https://api.fsn.example.com/v1"', '"${{api.URL}}/v1"'));
    // The hint is gone; the duplicate stays a warning on the line that lost.
    expect(codes(res.body)).toEqual([["duplicate-key", 5]]);
    expect(res.body.restartNeeded).toBe(true);
    const resolved = resolveServiceEnv(panel.deps, web.id).find((v) => v.name === "NEXT_PUBLIC_API");
    expect(resolved).toMatchObject({ value: "https://api.fsn.example.com/v1", secret: false });
    expect(resolveServiceEnv(panel.deps, web.id).find((v) => v.name === "SECRET_TOKEN")?.value).toBe("s3cr3t-token-value");

    // The same value again changes nothing the running instances lack.
    const again = await setVariable({ serviceId: web.id, key: "NEXT_PUBLIC_API", value: "${{api.URL}}/v1" });
    expect(again.body.restartNeeded).toBe(false);
  });

  test("appends a new key, removes one with null, refuses what it cannot write", async () => {
    const { web } = await world();
    await setText(web.id, "A=1");
    expect((await setVariable({ serviceId: web.id, key: "LOG_LEVEL", value: "debug" })).status).toBe(200);
    expect((await setVariable({ serviceId: web.id, key: "GREETING", value: "hello there" })).status).toBe(200);
    expect(await textOf(web.id)).toBe('A=1\nLOG_LEVEL=debug\nGREETING="hello there"\n');

    expect((await setVariable({ serviceId: web.id, key: "A", value: null })).status).toBe(200);
    expect(await textOf(web.id)).toBe('LOG_LEVEL=debug\nGREETING="hello there"\n');
    const missing = await setVariable({ serviceId: web.id, key: "A", value: null });
    expect(missing.status).toBe(404);
    expect(missing.body.error.details).toMatchObject({ field: "key", key: "A" });

    for (const key of ["1ABC", "BAD KEY", "A=B", ""]) {
      expect((await setVariable({ serviceId: web.id, key, value: "x" })).status, key).toBe(400);
    }
    const broken = await setVariable({ serviceId: web.id, key: "B", value: "tok-9f8e7d ${{api.URL" });
    expect(broken.status).toBe(400);
    expect(broken.body.error.details).toMatchObject({ field: "value", key: "B" });
    expect(JSON.stringify(broken.body)).not.toContain("tok-9f8e7d");
    expect(await textOf(web.id)).toBe('LOG_LEVEL=debug\nGREETING="hello there"\n');
  });

  test("a stale expectedUpdatedAt is a conflict; without one it edits what is saved now", async () => {
    const { web } = await world();
    const first = await setText(web.id, "A=1\n");
    await Bun.sleep(2);
    await setText(web.id, "A=1\nB=2\n");
    const stale = await setVariable({ serviceId: web.id, key: "C", value: "3", expectedUpdatedAt: first.body.updatedAt });
    expect(stale.status).toBe(409);
    expect((await setVariable({ serviceId: web.id, key: "C", value: "3" })).status).toBe(200);
    expect(await textOf(web.id)).toBe("A=1\nB=2\nC=3\n");
  });

  test("the new value's references must be readable; other lines' references are not the caller's", async () => {
    const { api, web } = await world();
    await setText(api.id, "API_SECRET=s3cr3t\n");
    await setText(web.id, "TOKEN=${{api.API_SECRET}}\n");
    const member = await createUser(panel, "member");
    grant(panel, member.user.id, "service", web.id, ["env.edit"]);

    expect((await setVariable({ serviceId: web.id, key: "LOG_LEVEL", value: "debug" }, member.cookie)).status).toBe(200);
    const hidden = await setVariable({ serviceId: web.id, key: "COPY", value: "${{api.API_SECRET}}" }, member.cookie);
    expect(hidden.status).toBe(403);
    expect(hidden.body.error.details).toMatchObject({ reference: "api.API_SECRET" });
    // Addresses are open to everyone.
    expect((await setVariable({ serviceId: web.id, key: "API", value: "${{api.INTERNAL_URL}}" }, member.cookie)).status).toBe(200);
    expect(await textOf(web.id)).toBe("TOKEN=${{api.API_SECRET}}\nLOG_LEVEL=debug\nAPI=${{api.INTERNAL_URL}}\n");
    // env.set would have to send that line back, so it is refused for the member.
    expect(
      (await callOp(panel, envOps.set, { serviceId: web.id, text: "TOKEN=${{api.API_SECRET}}\n" }, { cookie: member.cookie })).status,
    ).toBe(403);
    // Without env.edit nothing changes.
    const viewer = await createUser(panel, "member");
    grant(panel, viewer.user.id, "service", web.id, ["env.view"]);
    expect((await setVariable({ serviceId: web.id, key: "X", value: "1" }, viewer.cookie)).status).toBe(403);
  });

  test("the audit log names the key, never the value", async () => {
    const { web } = await world();
    await setVariable({ serviceId: web.id, key: "STRIPE_KEY", value: ["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_") });
    await setVariable({ serviceId: web.id, key: "STRIPE_KEY", value: null });
    const rows = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "env.setVariable")).all();
    expect(rows.map((r) => [r.outcome, r.input])).toEqual([
      ["ok", { serviceId: web.id, key: "STRIPE_KEY", value: "[redacted]" }],
      ["ok", { serviceId: web.id, key: "STRIPE_KEY", value: "[redacted]" }],
    ]);
    expect(JSON.stringify(panel.deps.db.select().from(auditLog).all())).not.toContain(["sk", "test", "4eC39HqLyjWDarjtT1zdp7dc"].join("_"));
  });
});

describe("env.setSharedVariable", () => {
  test("one shared variable: replace, append, remove; no references; the services still on the old value", async () => {
    const { project, api } = await world();
    const first = await callOp(
      panel,
      envOps.setShared,
      { projectId: project.id, text: "REGION=eu\n# @secret\nSMTP_PASSWORD=old\n" },
      { cookie },
    );
    expect(first.status).toBe(200);
    const call = (key: string, value: string | null) =>
      callOp(panel, envOps.setSharedVariable, { projectId: project.id, key, value } as never, { cookie });
    const shared = async () => (await callOp(panel, envOps.getShared, { projectId: project.id }, { cookie })).body.text;

    const replaced = await call("SMTP_PASSWORD", "n3w-pw");
    expect(replaced.status).toBe(200);
    expect(await shared()).toBe("REGION=eu\n# @secret\nSMTP_PASSWORD=n3w-pw\n");
    // api receives shared variables and is placed: it runs with the old value.
    expect(replaced.body.affectedServiceIds).toContain(api.id);

    expect((await call("LOG_LEVEL", "info")).status).toBe(200);
    expect((await call("SMTP_PASSWORD", null)).status).toBe(200);
    expect(await shared()).toBe("REGION=eu\nLOG_LEVEL=info\n");
    expect((await call("SMTP_PASSWORD", null)).status).toBe(404);
    const withReference = await call("API", "${{api.URL}}");
    expect(withReference.status).toBe(400);
    expect(withReference.body.error.details).toMatchObject({ field: "value" });

    const rows = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "env.setSharedVariable")).all();
    expect(rows.every((r) => (r.input as Record<string, unknown>).value === "[redacted]")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("n3w-pw");
  });
});

describe("MCP", () => {
  async function rpc(token: string, method: string, params?: unknown) {
    const response = await panel.app.handle(
      new Request("http://panel.test/mcp", {
        method: "POST",
        headers: {
          host: "panel.test",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
      }),
    );
    return (await response.json()) as any;
  }

  test("models get env_setVariable as a change that runs right away, and never see a value", async () => {
    const { web } = await world();
    await setText(web.id, "SECRET_TOKEN=s3cr3t-token-value\nNEXT_PUBLIC_API=https://api.fsn.example.com\n");
    setSetting(panel.deps.db, "mcpEnabled", true);
    const token = createApiKey(panel, ownerId, { kind: "mcp" });

    const tools = (await rpc(token, "tools/list")).result.tools as { name: string; annotations: Record<string, boolean> }[];
    for (const name of ["env_setVariable", "env_setSharedVariable"]) {
      expect(tools.find((t) => t.name === name)?.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }

    // What a model sees: the key and the hint's reference, not the value.
    const got = await rpc(token, "tools/call", { name: "env_get", arguments: { serviceId: web.id } });
    expect(JSON.stringify(got.result)).not.toContain("s3cr3t-token-value");
    const analyzed = await rpc(token, "tools/call", { name: "env_analyze", arguments: { serviceId: web.id } });
    expect(analyzed.result.structuredContent.diagnostics[0]).toMatchObject({
      code: "hardcoded-reference",
      params: { reference: "${{api.URL}}" },
    });
    expect(JSON.stringify(analyzed.result)).not.toContain("fsn.example.com");

    const called = await rpc(token, "tools/call", {
      name: "env_setVariable",
      arguments: { serviceId: web.id, key: "NEXT_PUBLIC_API", value: "${{api.URL}}" },
    });
    expect(called.result.isError).toBe(false);
    expect(called.result.structuredContent.diagnostics).toEqual([]);
    // The line the model could not read is still there.
    expect(await textOf(web.id)).toBe("SECRET_TOKEN=s3cr3t-token-value\nNEXT_PUBLIC_API=${{api.URL}}\n");
    const row = panel.deps.db.select().from(auditLog).where(eq(auditLog.opId, "env.setVariable")).all().at(-1);
    expect(row).toMatchObject({ actorType: "mcp", outcome: "ok", input: { key: "NEXT_PUBLIC_API", value: "[redacted]" } });
  });
});
