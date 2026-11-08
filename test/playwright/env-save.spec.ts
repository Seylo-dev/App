// Typing while an environment save is on its way, on the demo data: what
// was typed after Save is not saved yet, so the editor must still say so
// (Save stays on) instead of treating the newer text as saved (the service
// Environment tab) or replacing it with the saved text (the project's
// Shared environment).

import { expect, test } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { stateFile } from "./helpers";

type Input = Record<string, any>;

const slowSave = (opId: string) => (opId === "env.set" || opId === "env.setShared" ? 1500 : 0);

test.describe("environment saves", () => {
  test.use({ storageState: stateFile });

  test("text typed during a service env save stays unsaved", async ({ page }) => {
    const sent: string[] = [];
    await installDemo(page, {
      delay: slowSave,
      overrides: {
        "env.set": (input: Input) => {
          sent.push(input.text as string);
          return { updatedAt: new Date().toISOString(), diagnostics: [], restartNeeded: false };
        },
      },
    });
    await page.goto(`/p/${ids.acme}/s/${svc.worker}/environment`);
    const editor = page.locator(".monaco-editor").first();
    await expect(editor).toBeVisible({ timeout: 15_000 });
    await editor.click();
    // The end of the text. The browser says it is Windows (Desktop Chrome), so Monaco's keys are Control ones.
    await page.keyboard.press("Control+End");
    await page.keyboard.type("THIRD=3");
    // The editor's state has caught up with the keys (the status bar shows the cursor after them).
    await expect(page.getByText(/Ln 11, Col 8/)).toBeVisible();

    // Save with the editor's shortcut, so the cursor stays in the editor, and keep typing.
    await page.keyboard.press("Control+s");
    await expect(page.getByRole("button", { name: /^Saving/ })).toBeVisible();
    await page.keyboard.type("\nFOURTH=4");
    await expect(page.getByText("Saved.")).toBeVisible();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("THIRD=3");
    expect(sent[0]).not.toContain("FOURTH=4");
    // FOURTH=4 is only in the editor: Save is still on for it.
    await expect(editor.getByText("FOURTH=4")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Save/ })).toBeEnabled();
  });

  test("text typed during a shared env save is kept", async ({ page }) => {
    const sent: string[] = [];
    await installDemo(page, {
      delay: slowSave,
      overrides: {
        "env.setShared": (input: Input) => {
          sent.push(input.text as string);
          return { updatedAt: new Date().toISOString(), diagnostics: [], affectedServiceIds: [] };
        },
      },
    });
    await page.goto(`/p/${ids.acme}?tab=env`);
    const box = page.getByRole("textbox", { name: "Shared environment" });
    await expect(box).toBeVisible();
    await box.press("Control+End");
    await box.pressSequentially("THIRD=3\n");

    const saveButton = page.getByRole("button", { name: "Save", exact: true });
    await saveButton.click();
    await box.pressSequentially("FOURTH=4\n");
    await expect(page.getByText("Shared environment saved.")).toBeVisible();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("THIRD=3");
    expect(sent[0]).not.toContain("FOURTH=4");
    await expect(box).toHaveValue(/FOURTH=4/);
    await expect(saveButton).toBeEnabled();
  });
});
