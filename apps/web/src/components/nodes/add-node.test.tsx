import { expect, test } from "bun:test";
import { nodes } from "@seylo/ops";
import { t } from "../../i18n/t";
import { renderStatic } from "../../test/render";
import { AddNodeCard } from "./add-node";

test("Build images says a node that joins again keeps its own Can build setting", async () => {
  // The panel applies the token's choice to new nodes only (agent-hub handshake); a known key keeps its row.
  const html = await renderStatic(() => <AddNodeCard />, [[nodes.listJoinTokens, {}, { tokens: [] }]]);
  expect(html).toContain("A node that joins again (--force) keeps its own Can build setting from the list above.");
  expect(t("nodes.addCard.buildsOn")).toStartWith("A new node that joins builds images.");
  expect(t("nodes.addCard.buildsOff")).toStartWith("A new node that joins does not build images.");
  for (const key of ["nodes.addCard.buildsOn", "nodes.addCard.buildsOff"] as const) {
    expect(t(key)).toContain("A node that joins again keeps its own Can build setting");
  }
});
