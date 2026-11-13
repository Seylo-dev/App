// Dragging projects and services into the person's own order (0.2.5 owner
// request): the sidebar, the dashboard and the project page show one order,
// saved with projects.reorder and services.reorder. A drag starts after a
// few pixels, so a click still opens what it lands on; the keyboard moves
// items too (Space, arrows, Space).

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids, projects, services } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { installDemo } from "./demo/routes";
import { dashboardHeading, expect, stateFile, test, withDashboardView } from "./helpers";

test.use({ storageState: stateFile });

type Calls = { op: string; input: Record<string, unknown> }[];
type Listed = { id: string; parentId?: string | null };

/** `list` in the saved order `ids` (the rest after, as they were), each service's compose members after it, as the panel lists them. */
function inOrder<T extends Listed>(list: readonly T[], ids: readonly string[]): T[] {
  const rank = (item: T, at: number) => (ids.includes(item.id) ? ids.indexOf(item.id) : ids.length + at);
  const top = list
    .map((item, at) => ({ item, at }))
    .filter(({ item }) => !item.parentId)
    .sort((a, b) => rank(a.item, a.at) - rank(b.item, b.at))
    .map(({ item }) => item);
  return top.flatMap((item) => [item, ...list.filter((member) => member.parentId === item.id)]);
}

/**
 * The demo, with the reorder ops recorded and saved: projects.list and
 * services.list answer in the saved order, as the panel does (the page reads
 * them again once a save answered). `saveMs` holds the saves' answers back (so
 * one lands while a drop's frames are watched); `refuse` makes them fail.
 * `setup` runs after the demo's routes, before the page opens, so its routes win.
 */
async function open(
  page: Page,
  path = "/",
  { saveMs = 0, refuse = false, setup }: { saveMs?: number; refuse?: boolean; setup?: () => Promise<void> } = {},
): Promise<Calls> {
  const calls: Calls = [];
  let projectOrder: string[] = [];
  const serviceOrder = new Map<string, string[]>();
  const refusal = () => new DemoRefusal(500, "INTERNAL", "The database is locked.");
  await installDemo(page, {
    nodeLive: "silent",
    delay: (op) => (op.endsWith(".reorder") ? saveMs : 0),
    overrides: {
      "projects.list": () => ({ projects: inOrder(projects, projectOrder) }),
      "services.list": (input) => {
        const projectId = String(input.projectId ?? "");
        return { services: inOrder((services[projectId] ?? []) as Listed[], serviceOrder.get(projectId) ?? []) };
      },
      "projects.reorder": (input) => {
        calls.push({ op: "projects.reorder", input });
        if (refuse) throw refusal();
        projectOrder = input.projectIds;
        return { projectIds: input.projectIds };
      },
      "services.reorder": (input) => {
        calls.push({ op: "services.reorder", input });
        if (refuse) throw refusal();
        serviceOrder.set(input.projectId, input.serviceIds);
        return { projectId: input.projectId, serviceIds: input.serviceIds };
      },
    },
  });
  await setup?.();
  await page.goto(path);
  return calls;
}

const shots = `${process.env.SHOTS_DIR ?? "shots"}/project-order`;

/** Lifts `from` and holds it over `to` with the mouse, in small steps like a person would; the button stays down. */
async function dragOver(page: Page, from: Locator, to: Locator) {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error("nothing to drag");
  await page.mouse.move(a.x + 20, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + a.height / 2 + 8, { steps: 4 });
  await page.mouse.move(b.x + 20, b.y + b.height / 2, { steps: 12 });
  await page.waitForTimeout(250);
}

