// The connected GitHub account and the New app port, on the demo data:
// Settings > GitHub's "Use a token" (the steps, the link to GitHub's token
// page, a refused token saying why, the account card after), the
// organization access note, the service Source tab with only an account
// connected (no "Connect GitHub first", the account's repositories,
// connecting with accountId), and the New app Port field (80 filled in,
// the Docker Hub image's exposed port, an edit that sticks, PORT for
// built apps, no port for Set up later). The ops are answered by the demo
// and recorded.

import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { ids } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { githubAccount } from "./demo/repos";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/github-account`;

test.use({ storageState: stateFile });

function watchOps(page: Page) {
  const calls: { op: string; input: Input }[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match) return;
    const input = request.method() === "GET" ? Object.fromEntries(new URL(request.url()).searchParams) : (request.postDataJSON() ?? {});
    calls.push({ op: match[1] as string, input });
  });
  return (op: string) => calls.filter((c) => c.op === op).map((c) => c.input);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  return errors;
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(shots, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: true });
}

const status = (account: unknown) => ({
  app: null,
  webhookUrl: "https://panel.acme.dev/api/hooks/github",
  deviceFlowAvailable: true,
  account,
});

const goodToken = `github_pat_${"x".repeat(40)}`;
const classicNoRepo = `ghp_${"y".repeat(36)}`;

test("Use a token: the steps and GitHub's token page, a refused token says why, a good one becomes the account card", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  let account: unknown = null;
  await installDemo(page, {
    overrides: {
      "github.status": () => status(account),
      "github.tokenConnect": (input) => {
        if (input.token !== goodToken) {
          throw new DemoRefusal(
            400,
            "BAD_REQUEST",
            "This classic token has no repo scope, so it cannot read private repositories. Create one with the repo scope, or a fine-grained token with Contents: Read.",
            { field: "token", reason: "scope" },
          );
        }
        account = {
          id: githubAccount.id,
          login: githubAccount.login,
          method: "token",
          scopes: [],
          tokenKind: "fineGrained",
          connectedAt: new Date().toISOString(),
        };
        return account;
      },
    },
  });
  await page.goto("/settings/github");
  await expect(page.getByText("Private repositories without the App")).toBeVisible();
  // Organizations: what an owner approves, and that the App avoids it.
  await expect(page.getByText("github.com/organizations/<org>/settings/oauth_application_policy")).toBeVisible();
  await expect(page.getByText(/The GitHub App installed on the organization needs neither/)).toBeVisible();

  await page.getByRole("button", { name: "Use a token" }).click();
  const form = page.getByTestId("github-token-form");
  await expect(form.getByRole("link", { name: "github.com/settings/tokens" })).toHaveAttribute("href", "https://github.com/settings/tokens");
  await expect(form.getByRole("listitem")).toHaveCount(4);
  await expect(form).toContainText("Contents: Read and Metadata: Read");
  await expect(form).toContainText("classic token with the repo scope");
  const save = form.getByRole("button", { name: "Check and save" });
  await expect(save).toBeDisabled();
  await expect(form.getByLabel("Token")).toHaveAttribute("type", "password");
  await shot(page, "use-a-token");

  await form.getByLabel("Token").fill(classicNoRepo);
  await save.click();
  await expect(form.getByRole("alert")).toHaveText(/no repo scope/);
  await expect(form.getByLabel("Token")).toHaveAttribute("aria-invalid", "true");
  await shot(page, "token-refused");

  await form.getByLabel("Token").fill(goodToken);
  await save.click();
  await expect(page.getByText("Token saved for @dana")).toBeVisible();
  const card = page.getByTestId("github-account");
  await expect(card).toContainText("@dana, connected on");
  await expect(card).toContainText("Personal access token");
  await expect(card).toContainText("Fine-grained");
  await expect(card.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await expect(form).toHaveCount(0);
  await shot(page, "account-card");
  expect(calls("github.tokenConnect").map((c) => c.token)).toEqual([classicNoRepo, goodToken]);
  expect(errors).toEqual([]);
});

test("the Source tab with only a connected account: no 'Connect GitHub first', its repositories, connect with accountId", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page, {
    overrides: { "github.installations": () => ({ installations: [], installUrl: null, account: githubAccount, hidden: false }) },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.privateApi}/source`);
  await page.getByRole("radio", { name: /^GitHub/ }).click();
  await expect(page.getByText("Connect GitHub first")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Account" })).toContainText("@dana (connected account)");
  const list = page.getByRole("listbox", { name: "Repository" });
  await expect(list.getByRole("option", { name: /dana\/notes/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /acme\/legacy-api/ })).toBeVisible();
  await shot(page, "source-tab-account");
  await list.getByRole("option", { name: /acme\/legacy-api/ }).click();
  await expect(page.getByRole("combobox", { name: "Branch" })).toContainText("master");
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(page.getByText("Repository connected. The next deploy builds it.")).toBeVisible();
  expect(calls("github.repos")[0]).toMatchObject({ projectId: ids.acme, accountId: githubAccount.id });
  expect(calls("github.connectRepo")).toEqual([
    { serviceId: svc.privateApi, accountId: githubAccount.id, repo: "acme/legacy-api", branch: "master", deployOnPush: true },
  ]);
  expect(errors).toEqual([]);
});

