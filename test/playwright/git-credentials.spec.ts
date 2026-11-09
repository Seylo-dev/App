// Git credentials in the browser, on the demo data (demo/git.ts): adding a
// token from a service's Git form and seeing it picked, generating an SSH
// deploy key (with the host keys of a host the panel does not know, read or
// pasted), and listing, editing and deleting credentials on Settings > Git
// providers. A credential deleted while the Git form has it picked is named
// so. Members, who cannot create credentials, see the picker only.

import type { Page } from "@playwright/test";
import { ids, viewer } from "./demo/fixtures";
import { handlers as gitHandlers } from "./demo/git";
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

// A host key line's key part, as ssh-keyscan prints it.
const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGdpdGVhLmxhbiBkZW1vIGhvc3Qga2V5LS0tLS0t";

/** The live socket: `send` tells the page that ops changed, as the panel does after a change in another tab. */
async function liveSocket(page: Page) {
  let socket: { send(text: string): void } | null = null;
  let topic = "";
  await page.routeWebSocket(/\/api\/live/, (ws) => {
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type: string; topic: string };
      if (message.type !== "subscribe") return;
      ws.send(JSON.stringify({ type: "subscribed", topic: message.topic }));
      socket = ws;
      topic = message.topic;
    });
  });
  return {
    async invalidate(ops: string[]) {
      await expect.poll(() => socket !== null).toBe(true);
      socket?.send(JSON.stringify({ type: "event", topic, event: { type: "invalidate", ops } }));
    },
  };
}

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
    expect(calls.find((c) => c.op === "git.branches")?.input).toEqual({ projectId: ids.acme, url, credentialId: "cred000000000005" });
    const gitForm = page.locator("form", { has: page.getByLabel("Repository URL") });
    await gitForm.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    expect(calls.find((c) => c.op === "services.setSource")?.input.source).toMatchObject({ type: "git", url, credentialId: "cred000000000005" });

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

  test("pasted known_hosts lines must name the host as ssh-keyscan does, and the paste button hands focus to the box", async ({ page }) => {
    const calls = watchApi(page);
    await installDemo(page, { overrides: { "services.get": gitSource("ssh://git@gitea.lan:2222/acme/shop-api.git") } });
    await page.goto(sourcePage);
    await page.getByRole("button", { name: "Add credential" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a git credential" });

    // From the keyboard: the button goes away, and focus lands in the box it opened.
    await dialog.getByRole("button", { name: "Paste known_hosts lines instead" }).focus();
    await page.keyboard.press("Enter");
    const box = dialog.getByLabel("known_hosts lines");
    await expect(box).toBeFocused();
    await expect(box).toHaveAttribute("placeholder", "[gitea.lan]:2222 ssh-ed25519 AAAA…");
    await expect(dialog.getByText("Run ssh-keyscan -p 2222 gitea.lan and paste what it prints.")).toBeVisible();

    // The host:port form the old placeholder showed: the panel never matches it.
    await page.keyboard.type(`gitea.lan:2222 ${hostKey}`);
    const noMatch = dialog.getByText(
      "No line here is for [gitea.lan]:2222. Each line starts with that name, and hashed lines (|1|…) do not work.",
    );
    await expect(noMatch).toBeVisible();
    await expect(box).toHaveAttribute("aria-invalid", "true");
    const generate = dialog.getByRole("button", { name: "Generate key" });
    await expect(generate).toBeDisabled();
    await page.screenshot({ path: `${shots}/known-hosts-mismatch.png` });
    // A hashed line copied from ~/.ssh/known_hosts names no host either.
    await box.fill(`|1|F1E1KeoE/eEWhi10WpGv4OdiO6Y=|3988QV0VE8wmZL7suNrYQLITLCg= ${hostKey}`);
    await expect(noMatch).toBeVisible();
    await expect(generate).toBeDisabled();

    await box.fill(`[gitea.lan]:2222 ${hostKey}`);
    await expect(noMatch).toHaveCount(0);
    await expect(box).toHaveAttribute("aria-invalid", "false");
    await generate.click();
    await expect(page.getByRole("dialog", { name: "Add the deploy key" })).toBeVisible();
    expect(calls.find((c) => c.op === "git.generateSshKey")?.input).toEqual({
      name: "acme/shop-api",
      host: "gitea.lan:2222",
      knownHosts: `[gitea.lan]:2222 ${hostKey}`,
    });
  });

  test("host keys read for a host that changed while the read was out are dropped", async ({ page }) => {
    const calls = watchApi(page);
    await installDemo(page, {
      overrides: { "services.get": gitSource("git@gitea.lan:acme/shop-api.git") },
      // A slow host: the person fixes the port before the first read comes back.
      delay: (op) => (op === "git.scanHostKeys" ? 1500 : 0),
    });
    await page.goto(sourcePage);
    await page.getByRole("button", { name: "Add credential" }).click();
    const dialog = page.getByRole("dialog", { name: "Add a git credential" });
    const host = dialog.getByLabel("Host", { exact: true });
    await expect(host).toHaveValue("gitea.lan");
    const firstRead = page.waitForResponse((response) => response.url().includes("git.scanHostKeys"));
    await dialog.getByRole("button", { name: "Read host keys" }).click();
    await expect(dialog.getByRole("button", { name: "Reading host keys…" })).toBeVisible();
    await host.fill("gitea.lan:2222");
    await firstRead;

    // The keys of port 22 came back after the change: none of them shows or counts.
    await page.waitForTimeout(300);
    await expect(dialog.getByRole("list", { name: "Host keys" })).toHaveCount(0);
    await expect(dialog.getByText("Read the host keys of gitea.lan:2222, so builds can trust it.")).toBeVisible();
    const generate = dialog.getByRole("button", { name: "Generate key" });
    await expect(generate).toBeDisabled();

    await dialog.getByRole("button", { name: "Read host keys" }).click();
    await expect(dialog.getByRole("list", { name: "Host keys" }).getByRole("listitem")).toHaveCount(2);
    await expect(dialog.getByText("Compare these fingerprints with the ones gitea.lan:2222 publishes before you save.")).toBeVisible();
    await generate.click();
    await expect(page.getByRole("dialog", { name: "Add the deploy key" })).toBeVisible();
    expect(calls.filter((c) => c.op === "git.scanHostKeys").map((c) => c.input)).toEqual([{ host: "gitea.lan" }, { host: "gitea.lan:2222" }]);
    expect(calls.find((c) => c.op === "git.generateSshKey")?.input.knownHosts.split("\n")).toEqual([
      expect.stringMatching(/^\[gitea\.lan\]:2222 ssh-ed25519 /),
      expect.stringMatching(/^\[gitea\.lan\]:2222 ecdsa-sha2-nistp256 /),
    ]);
  });

  test("a credential deleted while the Git form has it picked is named so, and Save waits for another pick", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const calls = watchApi(page);
    await installDemo(page, { overrides: { "services.get": gitSource("ssh://git@gitea.lan:2222/acme/shop-api.git") } });
    const live = await liveSocket(page);
    await page.goto(sourcePage);
    const picker = page.getByRole("combobox", { name: "Credential" });
    await picker.click();
    await page.getByRole("option", { name: "Office Gitea · gitea.lan:2222" }).click();
    await expect(picker).toContainText("Office Gitea · gitea.lan:2222");

    // Deleted in another tab before this one saves; the panel tells every tab the list changed.
    gitHandlers["git.deleteCredential"]?.({ credentialId: "cred000000000003" });
    await live.invalidate(["git.listCredentials"]);

    await expect(picker).toContainText("Deleted credential");
    const note = page.getByText("The credential you picked was deleted. Pick another.");
    await expect(note).toBeVisible();
    const gitForm = page.locator("form", { has: page.getByLabel("Repository URL") });
    const save = gitForm.getByRole("button", { name: "Save", exact: true });
    await expect(save).toBeDisabled();
    await expect(page.getByRole("button", { name: "Check access" })).toBeDisabled();
    await page.screenshot({ path: `${shots}/deleted-credential.png` });

    await picker.click();
    await expect(page.getByRole("option", { name: "Deleted credential" })).toHaveAttribute("aria-disabled", "true");
    await page.getByRole("option", { name: "None (public repository)" }).click();
    await expect(note).toHaveCount(0);
    await expect(save).toBeEnabled();
    expect(calls.filter((c) => c.op === "services.setSource" || c.op === "git.branches")).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("list, edit, add and delete git credentials on Settings > Git providers", async ({ page }) => {
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
    // Only the key saved without host keys is marked.
    await expect(row(/Build mirror/)).toContainText("Host keys missing");
    await expect(card.getByText("Host keys missing")).toHaveCount(1);
    await page.screenshot({ path: `${shots}/settings.png`, fullPage: true });

    // Rename: an SSH key shows its public key to copy again, and its saved host keys.
    await row(/Office Gitea/).getByRole("button", { name: "Edit" }).click();
    const rename = page.getByRole("dialog", { name: "Edit Office Gitea" });
    await expect(rename.getByText(/^ssh-ed25519 AAAA/)).toBeVisible();
    await expect(rename.getByLabel("known_hosts lines")).toHaveValue(/^\[gitea\.lan\]:2222 ssh-ed25519 /);
    await rename.getByLabel("Name", { exact: true }).fill("Office Gitea 2222");
    await rename.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Credential saved.")).toBeVisible();
    await expect(row(/Office Gitea 2222/)).toBeVisible();
    // Only the name changed, so only the name is sent.
    expect(calls.find((c) => c.op === "git.updateCredential")?.input).toEqual({ credentialId: "cred000000000003", name: "Office Gitea 2222" });
    const updates = () => calls.filter((c) => c.op === "git.updateCredential").map((c) => c.input);

    // Host keys for a key saved without them: read them in Edit, and the mark goes.
    await row(/Build mirror/).getByRole("button", { name: "Edit" }).click();
    const mirror = page.getByRole("dialog", { name: "Edit Build mirror" });
    await expect(mirror.getByText("Read the host keys of git.acme.dev, so builds can trust it.")).toBeVisible();
    await mirror.getByRole("button", { name: "Read host keys" }).click();
    await expect(mirror.getByRole("list", { name: "Host keys" }).getByRole("listitem")).toHaveCount(2);
    await page.screenshot({ path: `${shots}/edit-host-keys.png` });
    await mirror.getByRole("button", { name: "Save" }).click();
    await expect(mirror).toHaveCount(0);
    await expect.poll(() => updates().length).toBe(2);
    expect(updates()[1]).toEqual({ credentialId: "cred000000000004", knownHosts: expect.any(String) });
    expect(updates()[1]?.knownHosts.split("\n")).toEqual([
      expect.stringMatching(/^git\.acme\.dev ssh-ed25519 /),
      expect.stringMatching(/^git\.acme\.dev ecdsa-sha2-nistp256 /),
    ]);
    await expect(card.getByText("Host keys missing")).toHaveCount(0);

    // A token is replaced from Edit; one typed and then cancelled is gone the next time.
    await row(/GitLab read token/).getByRole("button", { name: "Edit" }).click();
    const tokenEdit = page.getByRole("dialog", { name: "Edit GitLab read token" });
    const replace = tokenEdit.getByLabel("Replace token");
    await expect(replace).toHaveAttribute("type", "password");
    await expect(tokenEdit.getByLabel("User name")).toHaveValue("git");
    await expect(tokenEdit.getByText("Leave it empty to keep the current token.")).toBeVisible();
    await replace.fill("glpat-typed-then-cancelled");
    await tokenEdit.getByRole("button", { name: "Cancel" }).click();
    await expect(tokenEdit).toHaveCount(0);
    await row(/GitLab read token/).getByRole("button", { name: "Edit" }).click();
    await expect(replace).toHaveValue("");
    await replace.fill("glpat-rotated-1");
    await tokenEdit.getByRole("button", { name: "Save" }).click();
    await expect(tokenEdit).toHaveCount(0);
    await expect.poll(() => updates().length).toBe(3);
    expect(updates()[2]).toEqual({ credentialId: "cred000000000001", token: "glpat-rotated-1" });

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