/** Drags `from` onto `to` and drops it; `shot` names a screenshot taken mid-drag. */
async function drag(page: Page, from: Locator, to: Locator, shot?: string) {
  await dragOver(page, from, to);
  if (shot) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/${shot}.png` });
  }
  await page.mouse.up();
}

const sidebar = (page: Page) => page.getByRole("navigation", { name: "Main" });
const sidebarProjects = (page: Page) => sidebar(page).getByRole("list", { name: "Projects" }).locator(":scope > li");

test("a project dragged in the sidebar moves there and on the dashboard, and is saved", async ({ page }) => {
  const calls = await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(sidebarProjects(page).first()).toContainText("acme-shop");
  await drag(page, sidebarProjects(page).nth(1).locator("> div").first(), sidebarProjects(page).first().locator("> div").first(), "sidebar-mid-drag");
  await expect.poll(() => calls.filter((c) => c.op === "projects.reorder").map((c) => c.input.projectIds)).toEqual([
    [ids.personal, ids.acme, ids.panel],
  ]);
  await expect(sidebarProjects(page).first()).toContainText("personal");
  // The dashboard shows the same order.
  await expect(page.getByRole("region", { name: "Projects" }).locator("article").first()).toContainText("personal");
  // The drop did not open the project it ended on.
  await expect(dashboardHeading(page)).toBeVisible();
});

test("a service card dragged on the dashboard moves in its project, in the sidebar too, and a click still opens a card", async ({
  page,
}) => {
  const calls = await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const acme = page.getByRole("region", { name: "Projects" }).locator("article").first();
  const cards = acme.locator("[data-sortable-card]");
  await expect(cards.first()).toContainText("web");
  await drag(page, cards.nth(1), cards.first(), "cards-mid-drag");
  await expect
    .poll(() => (calls.find((c) => c.op === "services.reorder")?.input.serviceIds as string[] | undefined)?.slice(0, 2))
    .toEqual([ids.api, ids.web]);
  await expect(cards.first()).toContainText("api");
  // The sidebar's service rows under acme-shop follow.
  const rows = sidebarProjects(page).first().locator("ul > li");
  await expect(rows.first()).toContainText("api");
  await expect(dashboardHeading(page)).toBeVisible();

  // A plain click on the card opens the service (its middle can be the repository's own link). Within
  // 250 ms of a drop a click counts as the drop's own and is swallowed, so wait a moment first.
  await page.waitForTimeout(400);
  await cards.nth(1).getByText("web", { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}/s/${ids.web}$`));
});

test("the keyboard moves a service: Space, an arrow, Space", async ({ page }) => {
  const calls = await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const rows = sidebarProjects(page).first().locator("ul > li");
  await expect(rows.nth(1)).toContainText("api");
  // Each row has a keyboard handle, hidden until it is focused.
  const grip = rows.nth(1).getByRole("button", { name: /^Move api\./ });
  await grip.focus();
  await expect(grip).toBeVisible();
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(150);
  await page.keyboard.press("Space");
  await expect
    .poll(() => (calls.find((c) => c.op === "services.reorder")?.input.serviceIds as string[] | undefined)?.slice(0, 2))
    .toEqual([ids.api, ids.web]);
  await expect(rows.first()).toContainText("api");
});

test("the project page's cards drag in the same order", async ({ page }) => {
  const calls = await open(page, `/p/${ids.acme}`);
  const cards = page.getByRole("main").locator("[data-sortable-card]");
  await expect(cards.first()).toContainText("web");
  await drag(page, cards.nth(2), cards.first());
  await expect.poll(() => calls.filter((c) => c.op === "services.reorder").length).toBe(1);
  await expect(cards.first()).not.toContainText("web");
  await expect(page).toHaveURL(new RegExp(`/p/${ids.acme}$`));
});

test("the List view drags service rows in the same order", async ({ page }) => {
  await withDashboardView(page, "list");
  const calls = await open(page);
  await expect(dashboardHeading(page)).toBeVisible();
  const acme = page.getByRole("region", { name: "Projects" }).locator("article").first();
  const rows = acme.locator("a[href*='/s/']");
  await expect(rows.first()).toContainText("web");
  await drag(page, rows.nth(1), rows.first());
  await expect
    .poll(() => (calls.find((c) => c.op === "services.reorder")?.input.serviceIds as string[] | undefined)?.slice(0, 2))
    .toEqual([ids.api, ids.web]);
  await expect(rows.first()).toContainText("api");
  await expect(dashboardHeading(page)).toBeVisible();
});

