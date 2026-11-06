// A member with env.edit on one service cannot read a sibling's secrets
// through ${{svc.VAR}}: the container resolves references whoever wrote
// them, so saving one needs the same right as seeing its value.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { env as envOps } from "@seylo/ops";
import { writeServiceEnv } from "../src/modules/env/store";
import { callOp, createUser, grant, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
beforeEach(() => {
  panel = testPanel();
});
afterEach(() => panel.close());

test("references to values the caller cannot see are refused; addresses are fine", async () => {
  const node = seedNode(panel);
  const project = seedProject(panel);
  const api = seedService(panel, { projectId: project.id, name: "api", nodeIds: [node.id] });
  const worker = seedService(panel, { projectId: project.id, name: "worker", nodeIds: [node.id] });
  writeServiceEnv(panel.deps.db, panel.deps.secrets, api.id, "STRIPE_SECRET=sk_live_hunter2\n", null);
  const member = await createUser(panel, "member");
  grant(panel, member.user.id, "service", worker.id, ["env.edit", "env.view", "services.deploy"]);

  const leak = await callOp(panel, envOps.set, { serviceId: worker.id, text: "B=${{api.STRIPE_SECRET}}\n" }, { cookie: member.cookie });
  expect(leak.status).toBe(403);
  expect(leak.body.error.details.reference).toBe("api.STRIPE_SECRET");
  const address = await callOp(panel, envOps.set, { serviceId: worker.id, text: "API=${{api.INTERNAL_URL}}\n" }, { cookie: member.cookie });
  expect(address.status).toBe(200);

  const owner = await createUser(panel, "owner");
  const allowed = await callOp(panel, envOps.set, { serviceId: worker.id, text: "B=${{api.STRIPE_SECRET}}\n" }, { cookie: owner.cookie });
  expect(allowed.status).toBe(200);
});
