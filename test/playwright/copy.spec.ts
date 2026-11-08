// Commands on screen come with a copy control, and nothing lands on the
// clipboard that the viewer did not ask to copy: the setup-link command,
// the pgvector SQL and a cron job's command (job list, run dialog, cron
// overview) copy with one click; tabbing onto a copy field (a database URL
// with its password) does not copy it, Enter does. Demo data.

import { expect, type Page, test } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { databaseOf, ids as svc } from "./demo/service";
import { stateFile } from "./helpers";

test.use({ storageState: stateFile, permissions: ["clipboard-read", "clipboard-write"] });

const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
const setClipboard = (page: Page, text: string) => page.evaluate((value) => navigator.clipboard.writeText(value), text);

test.describe("copy", () => {
  test("focusing a copy field does not copy it; Enter and a click do", async ({ page }) => {
    await installDemo(page);
    await page.goto(`/p/${ids.acme}/s/${svc.clickhouse}/connection`);
    const internal = page.getByRole("region", { name: "Internal connection" });
    const url = internal.getByRole("button", { name: "Copy: Connection URL" });
    await expect(url).toBeVisible();
    await setClipboard(page, "what was there before");

    // Tab from the button before it, the way a keyboard user crosses the page.
    await internal.getByRole("button", { name: "Reset password" }).focus();
    await page.keyboard.press("Tab");
    await expect(url).toBeFocused();
    await page.keyboard.press("Tab");
    await page.waitForTimeout(300);
    // Before: each field copied itself on focus, password included, and said "Copied".
    expect(await clipboard(page)).toBe("what was there before");
    await expect(internal.getByText("Copied")).toHaveCount(0);

    await url.focus();
    await page.keyboard.press("Enter");
    await expect(internal.getByText("Copied")).toBeVisible();
    expect(await clipboard(page)).toBe("clickhouse://ch_k3v9q2m8x1:Wd4nB8sKq1Pz7Hv2@events:9000/events");
  });

  test("the expired setup link screen gives the command with a copy button", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "setup.status": () => ({
          ownerExists: false,
          completed: false,
          link: { valid: false, expiresAt: null },
          githubAvailable: false,
          steps: ["owner", "panelDomain", "wildcardDomain", "firstProject"],
        }),
      },
    });
    await page.goto("/setup?t=used-token");
    const panel = page.getByRole("region", { name: "This setup link does not work" });
    const block = panel.locator('[data-slot="code-block"]');
    await expect(block).toContainText(/^.*\S+ panel setup-link$/);
    const command = (await block.locator("code").textContent()) ?? "";
    await block.getByRole("button", { name: "Copy" }).click();
    expect(await clipboard(page)).toBe(command);
    expect(command).toMatch(/^\S+ panel setup-link$/);
  });

  test("the pgvector SQL and cron commands copy with one click", async ({ page }) => {
    await installDemo(page, {
      overrides: {
        "databases.get": (input) => ({ ...databaseOf(String(input.serviceId)), ...(input.serviceId === svc.db ? { variant: "pgvector" } : {}) }),
      },
    });
    const copies = async (scope: ReturnType<Page["locator"]>, name: string, expected: string) => {
      await scope.getByRole("button", { name }).first().click();
      await expect.poll(() => clipboard(page)).toBe(expected);
    };

    await page.goto(`/p/${ids.acme}/s/${svc.db}/connection`);
    const internal = page.getByRole("region", { name: "Internal connection" });
    await expect(internal.getByText("CREATE EXTENSION vector;")).toBeVisible();
    await copies(internal.locator('[data-slot="copy-code"]'), "Copy", "CREATE EXTENSION vector;");

    // A job's command in the Cron jobs list, and in a run's output dialog.
    await page.goto(`/p/${ids.acme}/s/${svc.api}/cron`);
    const jobs = page.getByRole("region", { name: "Cron jobs" });
    await expect(jobs.getByText("bun run cleanup")).toBeVisible();
    await setClipboard(page, "");
    await copies(jobs, "Copy: Command", "bun run cleanup");
    await page.getByRole("table", { name: "Runs" }).getByRole("row").nth(1).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("cleaning sessions")).toBeVisible();
    await setClipboard(page, "");
    await copies(dialog, "Copy: Command", "bun run cleanup");
    await page.keyboard.press("Escape");

    // A cron service's command on its overview.
    await page.goto(`/p/${ids.acme}/s/${svc.cron}`);
    await expect(page.getByText("bun run reports")).toBeVisible();
    await copies(page.locator("main"), "Copy: Command", "bun run reports");
  });
});