// The drop itself (owner report 2026-11-13: "after dragging an app in the
// sidebar, it's kinda jumping on drag end, for a sec"). The new order used
// to reach the list a moment after the drop (the query cache tells its
// screens on a timer), so dnd-kit first drew the old order and sent every
// moved item back with its 200 ms transform transition; the reorder then put
// the item in its new place while that transition still ran, so it showed a
// whole drag away from there (30 px for a service row, 205 px for an open
// project) and slid back. These watch the dropped item on every animation
// frame until 600 ms after the drop, with the save answering 200 ms in: it
// is never drawn farther from its new place than where it was let go, and
// ends there.

type Frame = { t: number; x: number; y: number };

/** Records where `item` is drawn on every frame, from now until 600 ms after the next pointerup or Space key (the drop). */
async function watchDrop(item: Locator): Promise<() => Promise<Frame[]>> {
  await item.evaluate((node) => {
    const frames: Frame[] = [];
    (window as unknown as { dropFrames: Frame[] }).dropFrames = frames;
    let dropAt = Number.POSITIVE_INFINITY;
    const onDrop = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== " ") return;
      dropAt = performance.now();
      window.removeEventListener("pointerup", onDrop, true);
      window.removeEventListener("keydown", onDrop, true);
    };
    window.addEventListener("pointerup", onDrop, true);
    window.addEventListener("keydown", onDrop, true);
    const sample = () => {
      const now = performance.now();
      const box = node.getBoundingClientRect();
      frames.push({ t: now - dropAt, x: box.left, y: box.top });
      if (now - dropAt < 600) requestAnimationFrame(sample);
    };
    // One sample now, so there is one from before the drop however soon it comes.
    sample();
  });
  return async () => {
    await item.page().waitForFunction(() => ((window as unknown as { dropFrames: Frame[] }).dropFrames.at(-1)?.t ?? 0) >= 600);
    return item.page().evaluate(() => (window as unknown as { dropFrames: Frame[] }).dropFrames);
  };
}

/** The item went from where it was let go straight to `place` (its new place) and stayed there. */
function expectStraightDrop(frames: Frame[], place: { x: number; y: number }) {
  const dropped = frames.filter((frame) => frame.t < 0).at(-1);
  const after = frames.filter((frame) => frame.t >= 0);
  if (!dropped || after.length < 10) throw new Error(`too few frames around the drop: ${frames.length}`);
  const away = (frame: Frame) => Math.hypot(frame.x - place.x, frame.y - place.y);
  const farthest = Math.max(...after.map(away));
  const trace = after
    .slice(0, 8)
    .map((frame) => `${Math.round(frame.t)} ms: ${away(frame).toFixed(1)} px`)
    .join(", ");
  expect(
    farthest,
    `let go ${away(dropped).toFixed(1)} px from its new place, then drawn up to ${farthest.toFixed(1)} px from it (${trace})`,
  ).toBeLessThanOrEqual(away(dropped) + 1);
  expect(away(after.at(-1) as Frame), "where it ends").toBeLessThanOrEqual(1);
}

async function topLeft(item: Locator): Promise<{ x: number; y: number }> {
  const box = await item.boundingBox();
  if (!box) throw new Error("not on screen");
  return { x: box.x, y: box.y };
}

test("a service dropped in the sidebar goes straight to its new place", async ({ page }) => {
  const calls = await open(page, "/", { saveMs: 200 });
  await expect(dashboardHeading(page)).toBeVisible();
  const rows = sidebarProjects(page).first().locator("ul > li");
  await expect(rows.nth(1)).toContainText("api");
  const api = rows.nth(1);
  const place = await topLeft(rows.first());
  const frames = await watchDrop(api);
  await dragOver(page, api, rows.first());
  await page.mouse.up();
  expectStraightDrop(await frames(), place);
  await expect(rows.first()).toContainText("api");
  expect(calls.filter((c) => c.op === "services.reorder")).toHaveLength(1);
});

