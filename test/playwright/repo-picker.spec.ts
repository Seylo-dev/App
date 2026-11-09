// The New app dialog's Git repository tab on the demo data (demo/repos.ts):
// browsing and picking a repository of the GitHub App or a git provider,
// typing owner/repo that an installation lists (a GitHub App source) or does
// not (a public GitHub URL), pasting URLs, the branch suggestions with the
// default preselected, and the empty, loading and error states. The ops are
// answered by the demo and recorded, so the test checks what gets created.

import { mkdirSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { ids, viewer } from "./demo/fixtures";
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

  await dialog.getByRole("checkbox", { name: "Deploy right away" }).uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${svc.project}/s/${svc.api}$`));
  expect(calls("github.connectRepo")).toEqual([
    { serviceId: svc.api, installationId: installation.id, repo: "acme/shop-api", branch: "dev", deployOnPush: true },
  ]);
  expect(calls("deployments.deploy")).toEqual([]);
  expect(errors).toEqual([]);
});

test("typed owner/repo that no installation lists is a public GitHub URL, with its branches from git", async ({ page }) => {
  const errors = trackErrors(page);
  const calls = watchOps(page);
  await installDemo(page);
  const dialog = await openGitTab(page);
  const field = dialog.locator("#ns-git");

  // The acme installation could hold it, but does not list it.
  await field.fill("acme/secret");
  await expect(note(dialog)).toHaveText("Public GitHub repository github.com/acme/secret - your GitHub App (acme) cannot read it");
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
  await expect(note(dialog)).toHaveText("From your GitLab connection Company GitLab - deploys on push");
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
