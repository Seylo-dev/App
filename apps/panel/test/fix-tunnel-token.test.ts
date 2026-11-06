// The panel's global Cloudflare tunnel token is the owner's tunnel: a member
// with tunnels.edit cannot start a replica of it from their project, and
// only one service runs on it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { tunnels as tunnelOps } from "@seylo/ops";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

test("token mode on the global token needs settings.edit, and one service at most", async () => {
  const owner = await createUser(panel, "owner");
  expect(
    (await callOp(panel, tunnelOps.setSettings, { token: "eyJhIjoiYiJ9-global-token-0123456789" }, { cookie: owner.cookie })).status,
  ).toBe(200);
  const node = seedNode(panel);
  const mine = seedService(panel, { projectId: seedProject(panel).id, name: "api", nodeIds: [node.id] });
  const theirs = seedService(panel, { projectId: seedProject(panel).id, name: "web", nodeIds: [node.id] });
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "service", mine.id, ["tunnels.edit", "tunnels.view"]);

  const byMember = await callOp(panel, tunnelOps.set, { serviceId: mine.id, enabled: true, mode: "token" }, { cookie: member.cookie });
  expect(byMember.status).toBe(400);
  const ownToken = await callOp(
    panel,
    tunnelOps.set,
    { serviceId: mine.id, enabled: true, mode: "token", token: "eyJhIjoiYyJ9-own-token-0123456789" },
    { cookie: member.cookie },
  );
  expect(ownToken.status).toBe(200);

  expect(
    (await callOp(panel, tunnelOps.set, { serviceId: theirs.id, enabled: true, mode: "token" }, { cookie: owner.cookie })).status,
  ).toBe(200);
  const another = seedService(panel, { projectId: seedProject(panel).id, name: "docs", nodeIds: [node.id] });
  const second = await callOp(panel, tunnelOps.set, { serviceId: another.id, enabled: true, mode: "token" }, { cookie: owner.cookie });
  expect(second.status).toBe(409);
});
