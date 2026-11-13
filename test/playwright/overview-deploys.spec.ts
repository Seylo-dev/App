// The Overview's Deploys card follows a deploy to live without a reload
// (owner report 2026-11-13: the console said generation 3 while the card
// still showed generation 2 failed, an hour old). On the demo data, with
// the api service live on gen 17 and a new deploy (gen 18) the test moves
// through its states:
// - the card shows the deploy in progress with its steps and, on one line
//   under it, the deploy that is live now; once the new one is live, that one;
// - a live socket whose path died without a close (silenceLive) is replaced
//   and the screen refetched, so the card still reaches live;
// - the Overview's list, left for the Deployments tab while the deploy went
//   live there, is fetched again on the way back (the deploy log's events no
//   longer mark it fresh);
// - the History list of a tab hidden while the deploy ended shows the end as
//   soon as the tab is shown, and its clock stops.
// Screenshots go to $SHOTS_DIR/overview-deploys.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo, liveSocketsOpened, pushLive, silenceLive } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/overview-deploys`;
const overview = `/p/${ids.acme}/s/${svc.api}`;
const de = { id: svc.nodeDe, name: "de-fsn-1" };
const message = "Ship the new checkout";
const oldLive = "Queue retries with backoff";

test.use({ storageState: stateFile });

const step = (key: string, status: string, node: unknown, detail: string, durationMs: number | null) => ({ key, status, node, detail, durationMs });

/** gen 18 of the api service in one of its states, shaped like deployments.get answers it. */
function gen18(state: "queued" | "building" | "live", createdAt: string): Input {
  const base = (serviceHandlers["deployments.get"] as (input: Input) => Input)({ deploymentId: "d000000000000010" }).deployment;
  const startedAt = state === "queued" ? null : new Date(Date.parse(createdAt) + 1000).toISOString();
  return {
    ...base,
    id: "d0000000000000a8",
    serviceId: svc.api,
    generation: 18,
    status: state,
    live: state === "live",
    trigger: "manual",
    actor: "you@example.com",
    commit: { sha: "a18b2c3d4", message, branch: "main", author: "you@example.com" },
    builtOn: de,
    buildWait: null,
    shippedTo: [de],
    image: state === "live" ? { reference: "registry.local/api", digest: `sha256:${"a".repeat(64)}`, sizeBytes: 90_000_000, shippedBytes: 1_000_000 } : null,
    steps:
      state === "queued"
        ? [
            step("clone", "pending", null, "", null),
            step("build", "pending", de, "", null),
            step("ship", "pending", de, "", null),
            step("health", "pending", null, "", null),
            step("switch", "pending", null, "", null),
          ]
        : state === "building"
          ? [
              step("clone", "ok", null, "main at a18b2c3", 1000),
              step("build", "running", de, "", null),
              step("ship", "pending", de, "", null),
              step("health", "pending", null, "", null),
              step("switch", "pending", null, "", null),
            ]
          : [
              step("clone", "ok", null, "main at a18b2c3", 1000),
              step("build", "ok", de, "Railpack, 90 MB image", 7000),
              step("ship", "ok", de, "1 MB", 1000),
              step("health", "ok", null, "GET /health 200 in 1s", 1000),
              step("switch", "ok", null, "Old container stopped", 1000),
            ],
    durationMs: state === "live" ? 12_000 : null,
    canRollback: false,
    error: null,
    createdAt,
    startedAt,
    finishedAt: state === "live" ? new Date(Date.parse(createdAt) + 12_000).toISOString() : null,
  };
}

/** The demo panel's answers about the api service's deploys, with gen 18 in whatever state the test set. */
function deployWorld() {
  const world = { next: null as Input | null, createdAt: new Date().toISOString(), listCalls: 0 };
  const list = serviceHandlers["deployments.list"] as (input: Input) => Input;
  const active = (d: Input | null) => d !== null && ["queued", "building", "deploying"].includes(d.status);
  const set = (state: "queued" | "building" | "live") => {
    world.next = gen18(state, world.createdAt);
  };
  const overrides: Record<string, (input: Input) => unknown> = {
    "deployments.list": (input) => {
      const answer = list(input);
      if (input.serviceId !== svc.api) return answer;
      if (input.limit === 5) world.listCalls++;
      const next = world.next;
      if (input.active === true || input.active === "true") return { ...answer, deployments: active(next) ? [next] : [] };
      if (!next) return answer;
      const rows = answer.deployments.map((d: Input) => (next.live && d.live ? { ...d, live: false, status: "superseded" } : d));
      return { ...answer, deployments: [next, ...rows] };
    },
    "deployments.get": (input) =>
      world.next && input.deploymentId === world.next.id
        ? { deployment: world.next, logTopic: `deployment:${world.next.id}` }
        : serviceHandlers["deployments.get"]?.(input),
    "deployments.log": (input) =>
      world.next && input.deploymentId === world.next.id
        ? { lines: [], done: !active(world.next) }
        : serviceHandlers["deployments.log"]?.(input),
    "deployments.deploy": () => {
      set("queued");
      return world.next;
    },
  };
  return { world, overrides, set };
}

