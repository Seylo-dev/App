// IP:port links come with the command that opens the port in the node's
// host firewall when its last health check found one.

import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { nodes } from "../src/db/schema";
import { firewallHint } from "../src/modules/exposures/logic";
import { testPanel } from "./helpers";
import { seedNode } from "./seed-helpers";

test("the hint follows the firewall the health check found", () => {
  const panel = testPanel({ modules: [] });
  const node = seedNode(panel);
  expect(firewallHint(panel.deps.db, node.id, 41203)).toBeNull();
  const report = (detail: string) => ({
    results: [{ id: "network.firewall", title: "Firewall", status: "pass" as const, detail, fixHint: "" }],
  });
  panel.deps.db
    .update(nodes)
    .set({ healthReport: report("ufw is active and allows ports 80 and 443") })
    .where(eq(nodes.id, node.id))
    .run();
  expect(firewallHint(panel.deps.db, node.id, 41203)).toBe("ufw allow 41203/tcp");
  panel.deps.db
    .update(nodes)
    .set({ healthReport: report("firewalld is active and allows ports 80 and 443") })
    .where(eq(nodes.id, node.id))
    .run();
  expect(firewallHint(panel.deps.db, node.id, 41203)).toContain("--add-port=41203/tcp");
  panel.deps.db
    .update(nodes)
    .set({ healthReport: report("no host firewall is active; make sure your provider's firewall allows ports 80 and 443") })
    .where(eq(nodes.id, node.id))
    .run();
  expect(firewallHint(panel.deps.db, node.id, 41203)).toBeNull();
  panel.close();
});
