// Toasts (packages/ui/src/components/toast.tsx) on the UI kit page: a new
// toast must not touch the ones already showing. Before the fix, every
// render of the stack gave each card a new onDismiss, its timer effect's
// cleanup wrote the time left to state, and that state was the effect's
// own dependency: on a machine where a render takes a millisecond or more
// the card re-rendered itself in a loop (React's "Maximum update depth
// exceeded"), eating its own time until it vanished.

import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

test("a second toast leaves the first one alone, even when every render takes a millisecond", async ({ page }) => {
  const loops: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /Maximum update depth/.test(message.text())) loops.push(message.text());
  });
  // A slow machine, made exact: the clock moves on by a millisecond each time it is read.
  await page.addInitScript(() => {
    const now = Date.now.bind(Date);
    let reads = 0;
    Date.now = () => now() + ++reads;
  });
  await installDemo(page);
  await page.goto("/dev/kit");
  const notifications = page.getByRole("region", { name: "Notifications" });

  await page.getByRole("button", { name: "Toast: success" }).click();
  const first = notifications.getByRole("status").filter({ hasText: "Settings saved" });
  await expect(first).toBeVisible();
  await page.getByRole("button", { name: "Toast: plain" }).click();
  await expect(notifications.getByRole("status").filter({ hasText: "Copied the connection URL" })).toBeVisible();

  // Both stay up for their five seconds; the first does not run its clock down by re-rendering itself.
  await page.waitForTimeout(1_500);
  await expect(first).toBeVisible();
  expect(loops).toEqual([]);
});
