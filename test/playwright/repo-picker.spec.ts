// The New app dialog's GitHub and Git repository tabs on the demo data
// (demo/repos.ts). GitHub: browsing and picking a repository of the GitHub
// App or of the connected GitHub account, typing owner/repo that an
// installation or the account reads (a GitHub source) or that none reads
// (a public GitHub URL), page addresses, the branch suggestions with the
// default preselected and the branch following the repository, the setup
// steps while nothing is connected, the loading, error and unchecked
// states, a project change, a member who may not connect, the list's size
// at a short window and on a phone, and the keyboard. Git repository: a
// plain URL field, with no picker and no owner/repo shorthand. The Source
// tab's pickers (GitHub and a GitLab connection) open on the service's
// repository, selected and scrolled into view, and a new search starts with
// the first key. The ops are answered by the demo and recorded, so the test
// checks what gets created.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids, viewer } from "./demo/fixtures";
import { githubAccount, gitlabConnection, installation, withAccount } from "./demo/repos";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/repo-picker`;

test.use({ storageState: stateFile });

/** Every op call the page makes, with its input (query string for GET, body for POST). */
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

/** Answers one op with an error the way the panel does, optionally only for some inputs. */
async function refuse(page: Page, op: string, status: number, code: string, message: string, when: (url: URL) => boolean = () => true) {
  await page.route(new RegExp(`/api/v1/${op.replace(".", "\\.")}`), (route) => {
    if (!when(new URL(route.request().url()))) return route.fallback();
    return route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ error: { code, message } }) });
  });
}

/** Opens New service > App on the acme project, names it web and switches to a source tab. */
async function openTab(page: Page, tab: "GitHub" | "Git repository", field: string): Promise<Locator> {
  mkdirSync(shots, { recursive: true });
  await page.goto(`/p/${ids.acme}`);
  await page.getByRole("button", { name: "New service", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: "GitHub, Git, Docker image" }).click();
  const dialog = page.getByRole("dialog", { name: "New app" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill("web");
  await dialog.getByRole("radio", { name: tab, exact: true }).click();
  if (field) await expect(dialog.locator(field)).toBeVisible();
  return dialog;
}

const openGithubTab = (page: Page) => openTab(page, "GitHub", "#ns-github");
const openGitTab = (page: Page) => openTab(page, "Git repository", "#ns-git");

const popover = (page: Page) => page.locator('[data-slot="popover"]');
const note = (dialog: Locator) => dialog.locator("#ns-github-note");
const gitNote = (dialog: Locator) => dialog.locator("#ns-git-note");

/** A screenshot once popovers and buttons finished their 200ms fade. */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${shots}/${name}.png` });
}

