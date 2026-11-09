// The New app dialog's Git repository tab on the demo data (demo/repos.ts):
// browsing and picking a repository of the GitHub App or a git provider,
// typing owner/repo that an installation reads (a GitHub App source) or
// cannot (a public GitHub URL), pasting URLs and page addresses, the branch
// suggestions with the default preselected and the branch following the
// repository, the empty, loading, error and unchecked states, a project
// change, a member who may not connect, the list's size at a short window
// and on a phone, and the keyboard. The ops are answered by the demo and
// recorded, so the test checks what gets created.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids, viewer } from "./demo/fixtures";
import { DemoRefusal } from "./demo/refusal";
import { gitlabConnection, installation } from "./demo/repos";
import { installDemo } from "./demo/routes";
import { ids as svc } from "./demo/service";
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

/** Opens New service > App on the acme project, names it web and switches to Git repository. */
async function openGitTab(page: Page): Promise<Locator> {
  mkdirSync(shots, { recursive: true });
  await page.goto(`/p/${ids.acme}`);
  await page.getByRole("button", { name: "New service" }).click();
  await page.getByRole("menuitem").filter({ hasText: "GitHub, Git, Docker image" }).click();
  const dialog = page.getByRole("dialog", { name: "New app" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name", { exact: true }).fill("web");
  await dialog.getByRole("radio", { name: "Git repository" }).click();
  await expect(dialog.locator("#ns-git")).toBeVisible();
  return dialog;
}

const popover = (page: Page) => page.locator('[data-slot="popover"]');
const note = (dialog: Locator) => dialog.locator("#ns-git-note");

/** A screenshot once popovers and buttons finished their 200ms fade. */
async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${shots}/${name}.png` });
}

test("browse and pick a GitHub repository, pick another branch, create it connected and deployed", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGitTab(page);
  await expect(note(dialog)).toHaveText("A git URL, owner/repo for GitHub, or pick one with Browse.");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  await shot(page, "empty-field");

  await dialog.getByRole("button", { name: "Browse" }).click();
  const list = popover(page);
  // By connection: both GitHub App installations and the GitLab connection, with private or public.
  await expect(list.getByText("GitHub · acme")).toBeVisible();
  await expect(list.getByText("GitHub · lee-park")).toBeVisible();
  await expect(list.getByText("GitLab · Company GitLab")).toBeVisible();
  await expect(list.getByRole("option", { name: /acme\/shop-api/ })).toContainText("Private");
  await expect(list.getByRole("option", { name: /acme\/storefront/ })).toContainText("Public");
  await expect(list.getByRole("option", { name: /acme\/platform\/shop/ })).toBeVisible();
  await shot(page, "browse");

  // The search goes to every connection.
  await list.getByRole("textbox", { name: "Search repositories" }).fill("store");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option", { name: /acme\/storefront/ })).toBeVisible();
  expect(calls("github.repos").some((input) => input.query === "store")).toBe(true);
  expect(calls("gitProviders.repos").some((input) => input.query === "store")).toBe(true);

  await list.getByRole("option", { name: /acme\/storefront/ }).click();
  await expect(list).toHaveCount(0);
  await expect(dialog.locator("#ns-git")).toHaveValue("acme/storefront");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  // The repository's default branch, preselected.
  await expect(dialog.locator("#ns-branch")).toHaveValue("trunk");
  await shot(page, "picked-github");

  await dialog.getByRole("button", { name: "Show branches" }).click();
  await expect(popover(page).getByRole("option")).toHaveText(["trunkdefault", "next", "release/2.0"]);
  await shot(page, "branches");
  await popover(page).getByRole("option", { name: "next" }).click();
  await expect(dialog.locator("#ns-branch")).toHaveValue("next");

  await expect(dialog.getByRole("checkbox", { name: "Deploy right away" })).toBeChecked();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  // services.create takes no GitHub source: it is connected through github.connectRepo after, then deployed.
  const [create] = calls("services.create");
  expect(create).toMatchObject({ projectId: ids.acme, name: "web", kind: "app", deployNow: false });
  expect(create?.source).toBeUndefined();
  expect(calls("github.connectRepo")).toEqual([
    { serviceId: svc.api, installationId: installation.id, repo: "acme/storefront", branch: "next", deployOnPush: true },
  ]);
  expect(calls("deployments.deploy")).toEqual([{ serviceId: svc.api }]);
  expect(errors).toEqual([]);
});

test("typed owner/repo, an SSH URL or a page URL of a repository the installation lists becomes the GitHub App source", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGitTab(page);
  const field = dialog.locator("#ns-git");

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
  const dialog = await openGitTab(page);
  const field = dialog.locator("#ns-git");

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

test("pasted URLs: a GitLab one the connection lists, any other host as written, and plain http refused", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGitTab(page);
  const field = dialog.locator("#ns-git");
  const create = dialog.getByRole("button", { name: "Create", exact: true });

  await field.fill("http://git.example.com/team/app.git");
  await expect(note(dialog)).toHaveText("Use https:// - the panel does not clone over plain http.");
  await expect(create).toBeDisabled();

  await field.fill("group/sub/repo");
  await expect(note(dialog)).toHaveText("Add the host, for example gitlab.com/group/sub/repo.");
  await expect(create).toBeDisabled();

  await field.fill("https://git.example.com/team/app.git");
  await expect(note(dialog)).toHaveText("Public git repository git.example.com/team/app");
  await expect(create).toBeEnabled();

  await field.fill("https://gitlab.com/acme/site.git");
  await expect(note(dialog)).toHaveText("From Company GitLab (GitLab) - deploys on push");
  await expect(dialog.locator("#ns-branch")).toHaveValue("trunk");
  await shot(page, "pasted-gitlab");

  await create.click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("gitProviders.connectRepo")).toEqual([
    { serviceId: svc.api, providerId: gitlabConnection.id, repo: "acme/site", branch: "trunk", deployOnPush: true },
  ]);
  expect(calls("services.create")[0]?.source).toBeUndefined();
  expect(errors).toEqual([]);
});

test("a pasted URL of another host is created as written", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGitTab(page);
  await dialog.locator("#ns-git").fill("https://git.example.com/team/app.git");
  await expect(dialog.locator("#ns-branch")).toHaveValue("main");
  await shot(page, "pasted-url");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("services.create")[0]?.source).toEqual({
    type: "git",
    url: "https://git.example.com/team/app.git",
    branch: "main",
    credentialId: null,
    deployOnPush: false,
  });
});

const nothingConnected = {
  "github.installations": () => ({ installations: [], installUrl: null, hidden: false }),
  "gitProviders.list": () => ({ items: [], hidden: false }),
};

test("nothing connected: the list says so with the Settings links, and typing still works", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page, { overrides: nothingConnected });
  const dialog = await openGitTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByText("No GitHub App or git provider connected")).toBeVisible();
  await expect(popover(page).getByRole("link", { name: "Set up GitHub" })).toHaveAttribute("href", "/settings/github");
  await expect(popover(page).getByRole("link", { name: "Add a git provider" })).toHaveAttribute("href", "/settings/git-providers");
  await shot(page, "empty-state");
  await page.keyboard.press("Escape");
  // Typing still works: owner/repo is a public GitHub repository.
  await dialog.locator("#ns-git").fill("acme/shop-api");
  await expect(note(dialog)).toHaveText("Public GitHub repository github.com/acme/shop-api");
  expect(errors).toEqual([]);
});

test("nothing connected, as a member: the list says whom to ask, without Settings links", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page, {
    overrides: { ...nothingConnected, "auth.whoami": () => ({ viewer: { ...viewer, role: "member" }, via: "session" }) },
  });
  const dialog = await openGitTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByText(/Ask an owner or admin to connect GitHub or a git provider/)).toBeVisible();
  await expect(popover(page).getByRole("link")).toHaveCount(0);
  await shot(page, "empty-state-member");
  expect(errors).toEqual([]);
});

test("loading shows skeleton rows; a connection the person may not use drops out; a failed list is one calm line", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page, { delay: (op) => (op === "github.repos" || op === "gitProviders.repos" ? 1500 : 0) });
  // FORBIDDEN, as the panel answers a member for an installation not shared with the project.
  await refuse(page, "github.repos", 403, "FORBIDDEN", "Only admins can use this GitHub installation in a new project.", (url) =>
    url.searchParams.get("installationId") === "i000000000000002",
  );
  await refuse(page, "gitProviders.repos", 503, "UNAVAILABLE", "GitLab answered 503.");
  const dialog = await openGitTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).locator('[data-slot="skeleton"]').first()).toBeVisible();
  await shot(page, "loading");

  await expect(popover(page).getByRole("option", { name: /acme\/shop-api/ })).toBeVisible();
  await expect(popover(page).locator('[data-slot="skeleton"]')).toHaveCount(0);
  await expect(popover(page).getByText("GitHub · lee-park")).toHaveCount(0);
  await expect(popover(page).getByText("Could not list repositories. GitLab answered 503.")).toBeVisible();
  await shot(page, "forbidden-and-error");
  expect(errors).toEqual([]);
});

test("a failed branch list says so and keeps the default; a failed connect opens the Source tab", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  await refuse(page, "github.branches", 502, "UNAVAILABLE", "GitHub answered 502.");
  await refuse(page, "github.connectRepo", 400, "BAD_REQUEST", "The App cannot read acme/shop-api at main.");
  const dialog = await openGitTab(page);
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
  const dialog = await openGitTab(page);
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
  await dialog.locator("#ns-git").fill("https://gitlab.com/acme/platform/shop.git");
  await expect(note(dialog)).toHaveText("From Company GitLab (GitLab) - deploys on push");
  await expect(branch).toHaveValue("main");

  // A branch typed for this repository stays while it is the same repository, however it is written.
  await branch.fill("feat/checkout");
  await dialog.locator("#ns-git").fill("gitlab.com/acme/platform/shop");
  await expect(note(dialog)).toHaveText("From Company GitLab (GitLab) - deploys on push");
  await expect(branch).toHaveValue("feat/checkout");
  await shot(page, "branch-follows-repo");

  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("gitProviders.connectRepo")).toEqual([
    { serviceId: svc.api, providerId: gitlabConnection.id, repo: "acme/platform/shop", branch: "feat/checkout", deployOnPush: true },
  ]);
  expect(errors).toEqual([]);
});

test("an empty branch is the suggested one; a branch git refuses says so and blocks Create", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGitTab(page);
  const branch = dialog.locator("#ns-branch");
  const create = dialog.getByRole("button", { name: "Create", exact: true });

  await dialog.locator("#ns-git").fill("acme/storefront");
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
  const dialog = await openGitTab(page);
  // storefront has trunk, next and release/2.0: "main" is no branch of it.
  await dialog.locator("#ns-git").fill("https://github.com/acme/storefront/tree/main/apps/web");
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  await expect(dialog.locator("#ns-branch")).toHaveValue("trunk");
  await dialog.locator("#ns-git").fill("https://github.com/acme/storefront/tree/release/2.0/docs");
  await expect(dialog.locator("#ns-branch")).toHaveValue("release/2.0");
});

test("an SSH URL creates without the first deploy, which could only fail before the deploy key", async ({ page }) => {
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGitTab(page);
  const deploy = dialog.getByRole("checkbox", { name: "Deploy right away" });
  await expect(deploy).toBeChecked();
  await dialog.locator("#ns-git").fill("git@github.com:someone/thing.git");
  await expect(note(dialog)).toHaveText("Cloned over SSH from github.com: add a deploy key on the Source tab, then deploy.");
  await expect(deploy).toBeDisabled();
  await expect(deploy).not.toBeChecked();
  await shot(page, "ssh");

  // Back to an https URL, the box is ticked again as it was.
  await dialog.locator("#ns-git").fill("https://github.com/someone/thing.git");
  await expect(deploy).toBeChecked();
  await dialog.locator("#ns-git").fill("git@github.com:someone/thing.git");
  await expect(deploy).not.toBeChecked();

  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("services.create")[0]).toMatchObject({
    source: { type: "git", url: "git@github.com:someone/thing.git", credentialId: null },
    deployNow: false,
  });
});

test("a token in the URL: the line says to take it out", async ({ page }) => {
  await installDemo(page);
  const dialog = await openGitTab(page);
  await dialog.locator("#ns-git").fill("https://user:token@github.com/acme/x.git");
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
  const dialog = await openGitTab(page);
  const create = dialog.getByRole("button", { name: "Create", exact: true });
  await dialog.locator("#ns-git").fill("acme/shop-api");
  await expect(note(dialog)).toHaveText("Could not check your GitHub App (acme). GitHub answered 502: Server Error Try again");
  await expect(create).toBeDisabled();
  await shot(page, "lookup-failed");

  down = false;
  await note(dialog).getByRole("button", { name: "Try again" }).click();
  await expect(note(dialog)).toHaveText("From your GitHub App (acme) - deploys on push");
  await expect(create).toBeEnabled();
  expect(errors).toEqual([]);
});

test("only the installations failing: Browse says so beside GitLab, and a github.com repository waits", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  await refuse(page, "github.installations", 503, "UNAVAILABLE", "The panel is restarting.");
  const dialog = await openGitTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByText("Could not load your GitHub App installations. The panel is restarting.")).toBeVisible();
  await expect(popover(page).getByText("GitLab · Company GitLab")).toBeVisible();
  await expect(popover(page).getByText("No GitHub App or git provider connected")).toHaveCount(0);
  await shot(page, "installations-failed");
  await page.keyboard.press("Escape");

  await dialog.locator("#ns-git").fill("acme/private");
  await expect(note(dialog)).toHaveText("Could not load your GitHub App installations. The panel is restarting. Try again");
  await expect(dialog.getByRole("button", { name: "Create", exact: true })).toBeDisabled();
  // A GitLab repository does not depend on that list.
  await dialog.locator("#ns-git").fill("gitlab.com/acme/site");
  await expect(note(dialog)).toHaveText("From Company GitLab (GitLab) - deploys on push");
  expect(errors).toEqual([]);
});

test("a page address of a self-managed GitLab connection is read as its repository", async ({ page }) => {
  const calls = watchOps(page);
  const own = { ...gitlabConnection, id: "gp0000000000000b", name: "Self GitLab", url: "https://gitlab.example.com", host: "gitlab.example.com" };
  await installDemo(page, {
    overrides: {
      "gitProviders.list": () => ({ items: [gitlabConnection, own], hidden: false }),
      "gitProviders.branches": (input) => {
        if (input.providerId === own.id && input.repo === "group/sub/app") return { branches: ["main", "dev"], defaultBranch: "main" };
        throw new DemoRefusal(404, "NOT_FOUND", "No such repository.", { field: "repo" });
      },
    },
  });
  const dialog = await openGitTab(page);
  await dialog.locator("#ns-git").fill("https://gitlab.example.com/group/sub/app/-/tree/dev/src");
  await expect(note(dialog)).toHaveText("From Self GitLab (GitLab) - deploys on push");
  await expect(dialog.locator("#ns-branch")).toHaveValue("dev");
  expect(calls("gitProviders.branches")).toContainEqual({ projectId: ids.acme, providerId: own.id, repo: "group/sub/app" });
  await shot(page, "self-managed-gitlab");
  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("gitProviders.connectRepo")).toEqual([
    { serviceId: svc.api, providerId: own.id, repo: "group/sub/app", branch: "dev", deployOnPush: true },
  ]);
});

test("a repository picked in one project is looked up again when the project changes", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page);
  // In "personal" the installation is not shared: the panel refuses it there, as for a member.
  await refuse(page, "github.branches", 403, "FORBIDDEN", "Only admins can use this GitHub installation in a new project.", (url) =>
    url.searchParams.get("projectId") === ids.personal,
  );
  await page.goto("/");
  await page.getByRole("button", { name: "New service" }).first().click();
  await page.getByRole("menuitem").filter({ hasText: "GitHub, Git, Docker image" }).click();
  const dialog = page.getByRole("dialog", { name: "New app" });
  await dialog.getByLabel("Name", { exact: true }).fill("web");
  await dialog.getByRole("radio", { name: "Git repository" }).click();
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
  const dialog = await openGitTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByText(/Connecting a repository needs the right to change services in this project/)).toBeVisible();
  await expect(popover(page).getByRole("option")).toHaveCount(0);
  await shot(page, "member-cannot-connect");
  await page.keyboard.press("Escape");

  await dialog.locator("#ns-git").fill("acme/shop-api");
  await expect(note(dialog)).toHaveText("Public GitHub repository github.com/acme/shop-api");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("services.create")[0]?.source).toMatchObject({ type: "git", url: "https://github.com/acme/shop-api.git" });
  expect(calls("github.connectRepo")).toEqual([]);
  expect(calls("github.branches")).toEqual([]);
  expect(errors).toEqual([]);
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
});

test("arrow keys move through the repository and branch lists; Show more keeps the keyboard's place", async ({ page }) => {
  const errors = trackErrors(page);
  await installDemo(page, { overrides: manyRepos(45), delay: (op) => (op === "github.repos" ? 800 : 0) });
  const dialog = await openGitTab(page);
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
  await expect(list.getByRole("option").last()).toContainText("acme/site");
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  await expect(dialog.locator("#ns-branch")).toHaveValue("trunk");

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
  const dialog = await openGitTab(page);
  await dialog.getByRole("button", { name: "Browse" }).click();
  const list = popover(page);
  await expect(list.getByRole("option", { name: /acme\/site/ })).toBeAttached();
  await page.waitForTimeout(350);
  const box = await list.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(640 - 16 + 1);
  // The last group can be scrolled to.
  await list.getByRole("option", { name: /acme\/site/ }).scrollIntoViewIfNeeded();
  await expect(list.getByRole("option", { name: /acme\/site/ })).toBeInViewport();
  await shot(page, "short-window-browse");
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  const phone = await openGitTab(page);
  await phone.getByRole("button", { name: "Browse" }).click();
  await expect(popover(page).getByRole("option").first()).toBeVisible();
  await page.waitForTimeout(350);
  const field = await phone.locator("#ns-git").boundingBox();
  const pop = await popover(page).boundingBox();
  expect(field).not.toBeNull();
  expect(pop).not.toBeNull();
  expect(Math.abs((pop?.x ?? 0) - (field?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((pop?.width ?? 0) - (field?.width ?? 0))).toBeLessThanOrEqual(1);
  expect((pop?.x ?? 0) + (pop?.width ?? 0)).toBeLessThanOrEqual(390 - 16 + 1);
  await shot(page, "phone-browse");
});
