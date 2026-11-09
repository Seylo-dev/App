// One deploy of a service at a time, on the demo data: while the worker's
// push deploy builds, the header's Deploy says Deploying and waits, Cancel
// deploy stops that running deploy (not a newer one), and on the
// Deployments page Roll back and the Redeploy items wait too. The api,
// with nothing running, deploys as before. Screenshots go to
// $SHOTS_DIR/deploy-lock.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/deploy-lock`;
const busyHint = "A deploy is in progress. Wait for it, or cancel it, to deploy again.";

test.use({ storageState: stateFile });

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

test("while a deploy runs, Deploy waits and Cancel deploy stops the running one", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page, { overrides: { "deployments.cancel": (input) => ({ id: input.deploymentId, status: "cancelled" }) } });
  await page.goto(`/p/${ids.acme}/s/${svc.worker}`);
  const header = page.locator("main header").first();
  const deploying = header.getByRole("button", { name: "Deploying" });
  await expect(deploying).toBeDisabled();
  await expect(deploying).toHaveAttribute("title", busyHint);
  await expect(header.getByRole("button", { name: "Deploy", exact: true })).toHaveCount(0);
  mkdirSync(shots, { recursive: true });
  await page.screenshot({ path: `${shots}/header-deploying.png` });
  await header.getByRole("button", { name: "Cancel deploy" }).click();
  await expect.poll(() => calls("deployments.cancel")).toEqual([{ serviceId: svc.worker, deploymentId: "d000000000000010" }]);

  await page.goto(`/p/${ids.acme}/s/${svc.worker}/deployments`);
  const history = page.getByRole("region", { name: "History" }).or(page.locator("section", { has: page.getByRole("heading", { name: "History" }) }));
  const rollbacks = history.first().getByRole("button", { name: "Roll back" });
  await expect(rollbacks.first()).toBeVisible();
  for (const button of await rollbacks.all()) {
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute("title", busyHint);
  }
  await history.first().getByRole("button", { name: "More actions" }).nth(1).click();
  await expect(page.getByRole("menuitem", { name: "Deploy without build cache" })).toHaveAttribute("data-disabled", "");
  await expect(page.getByRole("menuitem", { name: "Redeploy this commit" })).toHaveAttribute("data-disabled", "");
  await page.screenshot({ path: `${shots}/deployments-busy.png` });
  await page.keyboard.press("Escape");
  expect(calls("deployments.deploy")).toEqual([]);
  expect(calls("deployments.rollback")).toEqual([]);
});

test("with nothing running, Deploy is enabled and deploys", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.api}`);
  const header = page.locator("main header").first();
  const deploy = header.getByRole("button", { name: "Deploy", exact: true });
  await expect(deploy).toBeEnabled();
  await expect(header.getByRole("button", { name: "Cancel deploy" })).toHaveCount(0);
  await deploy.click();
  await expect.poll(() => calls("deployments.deploy")).toEqual([{ serviceId: svc.api }]);
});
