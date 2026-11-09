// Git credentials in the browser, on the demo data (demo/git.ts): adding a
// token from a service's Git form and seeing it picked, generating an SSH
// deploy key (with the host keys of a host the panel does not know), and
// listing, renaming and deleting credentials on Settings > Git providers.
// Members, who cannot create credentials, see the picker only.

import type { Page } from "@playwright/test";
import { ids, viewer } from "./demo/fixtures";
import { installDemo } from "./demo/routes";
import { handlers as serviceHandlers, ids as svc } from "./demo/service";
import { expect, stateFile, test } from "./helpers";

type Input = Record<string, any>;

const shots = `${process.env.SHOTS_DIR ?? "shots"}/git-credentials`;
const sourcePage = `/p/${ids.acme}/s/${svc.api}/source`;

/** Every op call the page makes: mutations as their JSON body, queries (GET) as their search parameters. */
function watchApi(page: Page) {
  const calls: { op: string; input: Input }[] = [];
  page.on("request", (request) => {
    const match = /\/api\/v1\/([a-zA-Z]+\.[a-zA-Z]+)/.exec(request.url());
    if (!match) return;
    const input = request.method() === "GET" ? Object.fromEntries(new URL(request.url()).searchParams) : (request.postDataJSON() ?? {});
    calls.push({ op: match[1] as string, input });
  });
  return calls;
}

/** services.get of the demo's api service, with a git URL source. */
const gitSource = (url: string) => (input: Input) => ({
  ...(serviceHandlers["services.get"] as (i: Input) => Input)({ serviceId: input.serviceId }),
  source: { type: "git", label: url, branch: "main", builder: "railpack" },
  sourceConfig: { type: "git", url, branch: "main", credentialId: null, deployOnPush: false },
});

const asMember = { "auth.whoami": () => ({ viewer: { ...viewer, role: "member" }, via: "session" }) };

