// The assistant in the browser, on the demo world (demo/assistant.ts streams
// replies over the live socket the way the panel does): the chat bubble
// with suggestions and a streamed reply with its action cards, an approval
// card approved from the chat and seen resolved on the Approvals page with
// its source chips, the auto switch, the chats menu (switch, rename, new,
// delete), the Assistant page with the same chats while the bubble hides
// there, room under the page for the bubble, who sees it, and a phone.
// Screenshots of the bubble, an approval card, the Assistant page and the
// Approvals page in a light and a dark preset go to $SHOTS_DIR/assistant/.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { assistantCalls, assistantHandlers } from "./demo/assistant";
import { ids } from "./demo/fixtures";
import { installDemo, type Preset } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

const shots = `${process.env.SHOTS_DIR ?? "shots"}/assistant`;
mkdirSync(shots, { recursive: true });
const servicePage = `/p/${ids.acme}/s/${ids.api}`;

async function open(
  page: Page,
  path: string,
  options: { preset?: Preset; mode?: "light" | "dark"; overrides?: Record<string, (input: any) => unknown> } = {},
) {
  await installDemo(page, { preset: options.preset, mode: options.mode, overrides: { ...assistantHandlers, ...options.overrides } });
  await page.goto(path);
  await expect(page.locator("main").first()).toBeVisible();
}

const panelOf = (page: Page) => page.locator("[data-assistant-panel]");
const bubbleButton = (page: Page) => page.getByRole("button", { name: "Open the assistant" });

async function openBubble(page: Page): Promise<Locator> {
  await bubbleButton(page).click();
  const panel = panelOf(page);
  await expect(panel.getByRole("textbox", { name: "Message the assistant" })).toBeVisible();
  return panel;
}

async function ask(panel: Locator, text: string) {
  const box = panel.getByRole("textbox", { name: "Message the assistant" });
  await box.fill(text);
  await box.press("Enter");
}

/** A screenshot once motion settled: of the whole window, or of one part of it. */
async function shoot(page: Page, name: string, part?: Locator) {
  await page.waitForTimeout(400);
  await (part ?? page).screenshot({ path: `${shots}/${name}.png` });
}

