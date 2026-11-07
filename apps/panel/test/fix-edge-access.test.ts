// PanelService.CheckEdgeAccess: a node's edge asks once a minute whether
// the user of an open tool session (a Box or a database web UI) may keep
// it. The answer uses the same permission as opening the tool
// (boxes.open / databases.openWebUi), for a user that still exists and is
// not disabled, for a service that runs on the asking node. A ticket opened
// with an API key names the key ("key:<id>"), so the key's own narrower
// rights, revocation and expiry count too.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { boxes as boxOps } from "@seylo/ops";
import { CheckEdgeAccessRequestSchema, CheckEdgeAccessResponseSchema, StatusCode } from "@seylo/proto";
import { eq } from "drizzle-orm";
import { panelCapabilities } from "../src/agent-hub/panel-service";
import { apiKeys, grants, nodes, serviceBoxes, serviceDatabases, users } from "../src/db/schema";
import type { FakeAgent, FakeStatus } from "./fake-agent";
import { callOp, createApiKey, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { joinAgent, listen, seedProject, seedService } from "./hub-helpers";

let panel: TestPanel;
let url: string;
const agents: FakeAgent[] = [];

beforeEach(() => {
  panel = testPanel();
  url = listen(panel);
});
afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.close();
  await panel.app.stop(true);
  panel.close();
});

async function join() {
  const agent = await joinAgent(panel, url);
  agents.push(agent);
  return agent;
}

const check = (agent: FakeAgent, subject: string, userId: string) =>
  agent
    .callPanel("CheckEdgeAccess", CheckEdgeAccessRequestSchema, CheckEdgeAccessResponseSchema, { subject, userId })
    .then((r) => r.allowed);

async function setup() {
  const agent = await join();
  const other = await join();
  const project = seedProject(panel);
  const box = seedService(panel, project.id, agent.nodeId, { name: "box" });
  panel.deps.db.insert(serviceBoxes).values({ serviceId: box.id }).run();
  const db = seedService(panel, project.id, agent.nodeId, { name: "pg" });
  panel.deps.db
    .insert(serviceDatabases)
    .values({ serviceId: db.id, engine: "postgres", version: "17", adminUser: "postgres", exposedUser: "app" })
    .run();
  panel.deps.db.update(nodes).set({ wildcardDomain: "n1.example.com" }).where(eq(nodes.id, agent.nodeId)).run();
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "service", box.id, ["boxes.use"]);
  grant(panel, member.user.id, "service", db.id, ["databases.tools"]);
  return { agent, other, project, box, db, member };
}

test("the panel advertises the capability", () => {
  expect(panelCapabilities).toContain("panel.edge-access.v1");
});

test("allowed while the user keeps the right; revoked, disabled or deleted users are refused", async () => {
  const { agent, box, db, member } = await setup();
  expect(await check(agent, `box:${box.id}`, member.user.id)).toBe(true);
  expect(await check(agent, `db-ui:${db.id}`, member.user.id)).toBe(true);
  // The right of one tool does not open the other.
  expect(await check(agent, `db-ui:${box.id}`, member.user.id)).toBe(false);
  expect(await check(agent, `box:${db.id}`, member.user.id)).toBe(false);

  panel.deps.db.delete(grants).where(eq(grants.userId, member.user.id)).run();
  expect(await check(agent, `box:${box.id}`, member.user.id)).toBe(false);
  expect(await check(agent, `db-ui:${db.id}`, member.user.id)).toBe(false);

  const owner = await createUser(panel, "owner");
  expect(await check(agent, `box:${box.id}`, owner.user.id)).toBe(true);
  panel.deps.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, owner.user.id)).run();
  expect(await check(agent, `box:${box.id}`, owner.user.id)).toBe(false);
  expect(await check(agent, `box:${box.id}`, "no-such-user")).toBe(false);
  expect(await check(agent, `box:${box.id}`, "")).toBe(false);
});

test("only for services on the asking node, and only known subjects", async () => {
  const { other, agent, box, member } = await setup();
  expect(await check(other, `box:${box.id}`, member.user.id)).toBe(false);
  expect(await check(agent, `status:${box.id}`, member.user.id)).toBe(false);
  expect(await check(agent, `box:${box.id}/x`, member.user.id)).toBe(false);
});

test("a ticket opened with an API key is checked again as that key: revoked, expired or narrowed keys lose it", async () => {
  const { agent, box, db, member } = await setup();
  const bearer = createApiKey(panel, member.user.id);
  const viaKey = await callOp(panel, boxOps.open, { serviceId: box.id }, { bearer });
  expect(viaKey.status).toBe(200);
  const token = new URL(viaKey.body.url).searchParams.get("t") ?? "";
  const claims = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8")) as { uid: string };
  // Before: the ticket named the key's owner, so a revoked key kept the session while the person had the right.
  const key = panel.deps.db.select().from(apiKeys).where(eq(apiKeys.userId, member.user.id)).get();
  expect(claims.uid).toBe(`key:${key?.id}`);
  expect(await check(agent, `box:${box.id}`, claims.uid)).toBe(true);

  panel.deps.db
    .update(apiKeys)
    .set({ actions: ["databases.tools"] })
    .where(eq(apiKeys.id, key?.id ?? ""))
    .run();
  expect(await check(agent, `box:${box.id}`, claims.uid)).toBe(false);
  expect(await check(agent, `db-ui:${db.id}`, claims.uid)).toBe(true);
  panel.deps.db
    .update(apiKeys)
    .set({ readOnly: true })
    .where(eq(apiKeys.id, key?.id ?? ""))
    .run();
  expect(await check(agent, `db-ui:${db.id}`, claims.uid)).toBe(false);
  panel.deps.db
    .update(apiKeys)
    .set({ readOnly: false, expiresAt: new Date(Date.now() - 1000) })
    .where(eq(apiKeys.id, key?.id ?? ""))
    .run();
  expect(await check(agent, `db-ui:${db.id}`, claims.uid)).toBe(false);
  panel.deps.db
    .update(apiKeys)
    .set({ expiresAt: null, revokedAt: new Date() })
    .where(eq(apiKeys.id, key?.id ?? ""))
    .run();
  expect(await check(agent, `db-ui:${db.id}`, claims.uid)).toBe(false);
  expect(await check(agent, `db-ui:${db.id}`, "key:no-such-key")).toBe(false);
});

test("checks are budgeted per node", async () => {
  const { agent, box, member } = await setup();
  let refused = 0;
  for (let i = 0; i < 320; i++) {
    try {
      await check(agent, `box:${box.id}`, member.user.id);
    } catch (error) {
      expect((error as FakeStatus).code).toBe(StatusCode.RESOURCE_EXHAUSTED);
      refused++;
    }
  }
  expect(refused).toBeGreaterThan(0);
  expect(refused).toBeLessThan(30);
});
