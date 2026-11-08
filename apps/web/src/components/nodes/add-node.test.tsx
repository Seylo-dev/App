// Add node's sentence about Docker follows the installer the join command
// really runs: on a 0.2.1 pre-release panel that is the 0.2.0 installer,
// which asks before it installs Docker. The card used to promise it always.

import { expect, test } from "bun:test";
import { nodes, system } from "@seylo/ops";
import { t } from "../../i18n/t";
import { renderStatic } from "../../test/render";
import { AddNodeCard } from "./add-node";

const info = (version: string) => ({
  name: "Seylo",
  version,
  panelId: "p",
  startedAt: "2026-11-08T00:00:00.000Z",
  nodes: { total: 1, online: 1 },
});
const render = (version?: string) => renderStatic(() => <AddNodeCard />, version ? [[system.info, {}, info(version)]] : []);
// The markup escapes apostrophes.
const html = (text: string) => text.replaceAll("'", "&#x27;");

test("a released panel says the command installs Docker", async () => {
  const out = await render("0.2.1");
  expect(out).toContain(html(t("nodes.addCard.installsDocker")));
  expect(out).not.toContain(html(t("nodes.addCard.installsDockerAsks")));
});

test("a 0.2.1 pre-release panel says the latest stable installer asks first", async () => {
  const out = await render("0.2.1-rc.3");
  expect(out).toContain(html(t("nodes.addCard.installsDockerAsks")));
  expect(out).not.toContain(html(t("nodes.addCard.installsDocker")));
});

test("nothing is promised before the panel's version is known", async () => {
  const out = await render();
  expect(out).not.toContain(html(t("nodes.addCard.installsDocker")));
  expect(out).not.toContain(html(t("nodes.addCard.installsDockerAsks")));
});

test("Build images says a node that joins again keeps its own Can build setting", async () => {
  // The panel applies the token's choice to new nodes only (agent-hub handshake); a known key keeps its row.
  const out = await renderStatic(() => <AddNodeCard />, [[nodes.listJoinTokens, {}, { tokens: [] }]]);
  expect(out).toContain("A node that joins again (--force) keeps its own Can build setting from the list above.");
  expect(t("nodes.addCard.buildsOn")).toStartWith("A new node that joins builds images.");
  expect(t("nodes.addCard.buildsOff")).toStartWith("A new node that joins does not build images.");
  for (const key of ["nodes.addCard.buildsOn", "nodes.addCard.buildsOff"] as const) {
    expect(t(key)).toContain("A node that joins again keeps its own Can build setting");
  }
});
