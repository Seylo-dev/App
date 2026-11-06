// Volume names follow the agent's rule for names on disk (no dots): a name
// the agent refuses used to block every desired state sent to the node.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { services as serviceOps } from "@seylo/ops";
import { volumeName } from "../src/modules/compose/plan";
import { callOp, createUser, type TestPanel, testPanel } from "./helpers";
import { seedNode, seedProject, seedService } from "./seed-helpers";

let panel: TestPanel;
let cookie: string;
beforeEach(async () => {
  panel = testPanel();
  cookie = (await createUser(panel, "owner")).cookie;
});
afterEach(() => panel.close());

test("services.setVolumes refuses dotted names; compose names are cleaned", async () => {
  const node = seedNode(panel);
  const service = seedService(panel, { projectId: seedProject(panel).id, name: "db", nodeIds: [node.id] });
  const dotted = await callOp(
    panel,
    serviceOps.setVolumes,
    { serviceId: service.id, volumes: [{ name: "db.data", mountPath: "/data" }] },
    { cookie },
  );
  expect(dotted.status).toBe(400);
  const plain = await callOp(
    panel,
    serviceOps.setVolumes,
    { serviceId: service.id, volumes: [{ name: "db-data", mountPath: "/data" }] },
    { cookie },
  );
  expect(plain.status).toBe(200);
  expect(volumeName("pgdata.v2")).toBe("pgdata-v2");
  expect(volumeName("_cache")).toBe("cache");
  expect(volumeName("...")).toBe("data");
  expect(volumeName("A".repeat(80))).toHaveLength(60);
});
