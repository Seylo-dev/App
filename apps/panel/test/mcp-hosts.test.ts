// The MCP card's setup per AI tool (modules/mcp/hosts.ts): exact snippets
// and one-click install links for a sample URL, in each tool's documented
// format, and that the links decode back to the server's URL and name.

import { expect, test } from "bun:test";
import { mcpHosts, mcpInstallLinks, mcpSnippets } from "../src/modules/mcp/hosts";

const url = "https://panel.acme.dev/mcp";

test("every host has a snippet, and install links only for hosts the card knows", () => {
  expect(Object.keys(mcpSnippets(url))).toEqual([...mcpHosts]);
  expect(Object.keys(mcpInstallLinks(url)).every((host) => (mcpHosts as readonly string[]).includes(host))).toBe(true);
});

test("snippets: the commands and configs to paste, the server named seylo", () => {
  expect(mcpSnippets(url)).toEqual({
    "claude-code": "claude mcp add --transport http seylo https://panel.acme.dev/mcp",
    "claude-desktop": "https://panel.acme.dev/mcp",
    cursor: '{\n  "mcpServers": {\n    "seylo": {\n      "url": "https://panel.acme.dev/mcp"\n    }\n  }\n}',
    vscode: `code --add-mcp '{"name":"seylo","type":"http","url":"https://panel.acme.dev/mcp"}'`,
    codex: "codex mcp add seylo --url https://panel.acme.dev/mcp",
    "gemini-cli": "gemini mcp add --transport http seylo https://panel.acme.dev/mcp",
    goose: "goose session --with-streamable-http-extension 'https://panel.acme.dev/mcp'",
  });
  // A quote in a configured public URL cannot end the shell word early.
  expect(mcpSnippets("https://it's.example/mcp").goose).toBe(
    "goose session --with-streamable-http-extension 'https://it'\\''s.example/mcp'",
  );
});

test("install links: Cursor's web link, VS Code's redirect wrapper, goose's deep link and Claude's connectors page", () => {
  expect(mcpInstallLinks(url)).toEqual({
    "claude-desktop": "https://claude.ai/customize/connectors",
    // base64 of {"url":"https://panel.acme.dev/mcp"}
    cursor: "https://cursor.com/en/install-mcp?name=seylo&config=eyJ1cmwiOiJodHRwczovL3BhbmVsLmFjbWUuZGV2L21jcCJ9",
    // vscode:mcp/install?<encoded JSON>, encoded once more for the wrapper's url parameter.
    vscode:
      "https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522seylo%2522%252C%2522type%2522%253A%2522http%2522%252C%2522url%2522%253A%2522https%253A%252F%252Fpanel.acme.dev%252Fmcp%2522%257D",
    goose:
      "goose://extension?url=https%3A%2F%2Fpanel.acme.dev%2Fmcp&type=streamable_http&id=seylo&name=seylo&description=Seylo%20deploy%20panel",
  });
  // Base64 padding is encoded, so the config survives the query string.
  expect(mcpInstallLinks("http://192.168.1.20:3000/mcp").cursor).toBe(
    "https://cursor.com/en/install-mcp?name=seylo&config=eyJ1cmwiOiJodHRwOi8vMTkyLjE2OC4xLjIwOjMwMDAvbWNwIn0%3D",
  );
});

test("the links decode back to the server, the way each tool reads them", () => {
  const links = mcpInstallLinks("http://192.168.1.20:3000/mcp");
  // Cursor's page reads name and config from its query and base64-decodes the config.
  const cursor = new URL(links.cursor ?? "").searchParams;
  expect(cursor.get("name")).toBe("seylo");
  expect(JSON.parse(atob(cursor.get("config") ?? ""))).toEqual({ url: "http://192.168.1.20:3000/mcp" });
  // vscode.dev redirects to its url parameter; VS Code reads the JSON after the "?".
  const vscode = new URL(links.vscode ?? "").searchParams.get("url") ?? "";
  expect(vscode).toStartWith("vscode:mcp/install?");
  expect(JSON.parse(decodeURIComponent(vscode.slice("vscode:mcp/install?".length)))).toEqual({
    name: "seylo",
    type: "http",
    url: "http://192.168.1.20:3000/mcp",
  });
  // goose parses the link as a URL and reads its search parameters.
  const goose = new URL(links.goose ?? "");
  expect(goose.protocol).toBe("goose:");
  expect(Object.fromEntries(goose.searchParams)).toEqual({
    url: "http://192.168.1.20:3000/mcp",
    type: "streamable_http",
    id: "seylo",
    name: "seylo",
    description: "Seylo deploy panel",
  });
});