/** The service:<id> invalidation the panel sends whenever one of its deploys moves. */
const deploysMoved = () =>
  pushLive(`service:${svc.api}`, {
    type: "invalidate",
    ops: ["deployments.list", "deployments.get", "deployments.log", "services.get", "builds.queue"],
  });

const deploysCard = (page: Page) => page.locator("section", { has: page.getByRole("heading", { name: "Deploys", exact: true }) }).first();
const sectionTabs = (page: Page) => page.getByRole("navigation", { name: "Service sections" });

/** The card's step strip: each step's words and whether a spinner turns in it. */
async function strip(card: Locator) {
  const items = card.getByRole("list", { name: "Deploy steps" }).getByRole("listitem");
  return items.evaluateAll((els) => els.map((el) => ({ text: (el.textContent ?? "").trim(), spinning: el.querySelector(".animate-spin") !== null })));
}

test("the card follows a deploy to live without a reload: in progress with its steps, the live one on a line under it", async ({ page }) => {
  const { overrides, set } = deployWorld();
  await installDemo(page, { overrides });
  mkdirSync(shots, { recursive: true });
  await page.goto(overview);
  const card = deploysCard(page);
  await expect(card.getByText(oldLive, { exact: true })).toBeVisible();
  await expect(card.locator('[data-slot="deploy-line"]')).toHaveCount(0);
  await page.evaluate(() => {
    (window as unknown as { notReloaded: boolean }).notReloaded = true;
  });

  // Deploy from the header: the new deploy waits in line, the live one stays on a line under it.
  await page.locator("main header").getByRole("button", { name: "Deploy", exact: true }).click();
  await expect(card.getByText(message, { exact: true })).toBeVisible();
  await expect(card.getByText("Queued", { exact: true }).first()).toBeVisible();
  const liveLine = card.locator('[data-slot="deploy-line"]');
  await expect(liveLine).toBeVisible();
  await expect(liveLine).toContainText(oldLive);
  await expect(liveLine.getByText("Live", { exact: true })).toBeVisible();
  // What the line is, for a screen reader.
  await expect(liveLine.getByText("Live now", { exact: true })).toHaveClass(/sr-only/);

  // It builds: the strip moves, the live line stays.
  set("building");
  deploysMoved();
  await expect(card.getByText("Building", { exact: true })).toBeVisible();
  expect(await strip(card)).toEqual([
    { text: "Clone", spinning: false },
    { text: "Build on de-fsn-1", spinning: true },
    { text: "Ship to de-fsn-1", spinning: false },
    { text: "Health check", spinning: false },
    { text: "Switch traffic", spinning: false },
  ]);
  await expect(liveLine).toContainText(oldLive);
  // Its own clock, from the panel's startedAt.
  await expect(card.getByText(/^\d+:\d\d$/)).toBeVisible();
  await card.screenshot({ path: `${shots}/in-progress.png` });

  // Live: the card is about it now, and nothing in progress is left.
  set("live");
  deploysMoved();
  await expect(card.getByText(message, { exact: true })).toBeVisible();
  await expect(card.getByText("Live", { exact: true })).toBeVisible();
  await expect(card.getByText("Building", { exact: true })).toHaveCount(0);
  await expect(card.locator('[data-slot="deploy-line"]')).toHaveCount(0);
  await expect(card.getByText(oldLive, { exact: true })).toHaveCount(0);
  await expect(card.getByText(/^\d+:\d\d$/)).toHaveCount(0);
  expect(await strip(card)).toEqual([
    { text: "Clone", spinning: false },
    { text: "Build on de-fsn-1", spinning: false },
    { text: "Ship to de-fsn-1", spinning: false },
    { text: "Health check", spinning: false },
    { text: "Switch traffic", spinning: false },
  ]);
  expect(await page.evaluate(() => (window as unknown as { notReloaded?: boolean }).notReloaded)).toBe(true);
  await card.screenshot({ path: `${shots}/live.png` });
});