test.describe("assistant", () => {
  test("the bubble opens a chat with suggestions from the page, and a reply streams with its action card", async ({ page }) => {
    await open(page, servicePage);
    await expect(bubbleButton(page)).toBeVisible();
    const panel = await openBubble(page);
    await expect(panel.getByRole("heading", { name: "How can I help?" })).toBeVisible();
    // On a service page the chips are about that service.
    const chip = panel.getByRole("button", { name: "Why did the last deploy fail?" });
    await expect(chip).toBeVisible();
    await expect(panel.getByRole("button", { name: "Show the last 50 log lines" })).toBeVisible();
    await chip.click();

    // The message shows at once; the composer waits (Stop) while the reply streams.
    await expect(panel.getByRole("log", { name: "Messages" }).getByText("Why did the last deploy fail?", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Read the deploys of api" })).toBeVisible();
    const reply = panel.getByText(/The last deploy of api failed at the build step/);
    await expect(reply).toBeVisible();
    // Streaming: the text grows before it is complete.
    await expect(panel.getByText(/commit the new lock file and push again/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Send" })).toBeVisible();
    // The new chat started on this page, with it as the context, and took its title from the message.
    expect(assistantCalls.find((c) => c.op === "ai.send")?.input).toMatchObject({
      message: "Why did the last deploy fail?",
      context: { projectId: ids.acme, serviceId: ids.api },
    });
    await expect(panel.getByRole("button", { name: "Your chats" })).toContainText("Why did the last deploy fail?");

    // The card opens to the input and the result.
    await panel.getByRole("button", { name: "Details" }).click();
    await expect(panel.getByText('"limit": 5')).toBeVisible();

    // Open and the chat survive navigation.
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Nodes \d+$/ }).click();
    await expect(page).toHaveURL(/\/nodes$/);
    await expect(panelOf(page).getByText(/commit the new lock file/)).toBeVisible();
  });

  for (const mode of ["light", "dark"] as const) {
    const preset = mode === "light" ? "seylo" : "seylo-dark";
    test(`an approval card in the chat, approved there, is resolved on the Approvals page with its source (${preset})`, async ({ page }) => {
      await open(page, "/", { preset: "seylo", mode });
      const panel = await openBubble(page);
      await ask(panel, "The api is slow, restart it please");
      const card = panel.getByRole("region", { name: "Restart api?" });
      await expect(card).toBeVisible();
      await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
      await expect(card.getByRole("button", { name: "Reject" })).toBeVisible();
      await expect(card).toContainText("for Owner");
      await expect(panel.getByRole("button", { name: "Send" })).toBeVisible();
      await shoot(page, `bubble-approval-${preset}`, panel);
      await panel.getByRole("button", { name: "Close the assistant" }).first().click();

      // The same request waits on the Approvals page, with where it came from.
      await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Approvals/ }).click();
      const waiting = page.getByRole("region", { name: "Restart a service" });
      await expect(waiting).toBeVisible();
      await expect(waiting.getByText("Assistant", { exact: true })).toBeVisible();
      await expect(waiting.getByRole("link", { name: "The api is slow, restart it please" })).toBeVisible();
      const mcp = page.getByRole("region", { name: "Delete a project" });
      await expect(mcp.getByText("MCP", { exact: true })).toBeVisible();
      await expect(mcp.getByText("Claude Code on laptop", { exact: true })).toBeVisible();
      await shoot(page, `approvals-sources-${preset}`);

      // Approve from the chat: the card turns to done, the reply goes on, the Approvals page says so.
      const chat = await openBubble(page);
      const inChat = chat.getByRole("region", { name: "Restart api?" });
      await inChat.getByRole("button", { name: "Approve" }).click();
      await expect(inChat).toContainText("Done by Owner");
      await expect(inChat.getByRole("button", { name: "Approve" })).toHaveCount(0);
      await expect(chat.getByText(/Restarted api\. It answers again/)).toBeVisible();
      expect(assistantCalls.filter((c) => c.op === "approvals.approve")).toHaveLength(1);
      await chat.getByRole("button", { name: "Close the assistant" }).first().click();
      await page.getByRole("radio", { name: "All" }).click();
      const resolved = page.getByRole("region", { name: "Restart a service" });
      await expect(resolved.getByText("Done", { exact: true })).toBeVisible();
      await expect(resolved.getByRole("button", { name: "Approve and run" })).toHaveCount(0);

      // The session chip opens that chat on the Assistant page.
      await resolved.getByRole("link", { name: "The api is slow, restart it please" }).click();
      await expect(page).toHaveURL(/\/assistant\?c=/);
      await expect(page.getByRole("heading", { level: 1 })).toContainText("The api is slow, restart it please");
    });
  }

  test("auto mode: one switch in the header, said in the composer, and a change runs without an approval card", async ({ page }) => {
    await open(page, "/");
    const panel = await openBubble(page);
    const auto = panel.getByRole("switch", { name: "Auto mode" });
    await expect(auto).not.toBeChecked();
    await auto.click();
    await expect(auto).toBeChecked();
    await expect(panel.getByText("Auto is on: changes run without asking.")).toBeVisible();
    expect(assistantCalls.filter((c) => c.op === "ai.setAutoMode").map((c) => c.input)).toEqual([{ enabled: true }]);

    await ask(panel, "restart api");
    const ran = panel.getByRole("region", { name: "Restarted api" });
    await expect(ran).toBeVisible();
    await expect(ran.getByText("Auto", { exact: true })).toBeVisible();
    await expect(panel.getByRole("region", { name: "Restart api?" })).toHaveCount(0);

    // The choice is the person's, not the chat's: a new chat keeps it.
    await panel.getByRole("button", { name: "Your chats" }).click();
    await page.getByRole("menuitem", { name: "New chat" }).click();
    await expect(panel.getByRole("switch", { name: "Auto mode" })).toBeChecked();
    await panel.getByRole("button", { name: "Turn off" }).click();
    await expect(panel.getByRole("switch", { name: "Auto mode" })).not.toBeChecked();
    await expect(panel.getByText("Auto is on: changes run without asking.")).toHaveCount(0);
  });

  test("the chats menu: switch, rename, start a new one and delete", async ({ page }) => {
    await open(page, "/");
    const panel = await openBubble(page);
    await panel.getByRole("button", { name: "Your chats" }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem", { name: /^Why is the worker restarting\?/ })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /^Clean up old preview deploys/ })).toBeVisible();
    await menu.getByRole("menuitem", { name: /^Why is the worker restarting\?/ }).click();
    await expect(panel.getByRole("region", { name: "Read the logs of worker" })).toBeVisible();
    await expect(panel.getByText(/Raising the limit to 768 MiB/)).toBeVisible();

    await panel.getByRole("button", { name: "Your chats" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const title = panel.getByRole("textbox", { name: "Chat title" });
    await title.fill("Worker memory");
    await title.press("Enter");
    await expect(panel.getByRole("button", { name: "Your chats" })).toContainText("Worker memory");

    await panel.getByRole("button", { name: "Your chats" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(panel.getByRole("heading", { name: "How can I help?" })).toBeVisible();
    await panel.getByRole("button", { name: "Your chats" }).click();
    await expect(page.getByRole("menuitem", { name: /Worker memory/ })).toHaveCount(0);
  });

  for (const mode of ["light", "dark"] as const) {
    const preset = mode === "light" ? "seylo" : "seylo-dark";
    test(`the Assistant page: the same chats, search, a reply, and the bubble only elsewhere (${preset})`, async ({ page }) => {
      await open(page, "/", { preset: "seylo", mode });
      const sidebar = page.getByRole("navigation", { name: "Main" });
      await sidebar.getByRole("link", { name: "Assistant" }).click();
      await expect(page).toHaveURL(/\/assistant/);
      await expect(bubbleButton(page)).toHaveCount(0);
      const chats = page.getByRole("navigation", { name: "Your chats" });
      await expect(chats.getByRole("button", { name: /^Why is the worker restarting\?/ })).toBeVisible();
      await chats.getByRole("button", { name: /^Why is the worker restarting\?/ }).click();
      await expect(page).toHaveURL(/c=conv000000000001/);
      await expect(page.getByText(/Raising the limit to 768 MiB/)).toBeVisible();
      await shoot(page, `assistant-page-${preset}`);

      await page.getByRole("searchbox", { name: "Search chats" }).fill("preview");
      await expect(chats.getByRole("button", { name: /^Clean up old preview deploys/ })).toBeVisible();
      await expect(chats.getByRole("button", { name: /^Why is the worker restarting/ })).toHaveCount(0);
      await page.getByRole("searchbox", { name: "Search chats" }).fill("");

      await page.getByRole("button", { name: "New chat" }).click();
      await expect(page.getByRole("heading", { name: "How can I help?" })).toBeVisible();
      const box = page.getByRole("textbox", { name: "Message the assistant" });
      await box.fill("How are things?");
      await box.press("Enter");
      await expect(page.getByText(/Everything looks fine: 3 nodes online/)).toBeVisible();
      await expect(chats.getByRole("button", { name: /^How are things\?/ })).toBeVisible();

      // Leaving the page: the bubble is back, with the same chat.
      await sidebar.getByRole("link", { name: /^Nodes \d+$/ }).click();
      const panel = await openBubble(page);
      await expect(panel.getByRole("button", { name: "Your chats" })).toContainText("How are things?");
      await expect(panel.getByText(/Everything looks fine/)).toBeVisible();
      await shoot(page, `bubble-open-${preset}`);
    });
  }

  test("the page keeps room under its content for the bubble", async ({ page }) => {
    await open(page, "/settings/ai");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(300);
    const bubble = await bubbleButton(page).boundingBox();
    const last = await page.locator("main > div > *").last().boundingBox();
    expect(bubble && last).toBeTruthy();
    if (bubble && last) expect(last.y + last.height).toBeLessThanOrEqual(bubble.y);
  });

  test("who sees it: not without the assistant, no Assistant page while the setting is off", async ({ page }) => {
    const off = { available: false, reason: "notAllowed", chatPage: true, autoMode: false, budgetReached: false };
    await open(page, "/", { overrides: { "ai.me": () => off } });
    const sidebar = page.getByRole("navigation", { name: "Main" });
    await expect(sidebar.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(bubbleButton(page)).toHaveCount(0);
    await expect(sidebar.getByRole("link", { name: "Assistant" })).toHaveCount(0);

    const noPage = { ...off, available: true, reason: null, chatPage: false };
    await open(page, "/", { overrides: { "ai.me": () => noPage } });
    await expect(bubbleButton(page)).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Assistant" })).toHaveCount(0);
    await page.goto("/assistant");
    await expect(page.getByText("The Assistant page is off.", { exact: false })).toBeVisible();
  });

  test("a phone: the chat covers the screen, and the page's chat list is a sheet", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, "/");
    const panel = await openBubble(page);
    await page.waitForTimeout(400);
    const box = await panel.boundingBox();
    expect(box).toMatchObject({ x: 0, y: 0, width: 390, height: 844 });
    await ask(panel, "How are things?");
    await expect(panel.getByText(/Everything looks fine/)).toBeVisible();
    await shoot(page, "bubble-phone");
    await panel.getByRole("button", { name: "Close the assistant" }).click();
    await expect(panel).toHaveCount(0);

    await page.goto("/assistant");
    await page.getByRole("button", { name: "Your chats" }).click();
    const sheet = page.getByRole("dialog", { name: "Your chats" });
    await expect(sheet.getByRole("button", { name: /^Why is the worker restarting\?/ })).toBeVisible();
    await sheet.getByRole("button", { name: /^Why is the worker restarting\?/ }).click();
    await expect(page.getByText(/Raising the limit to 768 MiB/)).toBeVisible();
    // Nothing runs past the screen sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await shoot(page, "assistant-page-phone");
  });
});
