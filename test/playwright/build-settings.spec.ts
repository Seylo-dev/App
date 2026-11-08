// The Build card of a service's Source tab with the demo data (demo/*.ts):
// the build node picker shows why a node is not offered (Can build off,
// docker buildx missing, offline), and Save sends the build node only when
// it changed, so a pinned node that lost buildx since does not block saving
// anything else. The ops are answered in the browser; the panel's own tests
// (pick-build-node) cover what builds.updateSettings refuses.

import type { Page } from "@playwright/test";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

/** Op requests the page sent, by op id. */
function recordOps(page: Page) {
  const sent: Record<string, Input[]> = {};
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match || request.method() !== "POST") return;
    const id = match[1] as string;
    (sent[id] ??= []).push((request.postDataJSON() as Input | null) ?? {});
  });
  return sent;
}

const buildCard = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Build", exact: true, level: 2 }) });

test.describe("build settings", () => {
  test.use({ storageState: stateFile });

  test("a node without docker buildx is not offered, and a pinned one does not block saving the rest", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const demo = (serviceHandlers["builds.getSettings"] as (input: Input) => Input)({ serviceId: svc.api });
    let settings: Input = { ...demo.settings, buildNodeId: svc.nodeDe };
    await installDemo(page, {
      overrides: {
        "builds.getSettings": () => ({
          settings,
          nodes: [
            { id: svc.nodeDe, name: "de-fsn-1", canBuild: true, online: true, hasBuildx: false, queued: 0 },
            { id: svc.nodeUs, name: "us-ash-1", canBuild: true, online: true, hasBuildx: true, queued: 0 },
          ],
        }),
        "builds.updateSettings": (input: Input) => {
          const { serviceId: _, ...changes } = input;
          settings = { ...settings, ...changes };
          return settings;
        },
      },
    });
    const sent = recordOps(page);
    await page.goto(`/p/${svc.project}/s/${svc.api}/source`);
    const card = buildCard(page);
    const node = card.getByRole("combobox", { name: "Build node" });
    await expect(node).toHaveText("de-fsn-1 · docker buildx is missing");

    // The node it has stays out of the request: only the build command changed.
    await card.getByLabel("Build command").fill("bun run build");
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => sent["builds.updateSettings"]?.length).toBe(1);
    expect(sent["builds.updateSettings"]?.[0]).toMatchObject({ serviceId: svc.api, buildCommand: "bun run build" });
    expect(sent["builds.updateSettings"]?.[0]).not.toHaveProperty("buildNodeId");

    await node.click();
    await expect(page.getByRole("option", { name: "de-fsn-1 · docker buildx is missing" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: "us-ash-1", exact: true }).click();
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => sent["builds.updateSettings"]?.length).toBe(2);
    expect(sent["builds.updateSettings"]?.[1]).toMatchObject({ buildNodeId: svc.nodeUs });
    expect(errors).toEqual([]);
  });
});