test.describe("git credentials", () => {
  test.use({ storageState: stateFile });

  test("add a token credential from the Git form and see it selected", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const calls = watchApi(page);
    const url = "https://gitlab.com/acme/shop-api.git";
    await installDemo(page, {
      overrides: {
        "services.get": gitSource(url),
        "services.setSource": (input) => gitSource(url)({ serviceId: input.serviceId }),
      },
    });
    await page.goto(sourcePage);
    const picker = page.getByRole("combobox", { name: "Credential" });
    await expect(picker).toContainText("None (public repository)");
    await expect(page.getByRole("link", { name: "Manage git credentials" })).toHaveAttribute(
      "href",
      "/settings/git-providers#git-credentials",
    );

    await page.getByRole("button", { name: "Add credential" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a git credential" });
    // An https:// URL takes a token; the name and host come from the URL.
    await expect(dialog.getByRole("radio", { name: "Token" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("acme/shop-api");
    await expect(dialog.getByLabel("Host", { exact: true })).toHaveValue("gitlab.com");
    await expect(dialog.getByLabel("User name")).toHaveValue("git");
    await expect(dialog.getByText("GitHub takes any user name with a token.")).toBeVisible();
    await expect(dialog.getByText("On GitLab, create a project access token with the read_repository scope.")).toBeVisible();
    const token = dialog.getByLabel("Token", { exact: true });
    await expect(token).toHaveAttribute("type", "password");
    const save = dialog.getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();
    await token.fill("glpat-demo-token-1");
    // The dialog's opening fade is over before the picture.
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${shots}/add-token.png` });
    await save.click();

    await expect(page.getByText("Credential acme/shop-api added.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(picker).toContainText("acme/shop-api · gitlab.com");
    expect(calls.find((c) => c.op === "git.createCredential")?.input).toEqual({
      name: "acme/shop-api",
      host: "gitlab.com",
      kind: "token",
      username: "git",
      token: "glpat-demo-token-1",
    });

    // Check access and Save use the new credential.
    await page.getByRole("button", { name: "Check access" }).click();
    await expect(page.getByText("Reachable: 2 branches, default main.")).toBeVisible();
    expect(calls.find((c) => c.op === "git.branches")?.input).toEqual({ projectId: ids.acme, url, credentialId: "cred000000000004" });
    const gitForm = page.locator("form", { has: page.getByLabel("Repository URL") });
    await gitForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    expect(calls.find((c) => c.op === "services.setSource")?.input.source).toMatchObject({ type: "git", url, credentialId: "cred000000000004" });

    // Manage git credentials opens the card on Settings > Git providers, with the new one listed.
    await page.getByRole("link", { name: "Manage git credentials" }).click();
    await expect(page).toHaveURL(/\/settings\/git-providers#git-credentials$/);
    const card = page.locator("section#git-credentials");
    await expect(card.getByRole("row", { name: /acme\/shop-api/ })).toContainText("Not used");
    await expect(card.getByRole("heading", { name: "Git credentials" })).toBeInViewport();
    expect(errors).toEqual([]);
  });

  test("generate an SSH key for GitHub and see the public key to add as a deploy key", async ({ page }) => {
    const calls = watchApi(page);
    await installDemo(page, { overrides: { "services.get": gitSource("git@github.com:acme/shop-api.git") } });
    await page.goto(sourcePage);
    await page.getByRole("button", { name: "Add credential" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a git credential" });
    // A git@ URL takes an SSH key; the panel knows GitHub's host keys, so there is nothing to read.
    await expect(dialog.getByRole("radio", { name: "SSH key" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByRole("radio", { name: "Generate a key" })).toHaveAttribute("aria-checked", "true");
    await expect(dialog.getByText("The panel already knows GitHub's host keys.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Read host keys" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Generate key" }).click();

    const step = page.getByRole("dialog", { name: "Add the deploy key" });
    await expect(step.getByText(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5/)).toBeVisible();
    await expect(step.getByText("GitHub: the repository's Settings > Deploy keys > Add deploy key. Leave write access off.")).toBeVisible();
    await expect(step.getByText(/Fingerprint: SHA256:/)).toBeVisible();
    await page.screenshot({ path: `${shots}/deploy-key.png` });
    expect(calls.find((c) => c.op === "git.generateSshKey")?.input).toEqual({ name: "acme/shop-api", host: "github.com" });
    await step.getByRole("button", { name: "Done" }).click();
    await expect(step).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Credential" })).toContainText("acme/shop-api · github.com");
  });

  test("an SSH key for a host the panel does not know needs its host keys first", async ({ page }) => {
    const calls = watchApi(page);
    await installDemo(page, { overrides: { "services.get": gitSource("ssh://git@gitea.lan:2222/acme/shop-api.git") } });
    await page.goto(sourcePage);
    await page.getByRole("button", { name: "Add credential" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a git credential" });
    await expect(dialog.getByLabel("Host", { exact: true })).toHaveValue("gitea.lan:2222");
    const generate = dialog.getByRole("button", { name: "Generate key" });
    await expect(generate).toBeDisabled();
    await expect(dialog.getByText("Read the host keys of gitea.lan:2222, so builds can trust it.")).toBeVisible();

    await dialog.getByRole("button", { name: "Read host keys" }).click();
    const keys = dialog.getByRole("list", { name: "Host keys" });
    await expect(keys.getByRole("listitem")).toHaveCount(2);
    await expect(keys.getByText(/^ssh-ed25519 SHA256:/)).toBeVisible();
    await expect(dialog.getByText("Compare these fingerprints with the ones gitea.lan:2222 publishes before you save.")).toBeVisible();
    expect(calls.find((c) => c.op === "git.scanHostKeys")?.input).toEqual({ host: "gitea.lan:2222" });
    await page.screenshot({ path: `${shots}/host-keys.png` });

    // Pasting a key instead: Save waits for a private key.
    await dialog.getByRole("radio", { name: "Paste a private key" }).click();
    const save = dialog.getByRole("button", { name: "Save" });
    await expect(save).toBeDisabled();
    await dialog.getByLabel("Private key").fill("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----");
    await save.click();
    await expect(page.getByText("Credential acme/shop-api added.")).toBeVisible();
    const create = calls.find((c) => c.op === "git.createCredential")?.input;
    expect(create).toMatchObject({ name: "acme/shop-api", host: "gitea.lan:2222", kind: "ssh_key" });
    expect(create?.knownHosts.split("\n")).toEqual([
      expect.stringMatching(/^\[gitea\.lan\]:2222 ssh-ed25519 /),
      expect.stringMatching(/^\[gitea\.lan\]:2222 ecdsa-sha2-nistp256 /),
    ]);
    await expect(page.getByRole("combobox", { name: "Credential" })).toContainText("acme/shop-api · gitea.lan:2222");
  });

  test("list, rename, add and delete git credentials on Settings > Git providers", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const calls = watchApi(page);
    await installDemo(page);
    await page.goto("/settings/git-providers#git-credentials");
    const card = page.locator("section#git-credentials");
    await expect(card.getByRole("heading", { name: "Git credentials" })).toBeInViewport();
    const row = (name: string | RegExp) => card.getByRole("row", { name });
    await expect(row(/GitLab read token/)).toContainText("Token");
    await expect(row(/GitLab read token/)).toContainText("gitlab.com");
    await expect(row(/GitLab read token/)).toContainText("2 services");
    await expect(row(/Office Gitea/)).toContainText("SSH key");
    await expect(row(/Office Gitea/)).toContainText("Not used");
    await page.screenshot({ path: `${shots}/settings.png`, fullPage: true });

    // Rename: an SSH key shows its public key to copy again.
    await row(/Office Gitea/).getByRole("button", { name: "Rename" }).click();
    const rename = page.getByRole("dialog", { name: "Rename Office Gitea" });
    await expect(rename.getByText(/^ssh-ed25519 AAAA/)).toBeVisible();
    await rename.getByLabel("Name", { exact: true }).fill("Office Gitea 2222");
    await rename.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Credential renamed.")).toBeVisible();
    await expect(row(/Office Gitea 2222/)).toBeVisible();
    expect(calls.find((c) => c.op === "git.updateCredential")?.input).toEqual({ credentialId: "cred000000000003", name: "Office Gitea 2222" });

    // One that services clone with is not offered for deletion: the dialog says how many use it.
    await row(/GitLab read token/).getByRole("button", { name: "Delete" }).click();
    const inUse = page.getByRole("dialog", { name: "GitLab read token is in use" });
    await expect(inUse.getByText("2 services clone with it. Point their source at another credential first, then delete it.")).toBeVisible();
    await inUse.getByRole("button", { name: "Close" }).click();
    await expect(inUse).toHaveCount(0);

    // Add one here, without a URL: the host is typed and the token hint follows it.
    await card.getByRole("button", { name: "Add credential" }).click();
    const add = page.getByRole("dialog", { name: "Add a git credential" });
    await expect(add.getByLabel("Host", { exact: true })).toHaveValue("");
    await add.getByLabel("Name", { exact: true }).fill("Bitbucket shop");
    await add.getByLabel("Host", { exact: true }).fill("bitbucket.org");
    await expect(add.getByText(/use the user name x-token-auth/)).toBeVisible();
    await add.getByLabel("User name").fill("x-token-auth");
    await add.getByLabel("Token", { exact: true }).fill("bb-token-1");
    await add.getByRole("button", { name: "Save" }).click();
    await expect(row(/Bitbucket shop/)).toContainText("x-token-auth");

    // An unused one is deleted after a confirm.
    await row(/Office Gitea 2222/).getByRole("button", { name: "Delete" }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm.getByText("Delete Office Gitea 2222?")).toBeVisible();
    await confirm.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Credential deleted.")).toBeVisible();
    await expect(row(/Office Gitea/)).toHaveCount(0);
    expect(calls.filter((c) => c.op === "git.deleteCredential").map((c) => c.input)).toEqual([{ credentialId: "cred000000000003" }]);
    expect(errors).toEqual([]);
  });

  test("members, who cannot create git credentials, see the picker only", async ({ page }) => {
    await installDemo(page, { overrides: { ...asMember, "services.get": gitSource("https://gitlab.com/acme/shop-api.git") } });
    await page.goto(sourcePage);
    await expect(page.getByRole("combobox", { name: "Credential" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add credential" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Manage git credentials" })).toHaveCount(0);
    await page.goto("/settings/git-providers");
    await expect(page.getByRole("heading", { level: 1, name: "Git providers" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Git credentials" })).toHaveCount(0);
  });
});
