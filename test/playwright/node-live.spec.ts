// The dashboard's Nodes card in Live, the default: the Live chip is
// pressed and no range is picked, the three graphs show the last 5
// minutes from the demo's node-live samples and slide (one compositor
// animation each, none with reduced motion), the values under them
// follow the newest sample, a range turns Live off and the choice comes
// back after a reload. Without samples (a down socket, older agents) the
// card shows the last hour with a note. A hidden tab stops following.

import type { Page, WebSocketRoute } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile, reducedMotion: "no-preference" });

const shots = process.env.SHOTS_DIR ?? "shots";
const card = (page: Page) => page.getByRole("region", { name: "Node usage" });
const liveChip = (page: Page) => card(page).getByRole("button", { name: "Live", exact: true });
const lines = (page: Page) => card(page).locator('[data-slot="smooth-chart-layer"] path[fill="none"]');

/** A live socket the test drives: it accepts every topic and records which node-live topics are followed. */
async function drivenSocket(page: Page) {
  const followed = new Set<string>();
  let socket: WebSocketRoute | null = null;
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; topic: string };
      if (message.type === "unsubscribe") followed.delete(message.topic);
      if (message.type !== "subscribe") return;
      if (message.topic.startsWith("node-live:")) followed.add(message.topic);
      ws.send(JSON.stringify({ type: "subscribed", topic: message.topic }));
    });
  });
  return {
    followed,
    async sample(nodeId: string, sample: Record<string, number>) {
      await expect.poll(() => followed.has(`node-live:${nodeId}`)).toBe(true);
      const event = { type: "nodeLive", nodeId, sample: { t: Date.now(), ...sample } };
      socket?.send(JSON.stringify({ type: "event", topic: `node-live:${nodeId}`, event }));
    },
  };
}

test("Live is on by default: the chip is pressed, no range is picked and the graphs slide", async ({ page }) => {
  await installDemo(page);
  await page.goto("/");
  await expect(liveChip(page)).toHaveAttribute("aria-pressed", "true");
  for (const range of ["1h", "24h", "7d"]) await expect(card(page).getByRole("radio", { name: range })).toHaveAttribute("aria-checked", "false");
  await expect(card(page).getByRole("img", { name: "CPU per node, last 5 minutes" })).toBeVisible();
  await expect(card(page).getByRole("img", { name: "Network traffic per node, last 5 minutes" })).toBeVisible();
  // One line per node in each graph, each sliding layer with one running animation.
  await expect(lines(page)).toHaveCount(9);
  const layers = card(page).locator('[data-slot="smooth-chart-layer"]');
  await expect.poll(() => layers.evaluateAll((els) => els.map((el) => el.getAnimations().length))).toEqual([1, 1, 1]);
  // New samples move the lines.
  const before = await lines(page).first().getAttribute("d");
  await expect.poll(() => lines(page).first().getAttribute("d"), { timeout: 6000 }).not.toBe(before);
  await expect(liveChip(page).locator(".animate-pulse")).toHaveCount(1);
  await page.waitForTimeout(1500);
  await card(page).screenshot({ path: `${shots}/node-live.png` });
  // Hovering a graph names the sample's time with seconds and every node's value.
  const cpu = card(page).getByRole("img", { name: "CPU per node, last 5 minutes" });
  const box = await cpu.boundingBox();
  if (!box) throw new Error("no CPU graph");
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
  const tooltip = card(page).getByRole("tooltip");
  await expect(tooltip).toContainText(/\d{1,2}:\d{2}:\d{2}/);
  await expect(tooltip).toContainText("de-fsn-1");
  await card(page).screenshot({ path: `${shots}/node-live-hover.png` });
});

test("the values under the graphs follow the newest sample", async ({ page }) => {
  await installDemo(page);
  const live = await drivenSocket(page);
  await page.goto("/");
  const gb = 1024 ** 3;
  await live.sample(ids.de, {
    cpuPercent: 77,
    memoryUsedBytes: 3.5 * gb,
    memoryTotalBytes: 16 * gb,
    networkRxBytesPerSec: 1000 * 1024,
    networkTxBytesPerSec: 536 * 1024,
  });
  const cpu = card(page);
  await expect(cpu.getByText("de-fsn-1 77%")).toBeVisible();
  await expect(card(page).getByText("de-fsn-1 3.5 / 16 GB")).toBeVisible();
  await expect(card(page).getByText("de-fsn-1 1.5 MB/s")).toBeVisible();
  await live.sample(ids.de, { cpuPercent: 12, memoryUsedBytes: 4 * gb, memoryTotalBytes: 16 * gb, networkRxBytesPerSec: 0, networkTxBytesPerSec: 512 });
  await expect(cpu.getByText("de-fsn-1 12%")).toBeVisible();
  await expect(card(page).getByText("de-fsn-1 4 / 16 GB")).toBeVisible();
  // A tab that is hidden stops following, so the panel stops asking the agents; shown again, it follows again.
  expect(live.followed.size).toBe(3);
  const setHidden = (hidden: boolean) =>
    page.evaluate((value) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (value ? "hidden" : "visible") });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await setHidden(true);
  await expect.poll(() => live.followed.size).toBe(0);
  await setHidden(false);
  await expect.poll(() => live.followed.size).toBe(3);
});

