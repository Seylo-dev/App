// A name the panel's check cannot resolve is never requested by name: a
// hostile name server could answer the check with SERVFAIL and the request
// with 169.254.169.254 (DNS rebinding through the failure path).

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { git as gitOps, uptime } from "@seylo/ops";
import { eq } from "drizzle-orm";
import { uptimeChecks } from "../src/db/schema";
import { listRemoteRefs } from "../src/modules/git/remote";
import { setProbeFetch } from "../src/modules/uptime/checks";
import { probe } from "../src/modules/uptime/probe";
import { checkTarget, setTargetResolver } from "../src/modules/uptime/targets";
import { setSetting } from "../src/settings";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
  setSetting(panel.deps.db, "uptimeAllowInternalTargets", false);
  setTargetResolver(async (host) => {
    if (host === "empty.example.com") return [];
    throw Object.assign(new Error(`queryA ESERVFAIL ${host}`), { code: "ESERVFAIL" });
  });
});
afterEach(() => {
  setTargetResolver(null);
  setProbeFetch(undefined);
  panel.close();
});

test("a lookup that fails or answers nothing is not ok", async () => {
  expect(await checkTarget(panel.deps, "http://rebind.example.com/")).toEqual({
    ok: false,
    reason: "unresolvable",
    address: "rebind.example.com",
  });
  expect(await checkTarget(panel.deps, "http://empty.example.com/")).toMatchObject({ ok: false, reason: "unresolvable" });
  // Only the admin setting means "by name".
  expect(await checkTarget(panel.deps, "http://rebind.example.com/", { allowInternal: true })).toEqual({
    ok: true,
    address: null,
    byName: true,
  });
});

test("probes and git reads never resolve a name the check did not vet", async () => {
  const spy = mock(async () => new Response("ok"));
  const result = await probe(
    {
      url: "http://rebind.example.com/",
      address: null,
      method: "GET",
      expectedStatus: 200,
      timeoutMs: 1000,
      keyword: null,
      maxLatencyMs: null,
    },
    spy,
  );
  expect(result).toMatchObject({ ok: false, error: "Not checked: the name did not resolve" });
  expect(spy).not.toHaveBeenCalled();
  await expect(listRemoteRefs("https://rebind.example.com/team/app.git")).rejects.toThrow("did not resolve");
  await expect(listRemoteRefs("git@rebind.example.com:team/app.git", { sshPrivateKey: "x" })).rejects.toThrow("did not resolve");
});

test("a saved check whose name stops resolving sends nothing", async () => {
  const { cookie } = await createUser(panel, "owner");
  const project = seedProject(panel);
  const service = seedService(panel, { projectId: project.id, name: "web", nodeIds: [] });
  // A new domain that does not resolve yet may be saved; it is checked again before every probe.
  const created = await callOp(panel, uptime.create, { serviceId: service.id, name: "x", url: "http://rebind.example.com/" }, { cookie });
  expect(created.status).toBe(200);
  const spy = mock(async () => new Response("ok"));
  setProbeFetch(spy);
  await panel.runner.runDue(panel.deps);
  const row = panel.deps.db.select().from(uptimeChecks).where(eq(uptimeChecks.id, created.body.id)).get();
  expect(row?.lastError).toBe("Not checked: the name did not resolve");
  expect(spy).not.toHaveBeenCalled();
});

test("git.branches refuses a name that does not resolve for members", async () => {
  const project = seedProject(panel);
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "project", project.id, ["services.create", "services.edit"]);
  const res = await callOp(
    panel,
    gitOps.branches,
    { projectId: project.id, url: "https://rebind.example.com/team/app.git" },
    {
      cookie: member.cookie,
    },
  );
  expect(res.status).toBe(400);
  expect(res.body.error.details.reason).toBe("unresolvable");
});
