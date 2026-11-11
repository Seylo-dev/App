# Seylo 0.2.8

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-8

## New

- **Move the panel to another server.** The owner moves the panel to another node in Settings > General > Move the panel to another server. Everything moves: the database, the master key, the agents' TLS key, branding, uploaded sources and the image registry with every built image. The panel is read-only for the few minutes it takes and apps keep running. It starts the panel on the new server and checks it before anything switches, tells every node the new address ahead of time, and nodes follow on their own with the pin they already trust, so nothing has to be joined again. Until the new server confirms the switch, the moved panel turns nodes away, so a node that loses the old panel for a moment comes back to it. If any step fails before the switch, the move rolls back and the panel carries on where it was. The old server keeps a stopped copy until you press Delete the old copy on the moved panel. Nodes that are offline or connect over plain http:// cannot follow: the check names them, and you can move anyway and join them again with `seylo join --force`.

## Improved

- **GitHub page.** A connected account can switch to a personal access token, or replace its token, right on Settings > GitHub. Before, the token option only showed with no account connected.
- **Joining behind a firewall that decrypts HTTPS.** A network doing TLS inspection (a FortiGate, Zscaler or the like) replaces the panel domain's certificate, and the agent refuses it. Add node now also offers the same token over the panel's IP address and its pinned key ("Network decrypts HTTPS? Join over the panel's IP instead"), and the agent and installer name who issued the certificate they got and say it looks like TLS inspection, instead of advice about open ports.
- **MCP setup for Claude.** The Claude Code command adds the panel for every project (`--scope user`), and Copy the URL and open Claude puts the server URL on the clipboard on the way to Claude's connectors page. Claude has no install link to go further.

## Fixed

- **MCP sign-in from a browser ended on "Not allowed: This form can only be sent from the panel itself".** The sign-in pages told browsers to send no referrer, which by the web standard also makes them send `Origin: null` on the form posts, and the panel refused those as coming from another site. Signing in an AI tool through the browser now finishes.

- **The panel domain could go active for another server.** The check took any `{"status":"ok"}` answer from `https://<domain>/api/health` as the panel's, and a Cloudflare-proxied record skips the address check. So a proxied domain still pointing at another server (an old panel, or any app with that health route) went active: `http://<ip>:3000` redirected people there, and with Serve on IP address off, IP access could close. The check now sends a one-time nonce that only this panel can answer, so only the panel itself counts.

- **A node joined to an old panel at the same address kept the old one.** Running the join command of a new panel that took over the old panel's domain said "Already joined" and never used the token. When the panel at that address refuses the earlier join, the installer now joins again with the token; an unreachable panel keeps the earlier join.

## After you update

- Update the nodes too: a node follows a moved panel only from 0.2.8 on, and the panel moves only to a node that runs its version.
- With a panel domain, point its DNS record at the new server after a move.
