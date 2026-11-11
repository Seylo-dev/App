# Seylo 0.2.8

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-8

## New

- **Move the panel to another server.** The owner moves the panel to another node in Settings > General > Move the panel to another server. Everything moves: the database, the master key, the agents' TLS key, branding, uploaded sources and the image registry with every built image. The panel is read-only for the few minutes it takes and apps keep running. It starts the panel on the new server and checks it before anything switches, tells every node the new address ahead of time, and nodes follow on their own with the pin they already trust, so nothing has to be joined again. Until the new server confirms the switch, the moved panel turns nodes away, so a node that loses the old panel for a moment comes back to it. If any step fails before the switch, the move rolls back and the panel carries on where it was. The old server keeps a stopped copy until you press Delete the old copy on the moved panel. Nodes that are offline or connect over plain http:// cannot follow: the check names them, and you can move anyway and join them again with `seylo join --force`.

## Fixed

- **The panel domain could go active for another server.** The check took any `{"status":"ok"}` answer from `https://<domain>/api/health` as the panel's, and a Cloudflare-proxied record skips the address check. So a proxied domain still pointing at another server (an old panel, or any app with that health route) went active: `http://<ip>:3000` redirected people there, and with Serve on IP address off, IP access could close. The check now sends a one-time nonce that only this panel can answer, so only the panel itself counts.

## After you update

- Update the nodes too: a node follows a moved panel only from 0.2.8 on, and the panel moves only to a node that runs its version.
- With a panel domain, point its DNS record at the new server after a move.