test("a live socket whose path died without a close is replaced, and the card still reaches the new live deploy", async ({ page }) => {
  test.setTimeout(90_000);
  const { overrides, set } = deployWorld();
  // A short heartbeat, so the client gives up on a silent socket after 2 s and its 10 s of slack.
  await installDemo(page, { overrides, liveHeartbeatMs: 1000 });
  await page.goto(overview);
  const card = deploysCard(page);
  await expect(card.getByText(oldLive, { exact: true })).toBeVisible();
  // The page heard a heartbeat, so it knows this panel sends them.
  await page.waitForTimeout(1500);
  const opened = liveSocketsOpened();

  // The laptop changed networks: the socket stays open for the page, but nothing comes any more. A push
  // deploy runs and goes live meanwhile; its events never arrive.
  silenceLive();
  set("live");
  deploysMoved();
  // Before: the card kept gen 17 for good (no poll while nothing moved, the socket looked fine).
  // Now: the silent socket is replaced within about 17 s, everything on screen is refetched, and the card
  // shows gen 18 well before its idle poll (60 s) would.
  await expect(card.getByText(message, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Live", { exact: true })).toBeVisible();
  expect(liveSocketsOpened()).toBe(opened + 1);
});

test("back on the Overview from the Deployments tab, where the deploy went live, the card shows it", async ({ page }) => {
  const { world, overrides, set } = deployWorld();
  const sends = new Map<string, (event: object) => void>();
  await installDemo(page, { overrides, onLiveSubscribe: (topic, send) => sends.set(topic, send) });
  await page.goto(overview);
  const card = deploysCard(page);
  await expect(card.getByText(oldLive, { exact: true })).toBeVisible();

  await sectionTabs(page).getByRole("link", { name: "Deployments" }).click();
  const history = page.getByRole("region", { name: "History" });
  await expect(history.getByText(oldLive, { exact: true })).toBeVisible();

  // A push deploy starts and builds; the side log follows it and gets its state every 400 ms.
  set("building");
  deploysMoved();
  await expect(history.getByText(message, { exact: true })).toBeVisible();
  const topic = `deployment:${world.next?.id}`;
  await expect.poll(() => sends.has(topic)).toBe(true);
  sends.get(topic)?.({ type: "deployment", deployment: world.next });

  // It goes live: the service's invalidation (the history refetches and shows it), then the log's last tick
  // with the live state.
  set("live");
  deploysMoved();
  const newRow = history.locator("div.border-t", { has: page.getByText(message, { exact: true }) }).first();
  await expect(newRow.getByText("Live", { exact: true })).toBeVisible();
  sends.get(topic)?.({ type: "deployment", deployment: world.next });
  await page.waitForTimeout(300);

  // Back right away (well within the 30 s a list counts as fresh). Before: the tick had marked the
  // Overview's list fresh, so it was not fetched again and the card showed gen 17.
  const before = world.listCalls;
  await sectionTabs(page).getByRole("link", { name: "Overview" }).click();
  await expect(card.getByText(message, { exact: true })).toBeVisible();
  await expect(card.getByText("Live", { exact: true })).toBeVisible();
  expect(world.listCalls).toBeGreaterThan(before);
});

test("a tab hidden while the deploy ended shows the end as soon as it is shown again, and the row's clock stops", async ({ page }) => {
  const { overrides, set } = deployWorld();
  set("building");
  await installDemo(page, { overrides });
  await page.goto(`${overview}/deployments`);
  const history = page.getByRole("region", { name: "History" });
  const row = history.locator("div.border-t", { has: page.getByText(message, { exact: true }) }).first();
  await expect(row.getByText("Building", { exact: true })).toBeVisible();
  await expect(row.getByText(/^\d+:\d\d$/)).toBeVisible();

  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => value });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => value === "hidden" });
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    }, state);
  await setVisibility("hidden");
  // It goes live while nobody looks, and no event comes (as with a socket that went silent meanwhile).
  set("live");
  await page.waitForTimeout(1000);
  await setVisibility("visible");
  // Before: the row stayed "Building" with its clock running until the next 15 s poll.
  await expect(row.getByText("Live", { exact: true })).toBeVisible({ timeout: 4000 });
  await expect(row.getByText(/^\d+:\d\d$/)).toHaveCount(0);
  await expect(row.locator(".animate-spin")).toHaveCount(0);
});