test("a project dropped in the sidebar goes straight to its new place", async ({ page }) => {
  const calls = await open(page, "/", { saveMs: 200 });
  await expect(dashboardHeading(page)).toBeVisible();
  const list = sidebarProjects(page);
  await expect(list.nth(1)).toContainText("personal");
  const personal = list.nth(1);
  const place = await topLeft(list.first());
  const frames = await watchDrop(personal);
  await dragOver(page, personal.locator("> div").first(), list.first().locator("> div").first());
  await page.mouse.up();
  expectStraightDrop(await frames(), place);
  await expect(list.first()).toContainText("personal");
  expect(calls.filter((c) => c.op === "projects.reorder")).toHaveLength(1);
});

test("a service moved with the keyboard goes straight to its new place", async ({ page }) => {
  const calls = await open(page, "/", { saveMs: 200 });
  await expect(dashboardHeading(page)).toBeVisible();
  const rows = sidebarProjects(page).first().locator("ul > li");
  await expect(rows.nth(1)).toContainText("api");
  const api = rows.nth(1);
  const place = await topLeft(rows.first());
  await api.getByRole("button", { name: /^Move api\./ }).focus();
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(300);
  const frames = await watchDrop(api);
  await page.keyboard.press("Space");
  expectStraightDrop(await frames(), place);
  await expect(rows.first()).toContainText("api");
  expect(calls.filter((c) => c.op === "services.reorder")).toHaveLength(1);
});

test("a service card dropped on the dashboard goes straight to its new place", async ({ page }) => {
  await open(page, "/", { saveMs: 200 });
  await expect(dashboardHeading(page)).toBeVisible();
  const cards = page.getByRole("region", { name: "Projects" }).locator("article").first().locator("[data-sortable-card]");
  await expect(cards.nth(1)).toContainText("api");
  const api = cards.nth(1);
  const place = await topLeft(cards.first());
  const frames = await watchDrop(api);
  await dragOver(page, api, cards.first());
  await page.mouse.up();
  expectStraightDrop(await frames(), place);
  await expect(cards.first()).toContainText("api");
});

test("a project dropped on the dashboard goes straight to its new place", async ({ page }) => {
  await open(page, "/", { saveMs: 200 });
  await expect(dashboardHeading(page)).toBeVisible();
  const sections = page.getByRole("region", { name: "Projects" }).locator("article");
  await expect(sections.nth(1)).toContainText("personal");
  const personal = sections.nth(1);
  const place = await topLeft(sections.first());
  const frames = await watchDrop(personal);
  await dragOver(page, personal.locator("> div").first(), sections.first().locator("> div").first());
  await page.mouse.up();
  expectStraightDrop(await frames(), place);
  await expect(sections.first()).toContainText("personal");
});

// A drop while the list is being read again (reviewer, 2026-11-13): while a
// service of the project deploys or restarts, the panel says "services.list
// is stale" on project:<id> and the page reads the list again, up to once a
// second. That read was asked before the save, so its answer has the old
// order; it used to land over the dropped order and put the item back where
// it came from, until the next read. The drop now stops that read, and the
// list is read again once the save answered.

/** The live socket in place of the demo's: `stale` says ops on a topic changed, as the panel does when a container changes. */
async function liveSocket(page: Page) {
  let socket: { send(text: string): void } | null = null;
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    socket = ws;
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; topic: string };
      if (message.type === "subscribe") ws.send(JSON.stringify({ type: "subscribed", topic: message.topic }));
    });
  });
  return {
    async stale(topic: string, ops: string[]) {
      await expect.poll(() => socket !== null).toBe(true);
      socket?.send(JSON.stringify({ type: "event", topic, event: { type: "invalidate", ops } }));
    },
  };
}

/**
 * Holds the next read of `op` (once `arm`ed) until `release`, then answers it
 * with `before`: what the panel had when it was asked, before the drop's save.
 * Reads of the same project after it go on to the demo; `later` counts them.
 */
async function holdNextRead(page: Page, op: "projects.list" | "services.list", before: unknown) {
  let armed = false;
  let asked = false;
  let later = 0;
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(new RegExp(`/api/v1/${op.replace(".", "\\.")}`), async (route) => {
    const request = route.request();
    const ours = op === "projects.list" || `${request.url()} ${request.postData() ?? ""}`.includes(ids.acme);
    if (!armed || !ours) {
      if (asked && ours) later++;
      return route.fallback();
    }
    armed = false;
    asked = true;
    await released;
    // The page may have stopped this read: then nothing is waiting for the answer.
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(before) }).catch(() => {});
  });
  return {
    arm: () => {
      armed = true;
    },
    asked: () => asked,
    later: () => later,
    release: () => release(),
  };
}

