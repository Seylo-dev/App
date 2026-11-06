// Docker Hub as templates, with the demo data (demo/dockerhub.ts): the
// Templates page's Docker Hub tab, search, picking an image, the tag picker
// and the form the image's config fills in, then one click to create and
// deploy. And popular images from the Templates tab opening the same form
// with their presets.

import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { stateFile } from "./helpers";

const shots = `${process.env.SHOTS_DIR ?? "shots"}/dockerhub`;

test.use({ storageState: stateFile });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

/** The text of the dialog's .env editor (Monaco renders lines as divs). */
async function envText(page: Page): Promise<string> {
  const lines = page.getByRole("dialog").locator(".monaco-editor .view-line");
  await expect(lines.first()).toBeVisible({ timeout: 15_000 });
  return (await lines.allTextContents()).join("\n").replace(/ /g, " ");
}

test("search Docker Hub, pick an image and a tag, create it from the prefilled form", async ({ page }) => {
  mkdirSync(shots, { recursive: true });
  const errors = trackErrors(page);
  let created: Record<string, any> | null = null;
  await installDemo(page, {
    overrides: {
      "dockerHub.create": (input) => {
        created = input;
        return { ...(serviceHandlers["services.get"]?.({ serviceId: svc.api }) as object), name: input.name };
      },
    },
  });

  await page.goto(`/templates?project=${ids.acme}`);
  await page.getByRole("radio", { name: "Docker Hub" }).click();
  await expect(page).toHaveURL(/tab=docker-hub/);
  await expect(page.getByRole("heading", { name: "Search Docker Hub" })).toBeVisible();
  // Before anything is typed, the popular images are right there.
  await expect(page.getByRole("heading", { name: "Popular images" })).toBeVisible();

  await page.getByRole("searchbox", { name: "Search Docker Hub" }).fill("gitea");
  const results = page.getByRole("region", { name: "Docker Hub images" });
  // Verified publishers come first.
  await expect(results.getByRole("button").first()).toContainText("bitnamicharts/gitea");
  await expect(results.getByRole("button").first()).toContainText("Verified");
  await expect(results.getByRole("button", { name: /^gitea\/gitea / })).toContainText("393M pulls");
  await page.screenshot({ path: `${shots}/search.png`, fullPage: true });

  await results.getByRole("button", { name: /^gitea\/gitea / }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Set up gitea/gitea" })).toBeVisible();
  // The suggested tag is the full version latest points at.
  const tagButton = dialog.locator("#hub-tag");
  await expect(tagButton).toContainText("28.3.0");
  await expect(tagButton).toContainText("suggested");
  // Prefilled from the image: the web port of 22 and 3000, public, the VOLUME, the ENV.
  await expect(dialog.getByRole("combobox", { name: "Main port" })).toContainText("3000");
  await expect(dialog.getByRole("switch", { name: /Reachable from outside/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: "/data" })).toBeChecked();
  await expect(dialog.getByText("888888…8888")).toBeVisible();
  await expect(dialog.getByLabel("Service name")).toHaveValue("gitea");
  const env = await envText(page);
  expect(env).toContain("GITEA_CUSTOM=/data/gitea");
  expect(env).toContain("SECRET_KEY=");
  expect(env).not.toContain("changeme");
  expect(env).not.toContain("PATH=");
  await page.screenshot({ path: `${shots}/form.png` });

  // Another tag from the picker; the form follows it.
  await tagButton.click();
  await page.getByRole("option", { name: /^28\.2\.0/ }).click();
  await expect(tagButton).toContainText("28.2.0");
  await expect(tagButton).not.toContainText("suggested");

  await dialog.getByRole("button", { name: "Create and deploy" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}`));
  expect(created).toMatchObject({
    projectId: ids.acme,
    name: "gitea",
    repository: "gitea/gitea",
    tag: "28.2.0",
    port: 3000,
    public: true,
    registryId: null,
    volumes: [{ mountPath: "/data" }],
    deployNow: true,
  });
  expect(created?.env).toContain("GITEA_CUSTOM=/data/gitea");
  expect(errors).toEqual([]);
});

test("a popular image opens the same form with its preset port", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  await page.goto(`/templates?project=${ids.acme}`);
  const popular = page.getByRole("region", { name: "Popular images" });
  await popular.getByRole("button", { name: /Uptime Kuma/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Set up louislam/uptime-kuma" })).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "Main port" })).toContainText("3001");
  await expect(dialog.getByRole("checkbox", { name: "/app/data" })).toBeChecked();
  await expect(dialog.getByText("extra/healthcheck")).toBeVisible();
  await expect(dialog.getByLabel("Service name")).toHaveValue("uptime-kuma");
  await page.screenshot({ path: `${shots}/popular.png` });
  await page.keyboard.press("Escape");

  // Metabase keeps its database file in a folder the image does not declare: the preset adds the volume and the setting.
  await popular.getByRole("button", { name: /Metabase/ }).click();
  await expect(dialog.getByRole("heading", { name: "Set up metabase/metabase" })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "/metabase-data" })).toBeChecked();
  expect(await envText(page)).toContain("MB_DB_FILE=/metabase-data/metabase.db");
  expect(errors).toEqual([]);
});

test("the New service menu opens the Docker Hub tab", async ({ page }) => {
  await installDemo(page);
  await page.goto(`/p/${ids.acme}`);
  await page.getByRole("button", { name: "New service" }).click();
  await page.getByRole("menuitem", { name: /From Docker Hub/ }).click();
  await expect(page).toHaveURL(new RegExp(`/templates\\?.*tab=docker-hub`));
  await expect(page).toHaveURL(new RegExp(`project=${ids.acme}`));
  await expect(page.getByRole("radio", { name: "Docker Hub" })).toBeChecked();
});
