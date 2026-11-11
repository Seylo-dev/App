// How each AI tool adds this panel as a remote MCP server (Streamable HTTP,
// signing in through OAuth): a snippet to run or paste, and a one-click
// install link where the tool publishes a format. The server is named after
// the brand slug everywhere. Formats come from each tool's own docs:
//
//   Claude Code  claude mcp add --transport http --scope user <name> <url> (code.claude.com/docs/en/mcp:
//                user scope works in every project; no URL scheme adds a server)
//   Claude       Customize > Connectors > Add custom connector, paste the
//                URL (claude.com/docs/connectors/custom/add-unlisted); no
//                install link or pre-filled dialog exists, so the button
//                copies the URL and opens that page
//   Cursor       the "Add to Cursor" web link of cursor.com/docs/context/mcp/install-links:
//                https://cursor.com/en/install-mcp?name=<name>&config=<base64 of the server's JSON>,
//                which opens cursor://anysphere.cursor-deeplink/mcp/install with the same values
//   VS Code      vscode:mcp/install?<URL-encoded JSON with a name> inside the https
//                wrapper https://vscode.dev/redirect?url=<URL-encoded link>
//                (code.visualstudio.com/api/extension-guides/ai/mcp); code --add-mcp <JSON>
//   Codex        codex mcp add <name> --url <url>, which starts the OAuth sign-in itself
//                (developers.openai.com/codex/mcp)
//   Gemini CLI   gemini mcp add --transport http <name> <url> (docs/tools/mcp-server.md)
//   goose        goose://extension?url=...&type=streamable_http&id=...&name=...&description=...,
//                every value URL-encoded (goose-docs.ai/docs/getting-started/using-extensions)
//
// LM Studio and Windsurf are left out: their docs show remote servers only
// with a token header, or moved, so no verified OAuth format.

import { displayName, slug } from "@seylo/brand";

/** Host keys in the order the MCP card shows them. */
export const mcpHosts = ["claude-code", "claude-desktop", "cursor", "vscode", "codex", "gemini-cli", "goose"] as const;

/** Where Claude (web, desktop and mobile) adds a custom connector by URL. */
export const claudeConnectorsUrl = "https://claude.ai/customize/connectors";

/** A POSIX shell word: single quotes, with any single quote inside closed, escaped and reopened. */
function shellWord(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** What to run or paste for each host, keyed like mcpHosts. */
export function mcpSnippets(url: string, name: string = slug): Record<string, string> {
  return {
    "claude-code": `claude mcp add --transport http --scope user ${name} ${url}`,
    // A custom connector takes the URL itself.
    "claude-desktop": url,
    // ~/.cursor/mcp.json or a project's .cursor/mcp.json.
    cursor: JSON.stringify({ mcpServers: { [name]: { url } } }, null, 2),
    vscode: `code --add-mcp ${shellWord(JSON.stringify({ name, type: "http", url }))}`,
    codex: `codex mcp add ${name} --url ${url}`,
    "gemini-cli": `gemini mcp add --transport http ${name} ${url}`,
    // One session; goose configure > Add Extension > Remote Extension (Streamable HTTP) keeps it.
    goose: `goose session --with-streamable-http-extension ${shellWord(url)}`,
  };
}

/** A query string with every value URL-encoded, spaces as %20 (URLSearchParams would write +). */
function query(params: [string, string][]): string {
  return params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
}

/** One-click install links for the hosts that publish a format, keyed like mcpHosts. */
export function mcpInstallLinks(url: string, name: string = slug): Record<string, string> {
  const cursorConfig = Buffer.from(JSON.stringify({ url }), "utf8").toString("base64");
  const vscodeLink = `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: "http", url }))}`;
  return {
    "claude-desktop": claudeConnectorsUrl,
    cursor: `https://cursor.com/en/install-mcp?${query([
      ["name", name],
      ["config", cursorConfig],
    ])}`,
    vscode: `https://vscode.dev/redirect?${query([["url", vscodeLink]])}`,
    goose: `goose://extension?${query([
      ["url", url],
      ["type", "streamable_http"],
      ["id", name],
      ["name", name],
      ["description", `${displayName} deploy panel`],
    ])}`,
  };
}