test("a service dropped while its list is being read again stays in its new place, and the list is read after the save", async ({
  page,
}) => {
  let live: Awaited<ReturnType<typeof liveSocket>> | undefined;
  let read: Awaited<ReturnType<typeof holdNextRead>> | undefined;
  const calls = await open(page, "/", {
    saveMs: 400,
    setup: async () => {
      live = await liveSocket(page);
      read = await holdNextRead(page, "services.list", { services: services[ids.acme] });
    },
  });
  if (!live || !read) throw new Error("setup did not run");
  const held = read;
  await expect(dashboardHeading(page)).toBeVisible();
  const rows = sidebarProjects(page).first().locator("ul > li");
  await expect(rows.nth(1)).toContainText("api");
  const api = rows.nth(1);
  const place = await topLeft(rows.first());
  const frames = await watchDrop(api);
  await dragOver(page, api, rows.first());
  held.arm();
  await live.stale(`project:${ids.acme}`, ["services.list"]);
  await expect.poll(() => held.asked()).toBe(true);
  await page.mouse.up();
  // The read from before the save answers right after the drop, the save 400 ms in.
  held.release();
  expectStraightDrop(await frames(), place);
  await expect(rows.first()).toContainText("api");
  expect(calls.filter((c) => c.op === "services.reorder")).toHaveLength(1);
  await expect.poll(() => held.later()).toBeGreaterThan(0);
  await expect(rows.first()).toContainText("api");
});

test("a project dropped while projects.list is being read again stays in its new place, and the list is read after the save", async ({
  page,
}) => {
  let live: Awaited<ReturnType<typeof liveSocket>> | undefined;
  let read: Awaited<ReturnType<typeof holdNextRead>> | undefined;
  const calls = await open(page, "/", {
    saveMs: 400,
    setup: async () => {
      live = await liveSocket(page);
      read = await holdNextRead(page, "projects.list", { projects });
    },
  });
  if (!live || !read) throw new Error("setup did not run");
  const held = read;
  await expect(dashboardHeading(page)).toBeVisible();
  const list = sidebarProjects(page);
  await expect(list.nth(1)).toContainText("personal");
  const personal = list.nth(1);
  const place = await topLeft(list.first());
  const frames = await watchDrop(personal);
  await dragOver(page, personal.locator("> div").first(), list.first().locator("> div").first());
  held.arm();
  await live.stale(`project:${ids.acme}`, ["projects.list"]);
  await expect.poll(() => held.asked()).toBe(true);
  await page.mouse.up();
  held.release();
  expectStraightDrop(await frames(), place);
  await expect(list.first()).toContainText("personal");
  expect(calls.filter((c) => c.op === "projects.reorder")).toHaveLength(1);
  await expect.poll(() => held.later()).toBeGreaterThan(0);
  await expect(list.first()).toContainText("personal");
});

test("a save that fails puts the order back, with an error toast", async ({ page }) => {
  const calls = await open(page, "/", { refuse: true });
  await expect(dashboardHeading(page)).toBeVisible();
  const rows = sidebarProjects(page).first().locator("ul > li");
  await expect(rows.nth(1)).toContainText("api");
  await drag(page, rows.nth(1), rows.first());
  await expect.poll(() => calls.filter((c) => c.op === "services.reorder").length).toBe(1);
  await expect(page.getByText("Could not save the sidebar order").first()).toBeVisible();
  await expect(rows.first()).toContainText("web");
  await expect(rows.nth(1)).toContainText("api");

  const list = sidebarProjects(page);
  await drag(page, list.nth(1).locator("> div").first(), list.first().locator("> div").first());
  await expect.poll(() => calls.filter((c) => c.op === "projects.reorder").length).toBe(1);
  await expect(list.first()).toContainText("acme-shop");
  await expect(list.nth(1)).toContainText("personal");
});
