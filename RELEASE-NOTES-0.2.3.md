# Seylo 0.2.3

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-3

## Changed

- **One deploy of a service at a time.** While a deploy is in progress, **Deploy** in the service header says **Deploying** and waits, and **Roll back** and the **Redeploy** items on the Deployments tab are off until it ends. The API, the CLI and MCP get `409 CONFLICT` with reason `deployRunning`, the id of the deploy in progress and its `serviceId` (a member's, for a compose stack). Before, each click queued another deploy behind the running one. Pushes, trigger URLs and archive uploads still wait in line behind a running deploy, so no push is lost. `deployments.list` takes `active: true` for the deploys in progress, oldest first.
- **Cancel deploy** in the header stops the deploy in progress. Before, it cancelled the newest one, which could be a queued deploy while the running one went on.
- **PORT for every built app.** An app built from a repository gets `PORT=<its first port>`; with no port, the port its domains point at, else 80; unless its `.env` sets `PORT`. Apps created before 0.2.2 get it too: on 0.2.2 they got none, so a Next.js app with no port kept listening on 3000 while its domain pointed at 80. New domains, Cloudflare tunnels, previews, clones, the timed IP:port expose and the health check form start from the same port (`appPort` on the service), and the Overview shows it as "80/tcp, as PORT".
- **Add domain**: on a service with no port, an empty **Container port** is that port (it suggested 3000), and the first domain of a service has **Make it the primary domain** ticked and locked, since the panel makes it primary anyway. In Edit routing, an empty field keeps the domain's port.
- **The Source tab's GitHub repository field takes a link or `owner/repo`**, looked up by name through the picked account, so a repository the list does not show works too. A `.../tree/<branch>` address picks that branch. Enter picks, and never connects. Text that only filters the list shows no error.
- **Overview**: the console is on top and taller, above Deploys, and **Last hour** moved to the right column under Domains.
- The deploy log window is wider.

## Fixed

- Through the GitHub App, any public repository connected through any installation, and its pushes never arrived: the App's webhook only covers the repositories the installation includes. Such a repository is now refused (`NOT_FOUND`, reason `notOwned`), and the Source tab names the Account that reads a typed repository of another owner.

## After you update

- An app built from a repository that had no `PORT` gets one on its next deploy: its first port, its domains' port, or 80. If an app must listen elsewhere, set `PORT` in its `.env` before you deploy it.
- Scripts that call `deployments.deploy` while another deploy of the same service runs now get a `409`. Wait for the running deploy (`deployments.get`, or `deployments.list` with `active: true`) or cancel it first.
