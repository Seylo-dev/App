// A deploy whose build waits for a free slot of its node's Builds at once
// (0.2.14), on the demo data: the panel marks the deployment (buildWait) and
// the service (buildWaiting), and its clone step says where it stands. The
// header, the deploy row, the log modal and the dashboard say "Waiting for a
// build slot" where they said "Building", and the build node picker says how
// many builds run and how many wait. The panel's own tests (build-queue)
// cover when a build waits. Screenshots go to $SHOTS_DIR/build-wait.

import { mkdirSync } from "node:fs";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/build-wait`;
const de = { id: svc.nodeDe, name: "de-fsn-1" };
const waitingClone = "Waiting for a build slot on de-fsn-1 - 1 ahead";

test.use({ storageState: stateFile });

/** The worker's push deploy, as the panel answers while its build is second in line on de-fsn-1. */
function waitingDeploy(): Input {
  const building = (serviceHandlers["deployments.get"] as (input: Input) => Input)({ deploymentId: "d000000000000010" }).deployment;
  return {
    ...building,
    buildWait: { node: de, position: 2 },
    steps: [
      { key: "clone", status: "running", node: null, detail: waitingClone, durationMs: 40_000 },
      { key: "build", status: "pending", node: de, detail: "", durationMs: null },
      ...building.steps.slice(2),
    ],
  };
}

test("a build waiting for a slot says so in the header, the deploy list, its steps and the dashboard", async ({ page }) => {
  const deploy = waitingDeploy();
  const worker = (serviceHandlers["services.get"] as (input: Input) => Input)({ serviceId: svc.worker });
  const list = serviceHandlers["deployments.list"] as (input: Input) => Input;
  await installDemo(page, {
    overrides: {
      "services.get": (input) =>
        input.serviceId === svc.worker ? { ...worker, status: "building", buildWaiting: true } : serviceHandlers["services.get"]?.(input),
      "deployments.list": (input) => {
        const answer = list(input);
        return { ...answer, deployments: answer.deployments.map((d: Input) => (d.id === deploy.id ? deploy : d)) };
      },
      "deployments.get": (input) =>
        input.deploymentId === deploy.id
          ? { deployment: deploy, logTopic: `deployment:${deploy.id}` }
          : serviceHandlers["deployments.get"]?.(input),
      "deployments.recent": () => ({ deployments: [{ ...deploy, serviceName: "worker", projectId: ids.acme }] }),
    },
  });
  mkdirSync(shots, { recursive: true });

  await page.goto(`/p/${ids.acme}/s/${svc.worker}/deployments`);
  const header = page.locator("main header").first();
  await expect(header.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  await expect(header.getByText("Building", { exact: true })).toHaveCount(0);
  const history = page.locator("section", { has: page.getByRole("heading", { name: "History" }) }).first();
  await expect(history.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  await page.screenshot({ path: `${shots}/deployments.png` });

  await history.getByRole("button", { name: /Full logs|Logs/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Deploy steps" }).getByText(waitingClone)).toBeVisible();
  await page.screenshot({ path: `${shots}/log-modal.png` });
  await page.keyboard.press("Escape");

  await page.goto("/");
  await expect(page.getByText("Waiting for a build slot on de-fsn-1", { exact: true })).toBeVisible();
});

test("the build node picker says how many builds run and how many wait", async ({ page }) => {
  const demo = (serviceHandlers["builds.getSettings"] as (input: Input) => Input)({ serviceId: svc.api });
  await installDemo(page, {
    overrides: {
      "builds.getSettings": () => ({
        settings: demo.settings,
        nodes: [
          { id: svc.nodeDe, name: "de-fsn-1", canBuild: true, online: true, hasBuildx: true, queued: 3, running: 1, waiting: 2 },
          { id: svc.nodeUs, name: "us-ash-1", canBuild: true, online: true, hasBuildx: true, queued: 1, running: 1, waiting: 0 },
        ],
      }),
    },
  });
  await page.goto(`/p/${svc.project}/s/${svc.api}/source`);
  await page.getByRole("combobox", { name: "Build node" }).click();
  await expect(page.getByRole("option", { name: "de-fsn-1 · 1 running, 2 waiting" })).toBeVisible();
  await expect(page.getByRole("option", { name: "us-ash-1 · 1 running" })).toBeVisible();
  await page.screenshot({ path: `${shots}/build-node.png` });
});