test("a range turns Live off, the choice comes back after a reload, and the chip turns it on again", async ({ page }) => {
  await installDemo(page);
  await page.goto("/");
  await card(page).getByRole("radio", { name: "24h" }).click();
  await expect(liveChip(page)).toHaveAttribute("aria-pressed", "false");
  await expect(card(page).getByRole("radio", { name: "24h" })).toHaveAttribute("aria-checked", "true");
  await expect(card(page).getByRole("img", { name: "CPU per node, last 24h" })).toBeVisible();
  await page.waitForTimeout(1800);
  await card(page).screenshot({ path: `${shots}/node-live-off.png` });
  await page.reload();
  await expect(card(page).getByRole("radio", { name: "24h" })).toHaveAttribute("aria-checked", "true");
  await expect(liveChip(page)).toHaveAttribute("aria-pressed", "false");
  await liveChip(page).click();
  await expect(liveChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(card(page).getByRole("img", { name: "CPU per node, last 5 minutes" })).toBeVisible();
  // The chip again: back to the range picked before.
  await liveChip(page).click();
  await expect(card(page).getByRole("radio", { name: "24h" })).toHaveAttribute("aria-checked", "true");
  await liveChip(page).click();
  await page.reload();
  await expect(liveChip(page)).toHaveAttribute("aria-pressed", "true");
  await expect(card(page).getByRole("img", { name: "CPU per node, last 5 minutes" })).toBeVisible();
});

test("no live samples (older or offline agents): the last hour with a note, never an empty graph", async ({ page }) => {
  await installDemo(page, { nodeLive: "silent" });
  await page.goto("/");
  // The panel's 10-second points first, then the hour once nothing came.
  await expect(card(page).getByRole("img", { name: "CPU per node, last 5 minutes" })).toBeVisible();
  const note = card(page).getByRole("status").filter({ hasText: "No live samples from the nodes right now. Showing the last hour." });
  await expect(note).toBeVisible({ timeout: 12_000 });
  await expect(card(page).getByRole("img", { name: "CPU per node, last 1h" })).toBeVisible();
  await expect(liveChip(page)).toHaveAttribute("aria-pressed", "true");
  // Every node's line in the three graphs: drawn, not empty.
  const drawn = card(page).locator("path[stroke-linecap='round']");
  await expect(drawn).toHaveCount(9);
  expect((await drawn.evaluateAll((els) => els.map((el) => el.getAttribute("d") ?? ""))).every((d) => d.length > 20)).toBe(true);
  // The hour's lines draw in once (1.6 s), like every range.
  await page.waitForTimeout(1800);
  await card(page).screenshot({ path: `${shots}/node-live-fallback.png` });
});

test("the live socket down: the last hour with a note that says so", async ({ page }) => {
  await installDemo(page);
  await page.routeWebSocket(/\/api\/live/, (ws) => ws.close({ code: 1011, reason: "down" }));
  await page.goto("/");
  const note = card(page).getByText("Live updates paused: the connection to the panel dropped. Showing the last hour.");
  await expect(note).toBeVisible({ timeout: 12_000 });
  await expect(card(page).getByRole("img", { name: "CPU per node, last 1h" })).toBeVisible();
});

test("with reduced motion the graphs do not slide but still follow the samples", async ({ browser }) => {
  const context = await browser.newContext({ storageState: stateFile, reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await installDemo(page, { nodeLiveIntervalMs: 700 });
  await page.goto("/");
  await expect(lines(page)).toHaveCount(9);
  const layers = card(page).locator('[data-slot="smooth-chart-layer"]');
  const before = await lines(page).first().getAttribute("d");
  await expect.poll(() => lines(page).first().getAttribute("d"), { timeout: 6000 }).not.toBe(before);
  expect(await layers.evaluateAll((els) => els.map((el) => el.getAnimations().length))).toEqual([0, 0, 0]);
  await context.close();
});
