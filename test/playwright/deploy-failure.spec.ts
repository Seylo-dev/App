// A failed deploy on the demo data (0.2.16): the error is the reason alone,
// the new container's last output sits in a collapsed block of its own
// (monospace, copyable, never in the step log or the red error), in the
// deploy log dialog and under the deploy in the history, and "Use port
// 6000" switches the service to the port its app listens on and deploys.
// The Advanced tab waits for a running deploy before it changes the nodes
// or moves the service. Screenshots go to $SHOTS_DIR/deploy-failure.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { failedDeployError, failedDeployOutput, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/deploy-failure`;
/** The failed deploy (5a2c9d1) as the api's history lists it. */
const failedId = "d000000000000013";

test.use({ storageState: stateFile });
test.beforeAll(() => mkdirSync(shots, { recursive: true }));

function watchOps(page: Page) {
  const calls: { op: string; input: Input }[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match) return;
    const input = request.method() === "GET" ? Object.fromEntries(new URL(request.url()).searchParams) : (request.postDataJSON() ?? {});
    calls.push({ op: match[1] as string, input });
  });
  return (op: string) => calls.filter((c) => c.op === op).map((c) => c.input);
}

test("the history shows the reason, Use port and the app's own output apart", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page, {
    overrides: {
      "services.usePort": (input) => ({
        deploymentId: "d0000000000000a1",
        ports: [{ containerPort: input.port, protocol: "tcp" }],
        domainIds: [],
        domainsMove: "rollout",
      }),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/deployments`);
  const history = page.getByRole("region", { name: "History" }).or(page.locator("section", { has: page.getByRole("heading", { name: "History" }) }));
  await expect(history.first().getByText(failedDeployError)).toBeVisible();
  const block = history.first().locator("details").filter({ hasText: "Last output of the new container" });
  await expect(block).toHaveCount(1);
  await expect(block).toContainText("on us-ash-1");
  await expect(block).toContainText("4 lines");
  // Collapsed: the lines are there but hidden until opened.
  await expect(block.getByText("Heartbeat 2")).toBeHidden();
  await block.locator("summary").click();
  await expect(block.getByText("Server is running on port 6000")).toBeVisible();
  await page.screenshot({ path: `${shots}/history.png` });

  await history.first().getByRole("button", { name: "Use port 6000" }).click();
  await expect(page.getByText("Port 6000 set. Deploying; the domains move to it when the new version rolls out.")).toBeVisible();
  expect(calls("services.usePort")).toEqual([{ serviceId: svc.api, port: 6000, fromPort: 3000 }]);
});

test("the deploy log dialog: the error once, the output collapsed and copyable, not in the step log", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.api}/deployments`);
  const row = page
    .locator("div")
    .filter({ has: page.getByText(failedDeployError, { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Logs" }) })
    .last();
  await row.getByRole("button", { name: "Logs" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(failedDeployError, { exact: true })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Use port 6000" })).toBeVisible();
  const block = dialog.locator("details").filter({ hasText: "Last output of the new container" });
  await expect(block.getByText("Heartbeat 1")).toBeHidden();
  await block.locator("summary").click();
  await expect(block.locator("code")).toHaveText(failedDeployOutput.join("\n"));
  await block.getByRole("button", { name: /copy/i }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(failedDeployOutput.join("\n"));
  // The deploy's own log never has the app's lines.
  await expect(dialog.getByRole("log").or(dialog.locator("[aria-label='Deploy log']")).first()).not.toContainText("Heartbeat");
  await page.screenshot({ path: `${shots}/dialog.png` });
  expect(failedId).toBe("d000000000000013");
});

test("the Advanced tab waits for a running deploy to change the nodes or move the service", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  // The worker's push deploy is building.
  await page.goto(`/p/${ids.acme}/s/${svc.worker}/advanced`);
  const card = page.locator("section").filter({ has: page.getByRole("heading", { name: "Replicas and nodes" }) });
  const save = card.getByRole("button", { name: "Save" });
  // Replica counts alone may change meanwhile.
  await expect(save).toBeEnabled();
  await card.getByRole("combobox", { name: "Node" }).click();
  await page.getByRole("option", { name: "de-fsn-1" }).click();
  await expect(save).toBeDisabled();
  await expect(save).toHaveAttribute("title", "A deploy is in progress. Wait for it, or cancel it, to change the nodes.");
  await expect(card.getByText("A deploy is in progress. Wait for it, or cancel it, to change the nodes.")).toBeVisible();
  await page.screenshot({ path: `${shots}/placements-wait.png` });
  const move = page.locator("section").filter({ has: page.getByRole("heading", { name: "Move to another node" }) });
  await move.getByRole("combobox", { name: "Move to" }).click();
  await page.getByRole("option", { name: "de-fsn-1" }).click();
  const moveButton = move.getByRole("button", { name: "Move", exact: true });
  await expect(moveButton).toBeDisabled();
  await expect(moveButton).toHaveAttribute("title", "A deploy is in progress. Wait for it, or cancel it, to change the nodes.");
  expect(calls("services.setPlacements")).toEqual([]);
  expect(calls("services.move")).toEqual([]);
});
