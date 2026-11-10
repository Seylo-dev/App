// Settings > Docker cleanup on the demo data: picking a node shows its last
// cleanup (what started it and what it freed) and when its own schedule
// runs next, with the way to that node's schedule and history.

import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { expect, stateFile, test } from "./helpers";

test.use({ storageState: stateFile });

test("a node's last cleanup and next automatic one show under the node picker", async ({ page }) => {
  await installDemo(page);
  await page.goto("/settings/cleanup");
  await page.getByRole("combobox", { name: "Node" }).click();
  await page.getByRole("option", { name: "de-fsn-1" }).click();
  const line = page.getByTestId("last-cleanup");
  await expect(line).toContainText(/Last cleanup \d+ h ago \(Schedule\), freed 3\.2 GB\./);
  await expect(line).toContainText("Next automatic cleanup");
  await expect(line.getByRole("link", { name: "Schedule and history" })).toHaveAttribute("href", `/nodes?node=${ids.de}&view=cleanup`);
});