test("the Source tab takes a GitHub link or owner/repo: looked up by name, offered on top, its tree/ branch picked", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page, {
    overrides: {
      "github.installations": () => ({ installations: [], installUrl: null, account: githubAccount, hidden: false }),
      // The list does not show acme/legacy-api (an organization's, past the first page): only a lookup by name finds it.
      "github.repos": (input: Input) => ({
        repos: [{ fullName: "dana/notes", private: true, defaultBranch: "main", pushedAt: new Date().toISOString() }].filter(
          (r) => !input.query || r.fullName.includes(String(input.query).toLowerCase()),
        ),
        hasMore: false,
      }),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.privateApi}/source`);
  await page.getByRole("radio", { name: /^GitHub/ }).click();
  const search = page.getByRole("textbox", { name: "Search repositories" });
  await expect(search).toHaveAttribute("placeholder", "Search, or paste a GitHub link or owner/repo");
  const list = page.getByRole("listbox", { name: "Repository" });

  // A page address with a branch: found through the account, offered on top, the branch from tree/.
  await search.fill("https://github.com/acme/legacy-api/tree/v2");
  const typed = list.getByRole("option", { name: /acme\/legacy-api.*Use this repository/ });
  await expect(typed).toBeVisible();
  await shot(page, "source-tab-typed-link");
  await typed.click();
  await expect(page.getByRole("combobox", { name: "Branch" })).toContainText("v2");
  expect(calls("github.branches")).toContainEqual(expect.objectContaining({ accountId: githubAccount.id, repo: "acme/legacy-api" }));

  // Enter picks the found one and never connects: owner/repo of a listed repository, its default branch.
  await search.fill("dana/notes");
  await expect(list.getByRole("option", { name: /dana\/notes.*Use this repository/ })).toBeVisible();
  await search.press("Enter");
  await expect(list.getByRole("option", { name: /dana\/notes/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("combobox", { name: "Branch" })).toContainText("main");
  expect(calls("github.connectRepo")).toEqual([]);

  // One the account cannot read: GitHub's answer under the field, nothing to pick.
  await search.fill("acme/nope");
  await expect(page.getByText("The connection cannot read acme/nope, or there is no such repository.")).toBeVisible();
  await expect(list).toHaveCount(0);
  // Another host: pointed at the Git source.
  await search.fill("gitlab.com/acme/app");
  await expect(page.getByText("Only github.com repositories come through GitHub. For another host, pick the Git source.")).toBeVisible();

  await search.fill("https://github.com/acme/legacy-api");
  await list.getByRole("option", { name: /acme\/legacy-api.*Use this repository/ }).click();
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(page.getByText("Repository connected. The next deploy builds it.")).toBeVisible();
  expect(calls("github.connectRepo")).toEqual([
    { serviceId: svc.privateApi, accountId: githubAccount.id, repo: "acme/legacy-api", branch: "master", deployOnPush: true },
  ]);
  expect(errors).toEqual([]);
});

test("through an installation: another owner's repository points at its Account, and owner/partial is a quiet search", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  // The demo world: installations on acme (picked first) and lee-park.
  await installDemo(page);
  await page.goto(`/p/${ids.acme}/s/${svc.privateApi}/source`);
  await page.getByRole("radio", { name: /^GitHub/ }).click();
  await expect(page.getByRole("combobox", { name: "Account" })).toContainText("acme");
  const search = page.getByRole("textbox", { name: "Search repositories" });
  const list = page.getByRole("listbox", { name: "Repository" });

  // lee-park/blog is not read through acme's installation: no lookup, and the hint names the Account that reads it.
  await search.fill("lee-park/blog");
  await expect(page.getByText("lee-park's repositories are read through lee-park. Pick it as the Account above.")).toBeVisible();
  await page.waitForTimeout(500);
  expect(calls("github.branches").filter((c) => c.repo === "lee-park/blog")).toEqual([]);

  // "acme/shop" filters the list (shop-api, shop-worker): GitHub's NOT_FOUND for the name is no alert.
  await search.fill("acme/shop");
  await expect(list.getByRole("option", { name: /acme\/shop-api/ })).toBeVisible();
  await expect(list.getByRole("option", { name: /acme\/shop-worker/ })).toBeVisible();
  await expect.poll(() => calls("github.branches").some((c) => c.repo === "acme/shop")).toBe(true);
  await page.waitForTimeout(300);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // One match left: Enter picks it.
  await search.fill("acme/shop-w");
  await expect(list.getByRole("option")).toHaveCount(1);
  await page.waitForTimeout(400);
  await search.press("Enter");
  await expect(list.getByRole("option", { name: /acme\/shop-worker/ })).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("nothing on GitHub connected: the Source tab still says 'Connect GitHub first'", async ({ page }) => {
  await installDemo(page, {
    overrides: { "github.installations": () => ({ installations: [], installUrl: null, account: null, hidden: false }) },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.privateApi}/source`);
  await page.getByRole("radio", { name: /^GitHub/ }).click();
  await expect(page.getByText("Connect GitHub first")).toBeVisible();
  await expect(page.getByRole("link", { name: "Set up GitHub" })).toHaveAttribute("href", "/settings/github");
});

