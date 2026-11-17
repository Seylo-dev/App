# Seylo 0.2.19

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-19

## Improved

- **MCP clients get the panel's icon.** The MCP server's `initialize` answer now names the panel's icon (`serverInfo.icons`, MCP 2025-11-25): the favicon uploaded under Settings > Appearance > Branding, whatever its format, else Seylo's own icon, as absolute URLs on the address the client connected to. Before, it sent none, so clients made up their own: Claude's connector list showed an icon it found for the parent domain.
- **`/favicon.ico` is a real icon.** It answered with the panel's page, so tools that look for a site's icon there found none. It is now the favicon uploaded under Appearance (no-cache with an ETag, so a change shows at once) or Seylo's icon in 16, 32 and 48 pixels, and index.html links it next to the SVG. With an uploaded favicon, the page carries only that icon, also after a change while it is open, so a browser that prefers SVG no longer keeps Seylo's built-in one.

## Fixed

- **The panel's registry never shrank.** Every build is pushed to the registry on the panel's node and the panel deletes old images from it, but the space only comes back when the registry collects its garbage. That collection waited 24 hours after every agent start (agents restart with every update) and gave up whenever any node held a connection to the registry, so on a busy panel it could stop running altogether (one panel's registry had reached 67 GB). The last collection is now kept in the agent's state folder, so a restart does not put the next one off; connections that moved nothing for 2 minutes are closed instead of waited for; and every cleanup that removes images on the panel's node runs one and reports what it freed (`registry: ... freed`, and in a preview what it would free). Needs the panel node's agent 0.2.19.
- **Cleanup kept every old version of a pulled image.** Images pulled from a registry (a database's, an app deployed from an image, the panel's own after each update) carry no Seylo label, so cleanup never removed them. The agent now records which image each service's containers were made from, in its state folder, and those images follow the rule of built images: keep the ones any container on the machine uses, the deployed one and the newest 3 the service used. Old panel images count even from before the record. Images no Seylo service used, Wings game servers' among them, are never touched. Needs the node's agent 0.2.19.

## After the update

- Nothing to run by hand: no migration. The icon changes need only the panel; the two cleanup fixes need the node's agent 0.2.19.
- The first cleanup with images on the panel's node after its agent updates may free a lot at once: what the registry kept since it last collected garbage, and old panel images.
- A client that already shows an icon for the panel may keep it until the connection is removed and added again. Whether Claude's connector list uses the icon the server names, or keeps looking one up for the domain, is up to Claude.
