# Seylo 0.2.6

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-6

## New

- **Drag to reorder.** Drag projects in the sidebar or on the dashboard, and services in the sidebar, on the dashboard (Cards and List) and on the project page. It is one order everywhere, kept on the server for each person, so it follows you to every device and nobody else's changes. New services go last. The keyboard works too: Tab to an item's handle, Space, the arrow keys, Space.
- **Build with**, in New app: for a GitHub or Git repository, pick Railpack, Nixpacks or Dockerfile (with its path) before the first deploy, so "Deploy right away" builds the way you want. A GitHub repository with a Dockerfile at its root starts on Dockerfile.
- **The installer asks** when you run `curl -fsSL https://install.seylo.dev | sudo sh` from a terminal without a mode: set up a new panel here, or join this server to a panel you have. For a join, paste the command from Nodes > Add node (or the panel address, then the token). The copied join command, scripts, cloud-init and CI run without questions as before; `SEYLO_NO_PROMPT=1` skips them too.
- **A service's Overview**: the console is as tall as the cards beside it (480 to 600 px), and the Domains card has a **+** to add a domain.
- **The Source tab** shows GitLab, Gitea and Bitbucket only once they are connected in Settings > Git providers (or when the service already uses one), with a link there to add one.

## Fixed

- **Choppy screens after opening a code editor.** Once the Environment tab, a Dockerfile source or the custom CSS editor had opened, the editor's theme was rebuilt on every frame, on every page, until a reload: about 1,000 style recalculations a second, a fifth of the browser's main thread. It now repaints only when the theme, the color mode, the accent or the custom CSS changes.
- The Environment tab loads the editor when you open it (not when you hover the link) and creates it after the page has eased in, so opening the tab no longer stutters.
- **A Docker update on a node** said "Rolling out vdocker" and could stay at 0 of 1 done. It now says "Updating Docker" and finishes as soon as the node is back with the new Docker version.

## After you update

- Your current project order stays. Services keep the order they had (by name) until you drag them.