/** Opens New service > App on the acme project and names it web. */
async function openNewApp(page: Page) {
  await page.goto(`/p/${ids.acme}`);
  await page.getByRole("button", { name: "New service", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "GitHub, Git, Docker image" }).click();
  const dialog = page.getByRole("dialog", { name: "New app" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill("web");
  return dialog;
}

test("Port: 80 filled in, the Docker Hub image's exposed port when known, and an edit sticks", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openNewApp(page);
  const port = dialog.locator("#ns-port");
  const hint = dialog.locator("#ns-port-hint");
  await expect(port).toHaveValue("80");
  await expect(hint).toHaveText("The port your app listens on. Domains and health checks use it.");
  await shot(page, "port-default");

  // gitea/gitea exposes 22 and 3000 (demo/dockerhub.ts): the web one fills the field.
  await dialog.locator("#ns-image").fill("gitea/gitea:28.3.0");
  await expect(port).toHaveValue("3000");
  await expect(hint).toHaveText("The port gitea/gitea exposes. Domains and health checks use it.");
  expect(calls("dockerHub.inspect")).toContainEqual({ repository: "gitea/gitea", tag: "28.3.0" });
  await shot(page, "port-from-image");

  // Another registry: nothing to ask Docker Hub, back to the default.
  await dialog.locator("#ns-image").fill("ghcr.io/acme/api:1.4");
  await expect(port).toHaveValue("80");
  expect(calls("dockerHub.inspect").some((c) => c.repository?.includes("ghcr"))).toBe(false);

  // Typed by hand: it stays whatever image comes next.
  await port.fill("8080");
  await dialog.locator("#ns-image").fill("gitea/gitea:28.3.0");
  await page.waitForTimeout(900);
  await expect(port).toHaveValue("8080");

  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("services.create")[0]).toMatchObject({
    source: { type: "image", image: "gitea/gitea:28.3.0" },
    ports: [{ containerPort: 8080, protocol: "tcp" }],
  });
  expect(errors).toEqual([]);
});

test("a built app's Port says it becomes PORT, and 80 is what gets created", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openNewApp(page);
  await dialog.getByRole("radio", { name: "Git repository", exact: true }).click();
  await expect(dialog.locator("#ns-port")).toHaveValue("80");
  await expect(dialog.locator("#ns-port-hint")).toHaveText("Your app gets it as PORT and should listen on it. Domains and health checks use it.");
  await dialog.locator("#ns-git").fill("https://git.example.com/team/app.git");
  await expect(dialog.locator("#ns-git-branch")).toHaveValue("main");
  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("services.create")[0]).toMatchObject({ ports: [{ containerPort: 80, protocol: "tcp" }] });
});

test("Set up later shows no Port and sends none, so the empty app opens no first-run port", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openNewApp(page);
  // A port typed for another source is not sent either.
  await dialog.locator("#ns-port").fill("8080");
  await dialog.getByRole("radio", { name: "Set up later", exact: true }).click();
  await expect(dialog.locator("#ns-port")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  const create = calls("services.create")[0];
  expect(create).toMatchObject({ kind: "app", deployNow: false });
  expect(create?.ports).toBeUndefined();
  expect(create?.source).toBeUndefined();
});
