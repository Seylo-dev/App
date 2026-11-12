// Git providers in the browser, on the demo data: adding a GitLab, Gitea
// or Bitbucket connection in Settings, connecting a provider repository in
// a service's Source tab (repo picker, branch, webhook state), and the
// watch paths editor with its live tester. The provider answers are
// per-test overrides, so nothing leaves the machine.

import type { Page } from "@playwright/test";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { ids, viewer } from "./demo/fixtures";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/git-providers`;

const now = new Date().toISOString();
const gitlab = {
  id: "gp00000000000001",
  kind: "gitlab",
  name: "Company GitLab",
  url: "https://gitlab.com",
  host: "gitlab.com",
  workspace: null,
  authKind: "token",
  account: "deploy-bot",
  username: null,
  statusNotes: true,
  usedBy: 1,
  createdAt: now,
  updatedAt: now,
};

function watchApi(page: Page) {
  const calls: { op: string; input: Input }[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (match && request.method() === "POST") calls.push({ op: match[1] as string, input: request.postDataJSON() ?? {} });
  });
  return calls;
}

test.describe("git providers", () => {
  test.use({ storageState: stateFile });

  test("add a Gitea connection in Settings and see it listed", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let items: Input[] = [gitlab];
    const calls = watchApi(page);
    await installDemo(page, {
      overrides: {
        "gitProviders.list": () => ({ items }),
        "gitProviders.create": (input) => {
          const created = { ...gitlab, id: "gp00000000000002", kind: input.kind, name: input.name, url: input.url, host: "git.example.com", account: "jdev", usedBy: 0 };
          items = [...items, created];
          return created;
        },
        "gitProviders.check": () => ({ ok: true, account: "deploy-bot", message: "The token works and acts as deploy-bot." }),
      },
    });
    await page.goto("/settings/git-providers");
    await expect(page.getByRole("heading", { level: 1, name: "Git providers" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Git providers" })).toBeVisible();
    await expect(page.getByText("Company GitLab")).toBeVisible();
    // Exact: on a phone each row also repeats its details in one line (host · user · services).
    await expect(page.getByText("deploy-bot", { exact: true })).toBeVisible();

    await page.getByRole("radio", { name: "Gitea or Forgejo" }).click();
    const save = page.getByRole("button", { name: "Check and save" });
    await expect(save).toBeDisabled();
    await page.getByLabel("Name").fill("Forge");
    await page.getByLabel("Address").fill("https://git.example.com/");
    await page.getByLabel("Token").fill("gitea-token-1");
    await save.click();
    await expect(page.getByText("Connected as jdev.")).toBeVisible();
    await page.screenshot({ path: `${shots}/settings.png`, fullPage: true });
    await expect(page.getByRole("cell", { name: "Forge Gitea or Forgejo" })).toBeVisible();
    const create = calls.find((c) => c.op === "gitProviders.create");
    expect(create?.input).toEqual({ kind: "gitea", name: "Forge", token: "gitea-token-1", statusNotes: true, url: "https://git.example.com" });

    // Bitbucket asks for a workspace, and a user name with an app password.
    await page.getByRole("radio", { name: "Bitbucket" }).click();
    await expect(page.getByLabel("Workspace")).toBeVisible();
    await page.getByRole("radio", { name: "App password" }).click();
    await expect(page.getByLabel("Bitbucket user name")).toBeVisible();

    // Check and Delete sit in the row's menu, like every other settings table.
    await page.getByRole("row", { name: /Company GitLab/ }).getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Check" }).click();
    await expect(page.getByText("The token works", { exact: true })).toBeVisible();
    await page.getByRole("row", { name: /Company GitLab/ }).getByRole("button", { name: "Row actions" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    await expect(page.getByRole("alertdialog", { name: "Delete the connection Company GitLab?" })).toBeVisible();
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  });

  test("connect a GitLab repository in the Source tab and see its webhook", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const calls = watchApi(page);
    await installDemo(page, {
      overrides: {
        "gitProviders.list": () => ({ items: [gitlab] }),
        "gitProviders.repos": () => ({
          repos: [
            { fullName: "acme/platform/shop", private: true, defaultBranch: "main", updatedAt: now },
            { fullName: "acme/site", private: false, defaultBranch: "trunk", updatedAt: now },
          ],
          hasMore: false,
        }),
        "gitProviders.branches": (input) => ({
          defaultBranch: input.repo === "acme/site" ? "trunk" : "main",
          branches: input.repo === "acme/site" ? ["trunk", "next"] : ["main", "feat/checkout"],
        }),
        "gitProviders.webhook": () => ({
          configured: true,
          kind: "gitlab",
          repo: "acme/platform/shop",
          url: "https://panel.example.com/api/hooks/gitlab/hk00000000000001",
          created: true,
          error: null,
          insecure: false,
          lastDeliveryAt: now,
          createdAt: now,
        }),
        "services.get": (input) => ({
          ...(serviceDetail(input.serviceId as string) as object),
          source: { type: "gitlab", label: "acme/platform/shop", branch: "main", builder: "railpack" },
          sourceConfig: { type: "provider", providerId: gitlab.id, provider: "gitlab", repo: "acme/platform/shop", branch: "main", deployOnPush: true },
        }),
        "gitProviders.connectRepo": (input) => serviceDetail(input.serviceId as string),
      },
    });
    await page.goto(`/p/${ids.acme}/s/${svc.api}/source`);
    const card = page.getByRole("radio", { name: /GitLab/ });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText("In use now")).toBeVisible();
    await expect(page.getByText("https://panel.example.com/api/hooks/gitlab/hk00000000000001")).toBeVisible();
    await expect(page.getByText(/Pushes and merge requests reach the panel/)).toBeVisible();
    await page.screenshot({ path: `${shots}/source.png`, fullPage: true });

    await page.getByRole("option", { name: /acme\/site/ }).click();
    await expect(page.getByRole("combobox", { name: "Branch" })).toHaveText("trunk");
    await page.getByRole("button", { name: "Connect repository" }).click();
    await expect(page.getByText("Repository connected and webhook created.")).toBeVisible();
    const connect = calls.find((c) => c.op === "gitProviders.connectRepo");
    expect(connect?.input).toMatchObject({ providerId: gitlab.id, repo: "acme/site", branch: "trunk", deployOnPush: true });

    // Without a connection of that kind there is no card (0.2.6, owner request); a line says where to connect one.
    await expect(page.getByRole("radio", { name: /GitLab/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Bitbucket/ })).toHaveCount(0);
    await expect(page.getByRole("radio", { name: /Gitea/ })).toHaveCount(0);
    await expect(page.getByText("GitLab, Gitea and Bitbucket show here once you connect one.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Settings > Git providers" })).toHaveAttribute("href", "/settings/git-providers");
    expect(errors).toEqual([]);
  });

  test("a viewer sees a GitLab source read-only, and its Deployments tab says pushes deploy", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await installDemo(page, {
      overrides: {
        "auth.whoami": () => ({ viewer: { ...viewer, role: "member" }, via: "session" }),
        // What the panel answers someone who may create or update services nowhere.
        "gitProviders.list": () => ({ items: [], hidden: true }),
        "gitProviders.webhook": () => ({
          configured: true,
          kind: "gitlab",
          repo: "acme/shop",
          url: null,
          created: false,
          error: "GitLab answered 403.",
          insecure: false,
          lastDeliveryAt: null,
          createdAt: now,
        }),
        "services.get": (input) => ({
          ...(serviceDetail(input.serviceId as string) as object),
          source: { type: "gitlab", label: "acme/shop", branch: "main", builder: "railpack" },
          sourceConfig: { type: "provider", providerId: gitlab.id, provider: "gitlab", repo: "acme/shop", branch: "main", deployOnPush: true },
        }),
      },
    });
    await page.goto(`/p/${ids.acme}/s/${svc.api}/source`);
    await expect(page.getByLabel("Repository")).toHaveValue("acme/shop");
    await expect(page.getByLabel("Branch")).toHaveValue("main");
    await expect(page.getByText("Connecting or changing a GitLab repository needs the right to create or update services.")).toBeVisible();
    await expect(page.getByText("Connect GitLab first")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Add a connection" })).toHaveCount(0);
    // The webhook state shows, without a repair button the viewer could not use.
    await expect(page.getByText("The webhook could not be created")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create webhook again" })).toHaveCount(0);
    await page.screenshot({ path: `${shots}/source-viewer.png`, fullPage: true });

    await page.goto(`/p/${ids.acme}/s/${svc.api}/deployments`);
    await expect(page.getByText("Deploy on push: on")).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("watch paths: the tester answers live and saving sends the cleaned list", async ({ page }) => {
    const calls = watchApi(page);
    await installDemo(page, {
      overrides: { "services.setWatchPaths": (input) => ({ watchPaths: input.watchPaths }) },
    });
    await page.goto(`/p/${ids.acme}/s/${svc.api}/source`);
    const patterns = page.getByLabel("Patterns");
    await expect(patterns).toBeVisible();
    const save = page.getByRole("button", { name: "Save watch paths" });
    await expect(save).toBeDisabled();
    await patterns.fill("./apps/web/\n!**/*.md\n");
    await page.getByLabel("Try it").fill("apps/web/src/index.ts\napps/web/README.md\ndocs/intro.md");
    const result = page.getByTestId("watch-result");
    await expect(result.getByText("This push would deploy")).toBeVisible();
    await expect(result.getByText("matches apps/web/**", { exact: true })).toBeVisible();
    await expect(result.getByText("excluded by !**/*.md", { exact: true })).toHaveCount(2);

    await page.getByTestId("watch-result").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/watch-paths.png`, fullPage: true });
    await page.getByLabel("Try it").fill("docs/intro.md");
    await expect(result.getByText("This push would be skipped")).toBeVisible();

    await save.click();
    await expect(page.getByText("Watch paths saved.")).toBeVisible();
    expect(calls.find((c) => c.op === "services.setWatchPaths")?.input).toEqual({ serviceId: svc.api, watchPaths: ["apps/web/**", "!**/*.md"] });
  });

  test("watch paths: a pattern that never matches is refused as you type, with what to write", async ({ page }) => {
    const calls = watchApi(page);
    await installDemo(page, {
      overrides: { "services.setWatchPaths": (input) => ({ watchPaths: input.watchPaths }) },
    });
    await page.goto(`/p/${ids.acme}/s/${svc.api}/source`);
    const patterns = page.getByLabel("Patterns");
    const save = page.getByRole("button", { name: "Save watch paths" });
    await patterns.fill("apps/web/**\napps/docs/..");
    const refusal = page.getByRole("alert").filter({ hasText: "never matches a file" });
    await expect(refusal).toHaveText(
      "apps/docs/.. never matches a file: paths start at the repository root. To watch a folder, write apps/docs/**",
    );
    await expect(save).toBeDisabled();
    await page.screenshot({ path: `${shots}/watch-paths-refused.png`, fullPage: true });

    await patterns.fill("apps/web/**\napps/docs/**");
    await expect(refusal).toHaveCount(0);
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText("Watch paths saved.")).toBeVisible();
    expect(calls.find((c) => c.op === "services.setWatchPaths")?.input).toEqual({
      serviceId: svc.api,
      watchPaths: ["apps/web/**", "apps/docs/**"],
    });
  });
});

/** The demo's own answer for services.get, so overrides can build on it. */
function serviceDetail(serviceId: string): Input {
  return (serviceHandlers["services.get"] as (input: Input) => Input)({ serviceId });
}
