// API keys and MCP tokens limited to some projects or actions stay inside
// that scope on the signed-in ops too: account-wide ops (assistant chats,
// the person's keys, security, preferences, grants) refuse them, and the
// approvals and audit lists are cut to what the key covers. The owner's
// browser session and unscoped keys see everything as before.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ai, approvals as approvalOps, audit, auth, grants as grantOps, apiKeys as keyOps, projects } from "@seylo/ops";
import { aiConversations, apiKeys, approvals } from "../src/db/schema";
import { createApiKey, createUser, type TestPanel, testPanel } from "./helpers";
import { call, noLimits, seedService } from "./people-helpers";

let panel: TestPanel;
let owner: Awaited<ReturnType<typeof createUser>>;
let projectA: string;
let projectB: string;
let conversationId: string;

beforeEach(async () => {
  panel = testPanel({ rateLimiter: noLimits });
  owner = await createUser(panel, "owner");
  projectA = (await call(panel, projects.create, { name: "alpha" }, { cookie: owner.cookie })).body.id;
  projectB = (await call(panel, projects.create, { name: "billing" }, { cookie: owner.cookie })).body.id;
  // Audited entries in both projects.
  expect((await call(panel, projects.update, { projectId: projectA, description: "a" }, { cookie: owner.cookie })).status).toBe(200);
  expect((await call(panel, projects.update, { projectId: projectB, description: "b" }, { cookie: owner.cookie })).status).toBe(200);
  conversationId = panel.deps.db
    .insert(aiConversations)
    .values({ userId: owner.user.id, title: "billing migration plan" })
    .returning()
    .get().id;
});
afterEach(() => panel.close());

function approvalFor(serviceId: string, requestedVia: string | null) {
  return panel.deps.db
    .insert(approvals)
    .values({
      opId: "services.delete",
      inputSealed: panel.deps.secrets.seal(JSON.stringify({ serviceId }), "approval.input"),
      inputPreview: { serviceId },
      requestedByType: "mcp",
      requestedById: owner.user.id,
      requestedVia,
      targetType: "service",
      targetId: serviceId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning()
    .get().id;
}

describe("a key limited to one project and one action", () => {
  test("is refused on account-wide ops", async () => {
    const bearer = createApiKey(panel, owner.user.id, { actions: ["services.view"], projectIds: [projectA] });
    const refused = [
      await call(panel, ai.conversations, {}, { bearer }),
      await call(panel, ai.conversation, { conversationId }, { bearer }),
      await call(panel, ai.deleteConversation, { conversationId }, { bearer }),
      await call(panel, keyOps.list, {}, { bearer }),
      await call(panel, auth.security, {}, { bearer }),
      await call(panel, auth.preferences, {}, { bearer }),
      await call(panel, auth.updatePreferences, { preferences: { theme: "x" } }, { bearer }),
      await call(panel, grantOps.mine, {}, { bearer }),
    ];
    for (const res of refused)
      expect({ status: res.status, reason: res.body.error?.details?.reason }).toEqual({ status: 403, reason: "narrowedKey" });
    // The chat is still there.
    expect(panel.deps.db.select().from(aiConversations).all()).toHaveLength(1);

    // The same owner's session, and a key that is only read-only, still reach them.
    expect((await call(panel, ai.conversations, {}, { cookie: owner.cookie })).status).toBe(200);
    const readOnly = createApiKey(panel, owner.user.id, { readOnly: true });
    expect((await call(panel, ai.conversations, {}, { bearer: readOnly })).status).toBe(200);
    expect((await call(panel, keyOps.list, {}, { bearer: readOnly })).status).toBe(200);
  });

  test("sees only its own approval requests and the ones inside its scope", async () => {
    const inA = seedService(panel, projectA).id;
    const inB = seedService(panel, projectB).id;
    const bearer = createApiKey(panel, owner.user.id, { actions: ["services.*"], projectIds: [projectA], kind: "mcp" });
    const keyId = panel.deps.db.select().from(apiKeys).all().at(-1)?.id as string;
    const aimedAtA = approvalFor(inA, null);
    const aimedAtB = approvalFor(inB, null);
    const askedByKey = approvalFor(inB, keyId);

    const listed = await call(panel, approvalOps.list, { status: "all" }, { bearer });
    expect(listed.status).toBe(200);
    expect(listed.body.approvals.map((a: { id: string }) => a.id).sort()).toEqual([aimedAtA, askedByKey].sort());
    expect((await call(panel, approvalOps.get, { approvalId: aimedAtB }, { bearer })).status).toBe(404);
    expect((await call(panel, approvalOps.get, { approvalId: askedByKey }, { bearer })).status).toBe(200);

    // A key limited to other actions does not see deletes at all, except its own requests.
    const viewOnly = createApiKey(panel, owner.user.id, { actions: ["services.view"] });
    const narrow = await call(panel, approvalOps.list, { status: "all" }, { bearer: viewOnly });
    expect(narrow.body.approvals).toHaveLength(0);

    const all = await call(panel, approvalOps.list, { status: "all" }, { cookie: owner.cookie });
    expect(all.body.approvals).toHaveLength(3);
  });

  test("reads the audit log only with audit.view, and only its projects' entries", async () => {
    const noAudit = createApiKey(panel, owner.user.id, { actions: ["services.view"], projectIds: [projectA] });
    const refused = await call(panel, audit.list, {}, { bearer: noAudit });
    expect(refused.status).toBe(403);

    const scoped = createApiKey(panel, owner.user.id, { actions: ["audit.view", "services.view"], projectIds: [projectA] });
    const listed = await call(panel, audit.list, {}, { bearer: scoped });
    expect(listed.status).toBe(200);
    const projectIds = new Set(listed.body.entries.map((e: { projectId: string | null }) => e.projectId));
    expect([...projectIds]).toEqual([projectA]);
    const inB = (await call(panel, audit.list, { projectId: projectB }, { cookie: owner.cookie })).body.entries[0];
    expect(inB).toBeDefined();
    expect((await call(panel, audit.get, { entryId: inB.id }, { bearer: scoped })).status).toBe(404);

    const everything = await call(panel, audit.list, {}, { cookie: owner.cookie });
    const seen = new Set(everything.body.entries.map((e: { projectId: string | null }) => e.projectId));
    expect(seen.has(projectA) && seen.has(projectB)).toBe(true);
  });
});
