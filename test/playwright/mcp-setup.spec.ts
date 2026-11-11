// Settings > API keys and MCP on the real panel: the MCP card's one-click
// installs per AI tool (each button's href is the tool's documented install
// link for this panel's URL, https ones in a new tab) and the two safety
// switches, on by default, which change the safety note, the Create token
// sheet's note and what mcp.info answers, and stay changed after a reload.

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { api, credentials, expect, postPastRateLimit, slug, stateFile, test } from "./helpers";

const shots = process.env.SHOTS_DIR ?? "shots";

interface McpInfo {
  url: string;
  askBeforeDestructive: boolean;
  readOnlyByDefault: boolean;
  snippets: Record<string, string>;
  installLinks: Record<string, string>;
}

async function mcpInfo(page: Page): Promise<McpInfo> {
  return (await (await api(page).get("/api/v1/mcp.info")).json()) as McpInfo;
}

function mcpCard(page: Page) {
  return page.locator('[data-slot="card"]').filter({ has: page.getByRole("heading", { level: 2, name: "MCP server", exact: true }) });
}

test.describe("MCP setup", () => {
  test.use({ storageState: stateFile });

  test("one-click installs: each AI tool's button opens its documented install link", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/settings/api-keys");
    const card = mcpCard(page);
    const tools = card.getByRole("radiogroup", { name: "AI tool" });
    await expect(tools).toBeVisible();
    const { url } = await mcpInfo(page);
    const tab = (name: string) => tools.getByRole("radio", { name, exact: true });
    const code = card.locator("pre code");

    // Claude Code: the command and the /mcp sign-in line, no button.
    await expect(tab("Claude Code")).toBeChecked();
    await expect(code).toHaveText(`claude mcp add --transport http ${slug} ${url}`);
    await expect(card.getByText(`then run /mcp in Claude Code and pick ${slug} to sign in.`)).toBeVisible();
    await expect(card.getByRole("link", { name: /^(Add to|Install in|Open Claude)/ })).toHaveCount(0);

    // Cursor: the "Add to Cursor" web link, base64 of the server's JSON, in a new tab.
    await tab("Cursor").click();
    const cursor = card.getByRole("link", { name: "Add to Cursor" });
    await expect(cursor).toHaveAttribute(
      "href",
      `https://cursor.com/en/install-mcp?name=${slug}&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url })).toString("base64"))}`,
    );
    await expect(cursor).toHaveAttribute("target", "_blank");
    await expect(cursor).toHaveAttribute("rel", "noreferrer");
    expect(JSON.parse((await code.textContent()) ?? "")).toEqual({ mcpServers: { [slug]: { url } } });
    await page.screenshot({ path: `${shots}/mcp-install-cursor.png`, fullPage: true });

    // VS Code: vscode:mcp/install?<JSON> inside the vscode.dev redirect wrapper.
    await tab("VS Code").click();
    const vscode = card.getByRole("link", { name: "Install in VS Code" });
    const install = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: slug, type: "http", url }))}`;
    await expect(vscode).toHaveAttribute("href", `https://vscode.dev/redirect?url=${encodeURIComponent(install)}`);
    await expect(vscode).toHaveAttribute("target", "_blank");
    await expect(code).toHaveText(`code --add-mcp '${JSON.stringify({ name: slug, type: "http", url })}'`);

    // goose: a goose:// link opens the app from this tab.
    await tab("goose").click();
    const goose = card.getByRole("link", { name: "Add to goose" });
    const href = (await goose.getAttribute("href")) ?? "";
    const gooseStart = `goose://extension?url=${encodeURIComponent(url)}&type=streamable_http&id=${slug}&name=${slug}&description=`;
    expect(href.startsWith(gooseStart), href).toBe(true);
    // Every value is URL-encoded, spaces as %20.
    expect(href.slice(gooseStart.length)).toMatch(/^[^ +&]+$/);
    await expect(goose).not.toHaveAttribute("target");

    // Claude: no install link, so the button opens the connectors page and the snippet is the URL to paste.
    await tab("Claude Desktop").click();
    const claude = card.getByRole("link", { name: "Open Claude connectors" });
    await expect(claude).toHaveAttribute("href", "https://claude.ai/customize/connectors");
    await expect(claude).toHaveAttribute("target", "_blank");
    await expect(code).toHaveText(url);
    await expect(card.getByText("click Add custom connector and paste this URL")).toBeVisible();

    // Codex and Gemini CLI: one command each.
    await tab("Codex").click();
    await expect(code).toHaveText(`codex mcp add ${slug} --url ${url}`);
    await tab("Gemini CLI").click();
    await expect(code).toHaveText(`gemini mcp add --transport http ${slug} ${url}`);
    await expect(card.getByRole("link", { name: /^(Add to|Install in|Open Claude)/ })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("an app signs in through the consent page in a real browser: the posts carry the panel's Origin", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/settings/api-keys");
    // The consent page needs a session that signed in or confirmed it is them in the last minutes.
    const fresh = await postPastRateLimit(api(page), page, "auth.reauth", { password: credentials.password });
    expect(fresh.ok(), await fresh.text()).toBe(true);
    // The MCP server is off until someone turns it on.
    expect((await api(page).post("/api/v1/mcp.update", { data: { enabled: true } })).ok()).toBe(true);

    // The app's loopback callback, as Claude Code and other desktop clients run one.
    const app = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("back in the app");
    });
    await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
    const appPort = (app.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${appPort}/callback`;
    const registered = await page.request.post("/oauth/register", {
      data: { client_name: "Playwright app", redirect_uris: [redirectUri] },
    });
    expect(registered.status()).toBe(201);
    const client = (await registered.json()) as { client_id: string };
    const verifier = `pw-${"v".repeat(40)}`;
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state: "pw-state",
    });
    const posts: { origin: string | null; site: string | null }[] = [];
    page.on("request", async (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/oauth/authorize") {
        posts.push({ origin: await request.headerValue("origin"), site: await request.headerValue("sec-fetch-site") });
      }
    });

    // The bridge page posts itself, then the consent page shows.
    await page.goto(`/oauth/authorize?${query}`);
    await expect(page.getByRole("heading", { name: `Connect an app at 127.0.0.1:${appPort}?` })).toBeVisible();
    await page.screenshot({ path: `${shots}/mcp-consent.png`, fullPage: true });
    await page.getByRole("button", { name: "Allow" }).click();
    await page.waitForURL(`${redirectUri}**`);
    const back = new URL(page.url());
    expect(back.searchParams.get("state")).toBe("pw-state");
    const code = back.searchParams.get("code") ?? "";
    expect(code).not.toBe("");
    // Both posts (the bridge's and Allow) went with this panel's origin, never "null".
    const panelOrigin = new URL(test.info().project.use.baseURL ?? "").origin;
    expect(posts).toEqual([
      { origin: panelOrigin, site: "same-origin" },
      { origin: panelOrigin, site: "same-origin" },
    ]);

    const token = await page.request.post("/oauth/token", {
      form: { grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier },
    });
    expect(token.ok(), await token.text()).toBe(true);
    expect(((await token.json()) as { access_token: string }).access_token).toMatch(new RegExp(`^${slug}_mcp_`));
    app.close();
    expect(errors).toEqual([]);
  });

  test("the safety switches start on, change the note and the token sheet, and stay after a reload", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto("/settings/api-keys");
      const card = mcpCard(page);
      const ask = card.getByRole("switch", { name: "Ask before destructive actions" });
      const readOnly = card.getByRole("switch", { name: "New AI tools start read-only" });
      const note = card.getByRole("note");
      await expect(ask).toBeChecked();
      await expect(readOnly).toBeChecked();
      await expect(note).toContainText("Read-only by default");
      await expect(note).toContainText("waits until a person approves it");
      await expect(note.getByRole("link", { name: "Open Approvals" })).toHaveAttribute("href", "/approvals");

      // Off: nothing waits, and the note says so and points at the activity log.
      await ask.click();
      await expect(ask).not.toBeChecked();
      await expect(note).toContainText("can also delete them right away, without asking");
      await expect(note.getByRole("link", { name: "Open the activity log" })).toHaveAttribute("href", "/activity");
      await expect.poll(async () => (await mcpInfo(page)).askBeforeDestructive).toBe(false);

      await readOnly.click();
      await expect(readOnly).not.toBeChecked();
      await expect(note).toContainText("Changes allowed by default");
      await expect(note).toContainText("New AI tools get read and change access");
      await expect.poll(async () => (await mcpInfo(page)).readOnlyByDefault).toBe(false);
      await page.screenshot({ path: `${shots}/mcp-safety-off.png`, fullPage: true });

      // The Create token sheet says a change token's deletes run right away too.
      await page.getByRole("button", { name: "Create token" }).click();
      await page.getByRole("dialog").getByRole("switch", { name: "Read-only" }).click();
      await expect(page.getByRole("dialog").getByRole("note")).toContainText("Ask before destructive actions is off");
      await page.keyboard.press("Escape");

      await page.reload();
      await expect(ask).not.toBeChecked();
      await expect(readOnly).not.toBeChecked();

      // Back on from the card.
      await ask.click();
      await readOnly.click();
      await expect(ask).toBeChecked();
      await expect(readOnly).toBeChecked();
      await expect(note).toContainText("Read-only by default");
      await expect.poll(async () => {
        const info = await mcpInfo(page);
        return [info.askBeforeDestructive, info.readOnlyByDefault];
      }).toEqual([true, true]);
      expect(errors).toEqual([]);
    } finally {
      await api(page).post("/api/v1/mcp.update", { data: { askBeforeDestructive: true, readOnlyByDefault: true } });
    }
  });
});