test("browse and pick a GitHub repository, pick another branch, create it connected and deployed", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGithubTab(page);
  await expect(note(dialog)).toHaveText("owner/repo or a GitHub URL, or pick one with Browse.");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await shot(page, "empty-field");

  await dialog.getByRole("button", { name: "Browse" }).click();
  const list = popover(page);
  // By installation, with private or public; git providers are the Source tab's.
  await expect(list.getByText("GitHub · acme")).toBeVisible();
  await expect(list.getByText("GitHub · lee-park")).toBeVisible();
  await expect(list.getByText(/GitLab/)).toHaveCount(0);
  await expect(list.getByRole("option", { name: /acme\/shop-api/ })).toContainText("Private");
  await expect(list.getByRole("option", { name: /acme\/storefront/ })).toContainText("Public");
  await shot(page, "browse");

  await list.getByRole("textbox", { name: "Search repositories" }).fill("store");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option", { name: /acme\/storefront/ })).toBeVisible();
  expect(calls("github.repos").some((input) => input.query === "store")).toBe(true);
  expect(calls("gitProviders.repos")).toEqual([]);

  await list.getByRole("option", { name: /acme\/storefront/ }).click();
  await expect(list).toHaveCount(0);
  await expect(dialog.locator("#ns-github")).toHaveValue("acme/storefront");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  // The repository's default branch, preselected.
  await expect(dialog.locator("#ns-branch")).toHaveValue("trunk");
  await shot(page, "picked-github");

  await dialog.getByRole("button", { name: "Show branches" }).click();
  await expect(popover(page).getByRole("option")).toHaveText(["trunkdefault", "next", "release/2.0"]);
  await shot(page, "branches");
  await popover(page).getByRole("option", { name: "next" }).click();
  await expect(dialog.locator("#ns-branch")).toHaveValue("next");

  // How it builds, before the first deploy: Railpack unless picked (this repository has no Dockerfile).
  const builder = dialog.getByRole("combobox", { name: "Build with" });
  await expect(builder).toHaveText("Railpack");
  await builder.click();
  await page.getByRole("option", { name: "Nixpacks" }).click();
  await expect(builder).toHaveText("Nixpacks");

  await expect(dialog.getByRole("checkbox", { name: "Deploy right away" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  // services.create takes no GitHub source: it is connected through github.connectRepo after, then deployed.
  const [create] = calls("services.create");
  expect(create).toMatchObject({ projectId: ids.acme, name: "web", kind: "app", deployNow: false, ports: [{ containerPort: 80 }] });
  expect(create?.build).toEqual({ builder: "nixpacks" });
  expect(create?.source).toBeUndefined();
  expect(calls("github.connectRepo")).toEqual([
    { serviceId: svc.api, installationId: installation.id, repo: "acme/storefront", branch: "next", deployOnPush: true },
  ]);
  expect(calls("deployments.deploy")).toEqual([{ serviceId: svc.api }]);
  expect(errors).toEqual([]);
});

test("the connected GitHub account is a source: its repositories in Browse, and typed ones the App cannot read", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page, { overrides: withAccount });
  const dialog = await openGithubTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  const list = popover(page);
  await expect(list.getByText("GitHub · acme")).toBeVisible();
  await expect(list.getByText("Connected account · @dana")).toBeVisible();
  await expect(list.getByRole("option", { name: /dana\/notes/ })).toContainText("Private");
  expect(calls("github.repos")).toContainEqual({ projectId: ids.acme, accountId: githubAccount.id, page: "1" });
  await shot(page, "browse-account");
  await list.getByRole("option", { name: /dana\/notes/ }).click();
  await expect(note(dialog)).toHaveText("From the connected GitHub account (@dana) - deploys on push");
  await expect(dialog.locator("#ns-branch")).toHaveValue("main");

  // Typed: acme's installation cannot read legacy-api (NOT_FOUND), the account can.
  await dialog.locator("#ns-github").fill("acme/legacy-api");
  await expect(note(dialog)).toHaveText("From the connected GitHub account (@dana) - deploys on push");
  await expect(dialog.locator("#ns-branch")).toHaveValue("master");
  expect(calls("github.branches")).toContainEqual({ projectId: ids.acme, installationId: installation.id, repo: "acme/legacy-api" });
  expect(calls("github.branches")).toContainEqual({ projectId: ids.acme, accountId: githubAccount.id, repo: "acme/legacy-api" });
  await shot(page, "typed-account");

  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("github.connectRepo")).toEqual([
    { serviceId: svc.api, accountId: githubAccount.id, repo: "acme/legacy-api", branch: "master", deployOnPush: true },
  ]);
  expect(errors).toEqual([]);
});

test("only an account connected (no App): the picker shows, never the setup steps", async ({ page }) => {
  await installDemo(page, {
    overrides: { "github.installations": () => ({ installations: [], installUrl: null, account: githubAccount, hidden: false }) },
  });
  const dialog = await openGithubTab(page);
  await expect(dialog.getByTestId("github-setup")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByText("Connected account · @dana")).toBeVisible();
  await expect(popover(page).getByText("GitHub · acme")).toHaveCount(0);
});

test("typed owner/repo, an SSH URL or a page URL of a repository the installation lists becomes the GitHub App source", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGithubTab(page);
  const field = dialog.locator("#ns-github");

  await field.fill("acme/shop-api");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  await expect(dialog.locator("#ns-branch")).toHaveValue("main");
  await shot(page, "typed-github");

  await field.fill("git@github.com:acme/shop-api.git");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");

  // A GitHub page address: the branch in it wins over the default.
  await field.fill("https://github.com/acme/shop-api/tree/dev");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  await expect(dialog.locator("#ns-branch")).toHaveValue("dev");

  // A folder link in a branch with a slash: the longest start that is a branch, not "feat/queue/src/app".
  await field.fill("https://github.com/acme/shop-api/tree/feat/queue/src/app");
  await expect(dialog.locator("#ns-branch")).toHaveValue("feat/queue");
  await shot(page, "typed-folder-link");

  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("github.connectRepo")).toEqual([
    { serviceId: svc.api, installationId: installation.id, repo: "acme/shop-api", branch: "feat/queue", deployOnPush: true },
  ]);
  // Typed repositories are looked up by name (github.branches), not found in a page of a search.
  expect(calls("github.branches")).toContainEqual({ projectId: ids.acme, installationId: installation.id, repo: "acme/shop-api" });
  expect(calls("deployments.deploy")).toEqual([]);
  expect(errors).toEqual([]);
});

