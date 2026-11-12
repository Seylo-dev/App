// A deploy whose build waits for a free slot of its node's Builds at once
// (0.2.14), on the demo data: the panel marks the deployment (buildWait) and
// the service (buildWaiting), and its clone step says where it stands. The
// header, the deploy row, the log modal, the Overview's Deploys card, the
// Previews tab (which follows its previews' deploys on its service's topic)
// and the dashboard say "Waiting for a build slot" where they
// said "Building", every step strip starts with a pending Queued step (a
// clock, its place in line as the title) with Clone pending behind it, and
// the build node picker says how many builds run and how many wait. The
// panel's own tests (build-queue) cover when a build waits. Screenshots go
// to $SHOTS_DIR/build-wait.

import { mkdirSync } from "node:fs";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import type { Locator } from "@playwright/test";
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

/** The step strip's items: their words and whether a spinner turns in them. */
async function stripOf(list: Locator) {
  const items = list.getByRole("listitem");
  await expect(items.first()).toBeVisible();
  return items.evaluateAll((els) =>
    els.map((el) => ({
      text: (el.querySelector("b")?.textContent ?? el.textContent ?? "").trim(),
      title: el.getAttribute("title"),
      spinning: el.querySelector(".animate-spin") !== null,
      clock: el.querySelector(".tabler-icon-clock") !== null,
    })),
  );
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

  // The Overview's Deploys card: the commit line with the waiting chip, then Queued in front of Clone.
  await page.goto(`/p/${ids.acme}/s/${svc.worker}`);
  const deploys = page.locator("section", { has: page.getByRole("heading", { name: "Deploys", exact: true }) }).first();
  await expect(deploys.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  await expect(deploys.getByText("Building", { exact: true })).toHaveCount(0);
  const cardStrip = await stripOf(deploys.getByRole("list", { name: "Deploy steps" }));
  expect(cardStrip.map((s) => s.text)).toEqual(["Queued", "Clone", "Build on de-fsn-1", "Ship to us-ash-1", "Health check", "Switch traffic"]);
  expect(cardStrip[0]).toEqual({ text: "Queued", title: waitingClone, spinning: false, clock: true });
  expect(cardStrip.some((s) => s.spinning)).toBe(false);
  await deploys.screenshot({ path: `${shots}/overview-deploys.png` });

  await page.goto(`/p/${ids.acme}/s/${svc.worker}/deployments`);
  const header = page.locator("main header").first();
  await expect(header.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  await expect(header.getByText("Building", { exact: true })).toHaveCount(0);
  const history = page.locator("section", { has: page.getByRole("heading", { name: "History" }) }).first();
  await expect(history.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  const rowStrip = await stripOf(history.getByRole("list", { name: "Deploy steps" }).first());
  expect(rowStrip.slice(0, 2)).toEqual([
    { text: "Queued", title: waitingClone, spinning: false, clock: true },
    { text: "Clone", title: null, spinning: false, clock: false },
  ]);
  await page.screenshot({ path: `${shots}/deployments.png` });

  await history.getByRole("button", { name: /Full logs|Logs/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  const cards = dialog.getByRole("list", { name: "Deploy steps" });
  await expect(cards.getByText(waitingClone)).toHaveCount(1);
  const modalStrip = await stripOf(cards);
  expect(modalStrip.map((s) => s.text).slice(0, 2)).toEqual(["Queued", "Clone"]);
  expect(modalStrip[0]).toMatchObject({ spinning: false, clock: true });
  expect(modalStrip.some((s) => s.spinning)).toBe(false);
  // The time waited so far is on the Queued card; Clone has not started.
  await expect(cards.getByRole("listitem").first()).toContainText("40s");
  await page.screenshot({ path: `${shots}/log-modal.png` });
  await page.keyboard.press("Escape");

  await page.goto("/");
  await expect(page.getByText("Waiting for a build slot on de-fsn-1", { exact: true })).toBeVisible();
});

test("once the build has its slot the strip is the five steps again, Clone running", async ({ page }) => {
  const deploy = waitingDeploy();
  const started = { ...deploy, buildWait: null, steps: [{ ...deploy.steps[0], detail: "main at 9c41e07", durationMs: 2000 }, ...deploy.steps.slice(1)] };
  const list = serviceHandlers["deployments.list"] as (input: Input) => Input;
  await installDemo(page, {
    overrides: {
      "deployments.list": (input) => {
        const answer = list(input);
        return { ...answer, deployments: answer.deployments.map((d: Input) => (d.id === started.id ? started : d)) };
      },
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.worker}`);
  const deploys = page.locator("section", { has: page.getByRole("heading", { name: "Deploys", exact: true }) }).first();
  const strip = await stripOf(deploys.getByRole("list", { name: "Deploy steps" }));
  expect(strip.map((s) => s.text)).toEqual(["Clone", "Build on de-fsn-1", "Ship to us-ash-1", "Health check", "Switch traffic"]);
  expect(strip[0]).toMatchObject({ spinning: true, clock: false });
});

test("a preview whose build waits says so on the Previews tab", async ({ page }) => {
  const demo = (serviceHandlers["previews.list"] as () => Input)();
  await installDemo(page, {
    overrides: {
      "previews.list": () => ({
        previews: demo.previews.map((p: Input, i: number) => (i === 0 ? { ...p, status: "building", buildWaiting: true } : p)),
      }),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.web}/previews`);
  const row = page.getByText("#42", { exact: true }).locator("..");
  await expect(row.getByText("Waiting for a build slot", { exact: true })).toBeVisible();
  await expect(row.getByText("Building", { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${shots}/previews.png` });
});

test("the Previews tab follows its previews' deploys on the service's own topic, without the sidebar's", async ({ page }) => {
  const demo = (serviceHandlers["previews.list"] as () => Input)();
  let waiting = true;
  const senders = new Map<string, (event: object) => void>();
  await installDemo(page, {
    overrides: {
      "previews.list": () => ({
        previews: demo.previews.map((p: Input, i: number) => (i === 0 ? { ...p, status: "building", buildWaiting: waiting } : p)),
      }),
    },
    onLiveSubscribe: (topic, send) => senders.set(topic, send),
  });
  await page.goto(`/p/${ids.acme}/s/${svc.web}/previews`);
  const row = page.getByText("#42", { exact: true }).locator("..");
  await expect(row.getByText("Waiting for a build slot", { exact: true })).toBeVisible();

  // The preview's build gets its slot: the panel tells the previewed service's page (service:<id>), and
  // nothing on project:<id>, which only the sidebar follows, and only while the project is open there.
  waiting = false;
  await expect.poll(() => senders.has(`service:${svc.web}`)).toBe(true);
  senders.get(`service:${svc.web}`)?.({ type: "invalidate", ops: ["previews.list"] });
  await expect(row.getByText("Building", { exact: true })).toBeVisible();
  await expect(row.getByText("Waiting for a build slot", { exact: true })).toHaveCount(0);
});

test("the build node picker says how many builds run and how many wait", async ({ page }) => {
  const demo = (serviceHandlers["builds.getSettings"] as (input: Input) => Input)({ serviceId: svc.api });
  await installDemo(page, {
    overrides: {
      "builds.getSettings": () => ({
        settings: demo.settings,
        nodes: [
          { id: svc.nodeDe, name: "de-fsn-1", canBuild: true, online: true, hasBuildx: true, queued: 3, running: 1, waiting: 2, buildsAtOnce: 1 },
          { id: svc.nodeUs, name: "us-ash-1", canBuild: true, online: true, hasBuildx: true, queued: 1, running: 1, waiting: 0, buildsAtOnce: 1 },
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
