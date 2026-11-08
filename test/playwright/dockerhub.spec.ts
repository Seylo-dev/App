// Docker Hub as templates, with the demo data (demo/dockerhub.ts): the
// Templates page's Docker Hub tab, search, picking an image, the tag picker
// and the form the image's config fills in, then one click to create and
// deploy. And popular images from the Templates tab opening the same form
// with their presets.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { handlers as dockerHubHandlers } from "./demo/dockerhub";
import { ids } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

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
  // The image named like the query leads (the project's own, most pulled), then the verified repackaging.
  await expect(results.getByRole("button").first()).toContainText("gitea/gitea");
  await expect(results.getByRole("button").first()).toContainText("393M pulls");
  await expect(results.getByRole("button").nth(1)).toContainText("bitnamicharts/gitea");
  await expect(results.getByRole("button").nth(1)).toContainText("Verified");
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

test("Show more stops at the last page Docker Hub search serves", async ({ page }) => {
  const errors = trackErrors(page);
  const pages: number[] = [];
  await installDemo(page, {
    overrides: {
      // Docker Hub always has more for a busy query; one result a page keeps the run short.
      "dockerHub.search": (input) => {
        const n = Number(input.page ?? 1);
        pages.push(n);
        const row = { repository: `demo/app-${n}`, publisher: "demo", description: "", pullCount: 1, stars: 0, badge: "none" };
        return { results: [{ ...row, updatedAt: null, architectures: [] }], page: n, hasMore: true };
      },
    },
  });
  await page.goto(`/templates?project=${ids.acme}&tab=docker-hub&q=nginx`);
  const results = page.getByRole("region", { name: "Docker Hub images" });
  const more = page.getByRole("button", { name: "Show more" });
  for (let n = 2; n <= 20; n++) {
    await more.click();
    await expect(results.getByRole("button", { name: new RegExp(`^demo/app-${n} `) })).toBeVisible();
  }
  // Page 20 is the last one dockerHub.search accepts: no button, no request for 21.
  await expect(more).toHaveCount(0);
  expect(Math.max(...pages)).toBe(20);
  expect(errors).toEqual([]);
});

test("a private image preselects the Docker Hub login the panel read it with", async ({ page }) => {
  const errors = trackErrors(page);
  let created: Record<string, any> | null = null;
  const login = (id: string, name: string, createdAt: string) => ({
    id,
    name,
    server: "docker.io",
    username: name,
    usedBy: 0,
    createdAt,
    updatedAt: createdAt,
  });
  await installDemo(page, {
    overrides: {
      // Sorted by name, as registries.list answers: the login that reads the image is the second one.
      "registries.list": () => ({
        registries: [login("reg0000000000002", "alpha-hub", "2026-10-02T10:00:00Z"), login("reg0000000000001", "zeta-hub", "2026-10-01T10:00:00Z")],
      }),
      "dockerHub.inspect": (input) => ({
        ...(dockerHubHandlers["dockerHub.inspect"]?.(input) as object),
        private: true,
        registryId: "reg0000000000001",
      }),
      "dockerHub.create": (input) => {
        created = input;
        return { ...(serviceHandlers["services.get"]?.({ serviceId: svc.api }) as object), name: input.name };
      },
    },
  });
  await page.goto(`/templates?project=${ids.acme}&tab=docker-hub&q=gitea`);
  await page.getByRole("region", { name: "Docker Hub images" }).getByRole("button", { name: /^gitea\/gitea / }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("combobox", { name: "Pull with" })).toContainText("zeta-hub");
  await dialog.getByRole("button", { name: "Create and deploy" }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}`));
  expect(created).toMatchObject({ repository: "gitea/gitea", registryId: "reg0000000000001" });
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