test("typed owner/repo that no installation reads is a public GitHub URL, with its branches from git", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGithubTab(page);
  const field = dialog.locator("#ns-github");

  // The acme installation could hold it, but cannot read it (NOT_FOUND): what happens, and what to do if it is private.
  await field.fill("acme/secret");
  await expect(note(dialog)).toHaveText("Not in your GitHub App (acme) - cloned as public. Private? Give the App access first.");
  await shot(page, "typed-not-in-app");

  await field.fill("vercel/next.js");
  await expect(note(dialog)).toHaveText("Public GitHub repository github.com/vercel/next.js");
  // git.branches reads the URL like git ls-remote; its default branch is preselected.
  await expect(dialog.locator("#ns-branch")).toHaveValue("canary");
  expect(calls("git.branches")).toContainEqual({ projectId: ids.acme, url: "https://github.com/vercel/next.js.git" });
  await dialog.getByRole("button", { name: "Show branches" }).click();
  await expect(popover(page).getByRole("option")).toHaveText(["canarydefault", "main", "next-15-5"]);
  await shot(page, "typed-public");
  await page.keyboard.press("Escape");

  // Another host is the Git repository tab's.
  await field.fill("gitlab.com/acme/site");
  await expect(note(dialog)).toHaveText("Not a GitHub repository. Use the Git repository tab for other hosts.");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();

  await field.fill("vercel/next.js");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  const created = calls("services.create");
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    projectId: ids.acme,
    name: "web",
    kind: "app",
    source: { type: "git", url: "https://github.com/vercel/next.js.git", branch: "canary", credentialId: null, deployOnPush: false },
    deployNow: true,
  });
  expect(calls("github.connectRepo")).toEqual([]);
  expect(errors).toEqual([]);
});

const nothingConnected = {
  "github.installations": () => ({ installations: [], installUrl: null, account: null, hidden: false }),
};

test("nothing connected: three steps and Settings > GitHub, which closes the dialog", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page, { overrides: nothingConnected });
  const dialog = await openTab(page, "GitHub", "");
  const setup = dialog.getByTestId("github-setup");
  await expect(setup).toContainText("Connect GitHub to pick a repository");
  await expect(setup.getByRole("listitem")).toHaveText([
    "1Open Settings > GitHub.",
    "2Create the GitHub App and install it on your account or organization, or connect a GitHub account or paste a token.",
    "3Come back here and pick a repository.",
  ]);
  // No field to fill and nothing to create from this tab yet.
  await expect(dialog.locator("#ns-github")).toHaveCount(0);
  await expect(dialog.locator("#ns-port")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await shot(page, "setup-steps");
  await setup.getByRole("link", { name: "Open Settings > GitHub" }).click();
  await expect(page).toHaveURL(/\/settings\/github$/);
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("nothing connected, as a member: whom to ask, without the Settings link", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page, {
    overrides: {
      "github.installations": () => ({ installations: [], installUrl: null, account: null, hidden: true }),
      "auth.whoami": () => ({ viewer: { ...viewer, role: "member" }, via: "session" }),
    },
  });
  const dialog = await openTab(page, "GitHub", "");
  await expect(dialog.getByTestId("github-setup")).toContainText(/Ask an owner or admin to connect GitHub/);
  await expect(dialog.getByTestId("github-setup").getByRole("link")).toHaveCount(0);
  await shot(page, "setup-member");
  expect(errors).toEqual([]);
});

test("loading shows skeleton rows; an installation the person may not use drops out; a failed list is one calm line", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page, { overrides: withAccount, delay: (op) => (op === "github.repos" ? 1500 : 0) });
  // FORBIDDEN, as the panel answers a member for an installation not shared with the project.
  await refuse(page, "github.repos", 403, "FORBIDDEN", "Only admins can use this GitHub installation in a new project.", (url) =>
    url.searchParams.get("installationId") === "i000000000000002",
  );
  await refuse(page, "github.repos", 503, "UNAVAILABLE", "GitHub answered 503.", (url) => url.searchParams.get("accountId") !== null);
  const dialog = await openGithubTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).locator('[data-slot="skeleton"]').first()).toBeVisible();
  await shot(page, "loading");

  await expect(popover(page).getByRole("option", { name: /acme\/shop-api/ })).toBeVisible();
  await expect(popover(page).locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(popover(page).getByText("GitHub · lee-park")).toHaveCount(0);
  await expect(popover(page).getByText("Could not list repositories. GitHub answered 503.")).toBeVisible();
  await shot(page, "forbidden-and-error");
  expect(errors).toEqual([]);
});

