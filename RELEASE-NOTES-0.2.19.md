# Seylo 0.2.19

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-19

## Improved

- **MCP clients get the panel's icon.** The MCP server's `initialize` answer now names the panel's icon (`serverInfo.icons`, MCP 2025-11-25): the favicon uploaded under Settings > Appearance > Branding, whatever its format, else Seylo's own icon, as absolute URLs on the address the client connected to. Before, it sent none, so clients made up their own: Claude's connector list showed an icon it found for the parent domain.
- **`/favicon.ico` is a real icon.** It answered with the panel's page, so tools that look for a site's icon there found none. It is now the favicon uploaded under Appearance (no-cache with an ETag, so a change shows at once) or Seylo's icon in 16, 32 and 48 pixels, and index.html links it next to the SVG. With an uploaded favicon, the page carries only that icon, also after a change while it is open, so a browser that prefers SVG no longer keeps Seylo's built-in one.

## After the update

- Nothing to run by hand: no migration, and everything in 0.2.19 is in the panel.
- A client that already shows an icon for the panel may keep it until the connection is removed and added again. Whether Claude's connector list uses the icon the server names, or keeps looking one up for the domain, is up to Claude.