test("a failed branch list says so and keeps the default; a failed connect opens the Source tab", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  await refuse(page, "github.branches", 502, "UNAVAILABLE", "GitHub answered 502.");
  await refuse(page, "github.connectRepo", 400, "BAD_REQUEST", "The App cannot read acme/shop-api at main.");
  const dialog = await openGithubTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await popover(page).getByRole("option", { name: /acme\/shop-api/ }).click();
  await expect(dialog.locator("#ns-branch")).toHaveValue("main");
  await dialog.getByRole("button", { name: "Show branches" }).click();
  await expect(popover(page).getByText("Could not list branches. GitHub answered 502.")).toBeVisible();
  await shot(page, "branches-failed");
  await page.keyboard.press("Escape");

  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("web was created, but connecting acme/shop-api failed. Connect it on the Source tab.")).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}/source$`));
  expect(errors).toEqual([]);
});

test("the branch follows the repository: one picked for another repository does not stick", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGithubTab(page);
  const branch = dialog.locator("#ns-branch");

  await dialog.getByRole("button", { name: "Browse" }).click();
  await popover(page).getByRole("option", { name: /acme\/storefront/ }).click();
  await expect(branch).toHaveValue("trunk");
  await dialog.getByRole("button", { name: "Show branches" }).click();
  await popover(page).getByRole("option", { name: "next" }).click();
  await expect(branch).toHaveValue("next");

  // Another repository: its own default, not storefront's "next" (shop-api has no such branch).
  await dialog.getByRole("button", { name: "Browse" }).click();
  await popover(page).getByRole("option", { name: /acme\/shop-api/ }).click();
  await expect(branch).toHaveValue("main");

  // A branch typed for this repository stays while it is the same repository, however it is written.
  await branch.fill("feat/queue");
  await dialog.locator("#ns-github").fill("https://github.com/acme/shop-api.git");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  await expect(branch).toHaveValue("feat/queue");
  await shot(page, "branch-follows-repo");

  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("github.connectRepo")).toEqual([
    { serviceId: svc.api, installationId: installation.id, repo: "acme/shop-api", branch: "feat/queue", deployOnPush: true },
  ]);
  expect(errors).toEqual([]);
});

test("an empty branch is the suggested one; a branch git refuses says so and blocks Create", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGithubTab(page);
  const branch = dialog.locator("#ns-branch");
  const create = dialog.getByRole("button", { name: "Create", exact: true });

  await dialog.locator("#ns-github").fill("acme/storefront");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  await expect(branch).toHaveValue("trunk");

  await branch.fill("my branch");
  await expect(branch).toHaveAttribute("aria-invalid", "true");
  await expect(dialog.getByText("No spaces or ~ ^ : ? * [ \\ in a branch name.")).toBeVisible();
  await expect(create).toBeDisabled();
  await shot(page, "branch-invalid");

  // Cleared: the placeholder shows what it stands for, and Create uses it.
  await branch.fill("");
  await expect(branch).toHaveAttribute("placeholder", "trunk");
  await expect(branch).toHaveAttribute("aria-invalid", "false");
  await expect(create).toBeEnabled();
  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await create.click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("github.connectRepo")[0]).toMatchObject({ repo: "acme/storefront", branch: "trunk" });
  expect(errors).toEqual([]);
});

test("a folder link names the branch it starts with, or none: then the default branch", async ({ page }) => {
  await installDemo(page);
  const dialog = await openGithubTab(page);
  // storefront has trunk, next and release/2.0: "main" is no branch of it.
  await dialog.locator("#ns-github").fill("https://github.com/acme/storefront/tree/main/apps/web");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  await expect(dialog.locator("#ns-branch")).toHaveValue("trunk");
  await dialog.locator("#ns-github").fill("https://github.com/acme/storefront/tree/release/2.0/docs");
  await expect(dialog.locator("#ns-branch")).toHaveValue("release/2.0");
});

test("a token in the URL: the line says to take it out", async ({ page }) => {
  await installDemo(page);
  const dialog = await openGithubTab(page);
  await dialog.locator("#ns-github").fill("https://user:token@github.com/acme/x.git");
  await expect(note(dialog)).toHaveText("Remove the token from the URL - add it as a git credential on the Source tab after creating.");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await shot(page, "credentials");
});

test("a connection that does not answer leaves the field unchecked with Try again, never a public URL", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  let down = true;
  await page.route(/\/api\/v1\/github\.branches/, (route) => {
    const repo = new URL(route.request().url()).searchParams.get("repo");
    if (!down || repo !== "acme/shop-api") return route.fallback();
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "UNAVAILABLE", message: "GitHub answered 502: Server Error", details: { field: "repo" } } }),
    });
  });
  const dialog = await openGithubTab(page);
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  await dialog.locator("#ns-github").fill("acme/shop-api");
  await expect(note(dialog)).toHaveText("Could not check your GitHub App (acme). GitHub answered 502: Server Error Try again");
  await expect(create).toBeDisabled();
  await shot(page, "lookup-failed");

  down = false;
  await note(dialog).getByRole("button", { name: "Try again" }).click();
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  await expect(create).toBeEnabled();
  expect(errors).toEqual([]);
});

test("the GitHub list failing: Browse and the line say so, and a typed repository waits; never the setup steps", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  await refuse(page, "github.installations", 503, "UNAVAILABLE", "The panel is restarting.");
  const dialog = await openGithubTab(page);
  await expect(dialog.getByTestId("github-setup")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByText("Could not load your GitHub connections. The panel is restarting.")).toBeVisible();
  await shot(page, "installations-failed");
  await page.keyboard.press("Escape");

  await dialog.locator("#ns-github").fill("acme/private");
  await expect(note(dialog)).toHaveText("Could not load your GitHub connections. The panel is restarting. Try again");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("a repository picked in one project is looked up again when the project changes", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  // In "personal" the installation is not shared: the panel refuses it there, as for a member.
  await refuse(page, "github.branches", 403, "FORBIDDEN", "Only admins can use this GitHub installation in a new project.", (url) =>
    url.searchParams.get("projectId") === ids.personal,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New service", exact: true }).first().click();
  await page.getByRole("menuitem").filter({ hasText: "GitHub, Git, Docker image" }).click();
  const dialog = page.getByRole("dialog", { name: "New app" });
  await dialog.getByLabel("Name", { exact: true }).fill("web");
  await dialog.getByRole("radio", { name: "GitHub", exact: true }).click();
  await expect(dialog.locator("#ns-project")).toContainText("acme-shop");
  await dialog.getByRole("button", { name: "Browse" }).click();
  await popover(page).getByRole("option", { name: /acme\/shop-api/ }).click();
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");

  await dialog.locator("#ns-project").click();
  await page.getByRole("option", { name: "personal" }).click();
  await expect(note(dialog)).toHaveText("Public GitHub repository github.com/acme/shop-api");
  await shot(page, "project-changed");
  expect(errors).toEqual([]);
});

test("a member who may create but not change services gets plain git URLs, and Browse says why", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  const grant = {
    id: "grant00000000001",
    userId: viewer.id,
    scopeType: "project",
    scopeId: ids.acme,
    scopeName: "acme-shop",
    projectId: null,
    actions: ["services.create", "services.deploy"],
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await installDemo(page, {
    overrides: {
      "auth.whoami": () => ({ viewer: { ...viewer, role: "member" }, via: "session" }),
      "grants.mine": () => ({ grants: [grant] }),
    },
  });
  const dialog = await openGithubTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByText(/Connecting a repository needs the right to change services in this project/)).toBeVisible();
  await expect(popover(page).getByRole("option")).toHaveCount(0);
  await shot(page, "member-cannot-connect");
  await page.keyboard.press("Escape");

  await dialog.locator("#ns-github").fill("acme/shop-api");
  await expect(note(dialog)).toHaveText("Public GitHub repository github.com/acme/shop-api");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("services.create")[0]?.source).toMatchObject({ type: "git", url: "https://github.com/acme/shop-api.git" });
  expect(calls("github.connectRepo")).toEqual([]);
  expect(calls("github.branches")).toEqual([]);
  expect(errors).toEqual([]);
});

test("the Git repository tab is a plain URL field: no Browse, no owner/repo, nothing looked up", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page, { overrides: withAccount });
  const dialog = await openGitTab(page);
  const field = dialog.locator("#ns-git");
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  await expect(dialog.getByRole("button", { name: "Browse" })).toHaveCount(0);
  await expect(gitNote(dialog)).toHaveText("An https or SSH address, or a host and path like gitlab.com/team/app.");
  await shot(page, "git-tab");

  await field.fill("acme/shop-api");
  await expect(gitNote(dialog)).toHaveText("Type the full address, for example github.com/acme/shop-api. GitHub repositories also have the GitHub tab.");
  await expect(create).toBeDisabled();

  await field.fill("http://git.example.com/team/app.git");
  await expect(gitNote(dialog)).toHaveText("Use https:// - the panel does not clone over plain http.");
  await expect(create).toBeDisabled();

  // github.com: cloned as public, with a pointer to the GitHub tab; never looked up in the App or the account.
  await field.fill("github.com/acme/shop-api");
  await expect(gitNote(dialog)).toHaveText("Public GitHub repository github.com/acme/shop-api. Private? Use the GitHub tab.");
  // A provider's host is a plain URL here too: provider repositories are picked on the Source tab.
  await field.fill("https://gitlab.com/acme/site.git");
  await expect(gitNote(dialog)).toHaveText("Public git repository gitlab.com/acme/site");

  await field.fill("https://git.example.com/team/app.git");
  await expect(gitNote(dialog)).toHaveText("Public git repository git.example.com/team/app");
  await expect(dialog.locator("#ns-git-branch")).toHaveValue("main");
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("services.create")[0]?.source).toEqual({
    type: "git",
    url: "https://git.example.com/team/app.git",
    branch: "main",
    credentialId: null,
    deployOnPush: false,
  });
  expect(calls("github.branches")).toEqual([]);
  expect(calls("gitProviders.branches")).toEqual([]);
  expect(calls("github.connectRepo")).toEqual([]);
  expect(errors).toEqual([]);
});

test("an SSH URL creates without the first deploy, which could only fail before the deploy key", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGitTab(page);
  const deploy = dialog.getByRole("checkbox", { name: "Deploy right away" });
  await expect(deploy).toBeChecked();
  await dialog.locator("#ns-git").fill("git@git.example.com:someone/thing.git");
  await expect(gitNote(dialog)).toHaveText("Cloned over SSH from git.example.com: add a deploy key on the Source tab, then deploy.");
  await expect(deploy).toBeDisabled();
  await expect(deploy).not.toBeChecked();
  await shot(page, "ssh");

  // Back to an https URL, the box is ticked again as it was.
  await dialog.locator("#ns-git").fill("https://git.example.com/someone/thing.git");
  await expect(deploy).toBeChecked();
  await dialog.locator("#ns-git").fill("git@git.example.com:someone/thing.git");
  await expect(deploy).not.toBeChecked();

  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("services.create")[0]).toMatchObject({
    source: { type: "git", url: "git@git.example.com:someone/thing.git", credentialId: null },
    deployNow: false,
  });
});

/** github.repos for the acme installation with `count` repositories, paged like the panel. */
const manyRepos = (count: number) => ({
  "github.repos": (input: Input) => {
    const all =
      input.installationId === installation.id
        ? Array.from({ length: count }, (_, i) => ({
            fullName: `acme/service-${String(i + 1).padStart(2, "0")}`,
            private: i % 3 !== 0,
            defaultBranch: "main",
            pushedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
          }))
        : [];
    const at = Number(input.page ?? 1);
    return { repos: all.slice((at - 1) * 30, at * 30), hasMore: all.length > at * 30 };
  },
  "github.branches": () => ({ branches: ["main", "dev"], defaultBranch: "main" }),
});

test("arrow keys move through the repository and branch lists; Show more keeps the keyboard's place", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page, { overrides: manyRepos(45), delay: (op) => (op === "github.repos" ? 800 : 0) });
  const dialog = await openGithubTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  const list = popover(page);
  const search = list.getByRole("textbox", { name: "Search repositories" });
  await expect(list.getByRole("option", { name: /acme\/service-01/ })).toBeVisible();
  await expect(search).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { name: /acme\/service-01/ })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { name: /acme\/service-02/ })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(list.getByRole("option", { name: /acme\/service-01/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();

  // Down from the 30th row reaches acme's Show more.
  await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
  const more = list.locator(`[data-more="${installation.id}"]`);
  await expect(more).toBeFocused();
  await shot(page, "show-more-focused");
  await page.keyboard.press("Enter");
  // While the page loads the button stays and keeps the focus, then the first new row has it.
  await expect(more).toHaveAttribute("aria-disabled", "true");
  await expect(more).toBeFocused();
  await expect(list.getByRole("option", { name: /acme\/service-31/ })).toBeFocused();
  await page.keyboard.press("End");
  await expect(list.getByRole("option").last()).toBeFocused();
  await expect(list.getByRole("option").last()).toContainText("acme/service-45");
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(dialog.locator("#ns-branch")).toHaveValue("main");

  // The branch list: Down moves from the first branch to the next.
  await dialog.getByRole("button", { name: "Show branches" }).click();
  await expect(popover(page).getByRole("option").first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(popover(page).getByRole("option").nth(1)).toBeFocused();
  expect(errors).toEqual([]);
});

test("the Browse list fits short windows and phones: inside the window, as wide as the field on a phone", async ({ page }) => {
  await installDemo(page, { overrides: manyRepos(12) });
  await page.setViewportSize({ width: 1280, height: 640 });
  const dialog = await openGithubTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  const list = popover(page);
  await expect(list.getByRole("option", { name: /acme\/service-12/ })).toBeAttached();
  await page.waitForTimeout(350);
  const box = await list.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(640 - 16 + 1);
  // The last row can be scrolled to.
  await list.getByRole("option", { name: /acme\/service-12/ }).scrollIntoViewIfNeeded();
  await expect(list.getByRole("option", { name: /acme\/service-12/ })).toBeInViewport();
  await shot(page, "short-window-browse");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await openGithubTab(page);
  await phone.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByRole("option").first()).toBeVisible();
  await page.waitForTimeout(350);
  const field = await phone.locator("#ns-github").boundingBox();
  const pop = await popover(page).boundingBox();
  expect(field).not.toBeNull();
  expect(pop).not.toBeNull();
  expect(Math.abs((pop?.x ?? 0) - (field?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((pop?.width ?? 0) - (field?.width ?? 0))).toBeLessThanOrEqual(1);
  expect((pop?.x ?? 0) + (pop?.width ?? 0)).toBeLessThanOrEqual(390 - 16 + 1);
  await shot(page, "phone-browse");
});

test("a repository with a Dockerfile at its root starts on the Dockerfile builder, with its path", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGithubTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await popover(page).getByRole("option", { name: /acme\/shop-api/ }).click();
  const builder = dialog.getByRole("combobox", { name: "Build with" });
  await expect(builder).toHaveText("Dockerfile");
  await expect(dialog.getByText("The repository has a Dockerfile, so Dockerfile is picked.")).toBeVisible();
  await dialog.getByLabel("Dockerfile path").fill("docker/web.Dockerfile");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect.poll(() => calls("services.create").length).toBe(1);
  expect(calls("services.create")[0]?.build).toEqual({ builder: "dockerfile", dockerfilePath: "docker/web.Dockerfile" });
});

/** acme's installation with 20 repositories, the service's acme/shop-api 15th (out of view in the list), searched by name. */
const longList = {
  "github.repos": (input: Input) => {
    const names = Array.from({ length: 20 }, (_, i) =>
      i === 14 ? "acme/shop-api" : i === 16 ? "acme/storefront" : i === 18 ? "acme/docs" : `acme/service-${String(i + 1).padStart(2, "0")}`,
    );
    const query = String(input.query ?? "").toLowerCase();
    const repos = (input.installationId === installation.id ? names : [])
      .filter((name) => !query || name.includes(query))
      .map((fullName, i) => ({
        fullName,
        private: true,
        defaultBranch: fullName === "acme/storefront" ? "trunk" : "main",
        pushedAt: new Date(Date.now() - i * 3_600_000).toISOString(),
      }));
    return { repos, hasMore: false };
  },
};

test("the Source tab's GitHub picker opens on the service's repository, selected and in view; one key starts a new search", async ({
  page,
}) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page, { overrides: longList });
  // The api service is connected to acme/shop-api at main through acme's installation (demo/service.ts).
  await page.goto(`/p/${ids.acme}/s/${svc.api}/source`);
  const search = page.getByRole("textbox", { name: "Search repositories" });
  const list = page.getByRole("listbox", { name: "Repository" });
  const current = list.getByRole("option", { name: /acme\/shop-api/ });
  await expect(search).toHaveValue("acme/shop-api");
  // Not a search: the whole list, the service's repository selected and scrolled to inside it (the page stays put).
  await expect(list.getByRole("option")).toHaveCount(20);
  await expect(current).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // The list on screen (that scrolls the page, not the list): the row shows in it.
  await list.scrollIntoViewIfNeeded();
  await expect(current).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole("combobox", { name: "Branch" })).toContainText("main");
  // Opening it changed nothing: Connected, nothing looked up by name, no search sent.
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeDisabled();
  await expect(list.getByText("Use this repository")).toHaveCount(0);
  expect(calls("github.repos").every((input) => input.query === undefined)).toBe(true);
  await shot(page, "source-tab-opens-on-repo");

  // Enter on the text it opened with picks nothing (the branch stays).
  await search.press("Enter");
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeDisabled();
  await search.blur();

  // A click into it selects the text, so the first key replaces it with a new search.
  await search.click();
  expect(await search.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, "acme/shop-api".length]);
  await page.keyboard.type("store");
  await expect(search).toHaveValue("store");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option", { name: /acme\/storefront/ })).toBeVisible();
  expect(calls("github.repos").some((input) => input.query === "store")).toBe(true);

  // Cleared, the whole list again with the service's repository still picked; picking another changes the form only.
  await search.fill("");
  await expect(list.getByRole("option")).toHaveCount(20);
  await expect(current).toHaveAttribute("aria-selected", "true");
  await list.getByRole("option", { name: /acme\/storefront/ }).click();
  await expect(page.getByRole("combobox", { name: "Branch" })).toContainText("trunk");
  await expect(page.getByRole("button", { name: "Connect repository" })).toBeEnabled();
  await expect(search).toHaveValue("");
  expect(calls("github.connectRepo")).toEqual([]);
  expect(errors).toEqual([]);
});

test("the Source tab's GitLab picker opens on the service's repository too, and Tab into it selects the text", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page, {
    overrides: {
      "services.get": (input: Input) => ({
        ...(serviceHandlers["services.get"]?.(input) as object),
        source: { type: "gitlab", label: "acme/platform/shop", branch: "main", builder: "railpack" },
        sourceConfig: {
          type: "provider",
          providerId: gitlabConnection.id,
          provider: "gitlab",
          repo: "acme/platform/shop",
          branch: "main",
          deployOnPush: true,
        },
      }),
      "gitProviders.webhook": () => ({
        configured: true,
        kind: "gitlab",
        repo: "acme/platform/shop",
        url: "https://panel.example.com/api/hooks/gitlab/hk00000000000001",
        created: true,
        error: null,
        insecure: false,
        lastDeliveryAt: null,
        createdAt: new Date().toISOString(),
      }),
    },
  });
  await page.goto(`/p/${ids.acme}/s/${svc.api}/source`);
  await expect(page.getByRole("radio", { name: /GitLab/ })).toHaveAttribute("aria-checked", "true");
  const search = page.getByRole("textbox", { name: "Search repositories" });
  const list = page.getByRole("listbox", { name: "Repository" });
  await expect(search).toHaveValue("acme/platform/shop");
  // GitLab searches names, not full paths: the text it opens with is no search, so both repositories show.
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(list.getByRole("option", { name: /acme\/platform\/shop/ })).toHaveAttribute("aria-selected", "true");
  await expect(list.getByRole("option", { name: /acme\/site/ })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("combobox", { name: "Branch" })).toHaveText("main");
  await expect(page.getByRole("button", { name: "Connected", exact: true })).toBeDisabled();
  expect(calls("gitProviders.repos").every((input) => input.query === undefined)).toBe(true);
  await shot(page, "source-tab-gitlab-opens-on-repo");

  // From the Connection field, Tab reaches the search box with its text selected.
  await page.getByRole("combobox", { name: "Connection" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  await expect(search).toBeFocused();
  expect(await search.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, "acme/platform/shop".length]);
  await page.keyboard.type("site");
  await expect(search).toHaveValue("site");
  await expect(list.getByRole("option")).toHaveCount(1);
  expect(calls("gitProviders.repos").some((input) => input.query === "site")).toBe(true);
  expect(calls("gitProviders.connectRepo")).toEqual([]);
  expect(errors).toEqual([]);
});

test("a service without a repository source, and a new one, open the picker empty", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  // private-api deploys from a plain git URL: its GitHub picker has nothing to open on.
  await page.goto(`/p/${ids.acme}/s/${svc.privateApi}/source`);
  await page.getByRole("radio", { name: /^GitHub/ }).click();
  const list = page.getByRole("listbox", { name: "Repository" });
  await expect(list.getByRole("option", { name: /acme\/shop-api/ })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Search repositories" })).toHaveValue("");
  await expect(list.locator('[aria-selected="true"]')).toHaveCount(0);

  const dialog = await openGithubTab(page);
  await expect(dialog.locator("#ns-github")).toHaveValue("");
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByRole("option", { name: /acme\/shop-api/ })).toBeVisible();
  await expect(popover(page).getByRole("textbox", { name: "Search repositories" })).toHaveValue("");
  expect(errors).toEqual([]);
});

