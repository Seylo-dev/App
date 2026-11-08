# Seylo 0.2.1

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-1

## New

- **The panel on your tailnet.** Settings > Tailscale serves the panel at `https://<machine>.<tailnet>.ts.net` through the Tailscale already on the panel's server. Install it from the panel node's Shell view, sign the server in from the card, then turn on "Serve the panel on my tailnet". Seylo stores no Tailscale key. Needs Tailscale 1.104.4 or newer. Docs: https://docs.seylo.dev/self-hosting/tailscale
- **Close the panel's IP address.** The Panel domain card in Settings > General has "Serve on IP address" and "Agents' port". Off, `http://<server-ip>:3000` and port 3443 answer only on the server itself, which ufw can't do for ports Docker publishes. Only the owner turns them off, from the panel domain or the tailnet. If that way in stops working, IP access reopens by itself (unless you choose "Keep IP access closed"), and `sudo seylo panel ip-access on` on the server always gets you back in.
- **Lock to Tailscale**: one checklist, opened on the tailnet address, that closes IP access and, if you like, removes the panel domain.
- **Check now** for the panel domain, and panel domains behind Cloudflare's proxy.
- `seylo panel status` shows how the panel's ports are published and its tailnet address. `seylo panel tailscale status|off|on` works without the panel.
- **Hide project** in a project's menu takes it out of your own sidebar and home page, for example the Panel project. "Hidden (N)" shows them again.
- A click anywhere on a copy field copies it.

## Changed

- **New nodes build images by default.** Add node has "Build images on this node", ticked by default, and the join command carries the choice. This partly reverses a fix from the 0.2 security audit: whoever runs a default join command gets a build node, and a build node receives the source, git credentials and build-time variables of every service it builds, from any project. Untick the box for servers you don't fully trust. Limits: the choice is made and audited when the command is created (owner or admin, recent sign-in), the token is single-use for one hour, the node can't change its own setting, and services build on their own node first. Services on nodes that join with the default now build there, not on the panel's node.
- Join commands made before this update, and nodes that joined before it, keep 0.2.0's behavior (no builds). Turn on Can build under Nodes for the ones that should build.
- Automatic builds skip nodes without docker buildx. Such nodes show "docker buildx is missing" next to Can build: install `docker-buildx-plugin` there.
- **The installer installs Docker when it is missing**, without asking, on a terminal or not. `--no-docker-install` stops instead. A Docker that is installed but does not start now stops the installer with what to check.
- The installer's output has colors and a closing block with the setup link and the next step. Logs and pipes still get plain text.
- A join waits up to a minute for the agent to connect and says how it went. A join the panel refused (used or expired token, wrong pin) exits with status 3.
- No more orange "This connection is not encrypted" box. Plain HTTP pages show one line you can dismiss; setup and sign-in show nothing.
- Removing or changing the panel domain asks first when nodes connect over it, and names them.

## Fixed

- An update's agent step on the panel's own node could hang and fail after 10 minutes ("The update did not finish in time."). A busy node now gets its update again.
- An update step that timed out raised no alert. It now does, a node's step is tried once more after 5 minutes, and the alert resolves when the node gets there.
- IP:port addresses could drop or hang requests for about a second around each deploy.
- Settings > Updates on a release candidate no longer says it stays on the pre-release before the first check.

## Before you update

- Nodes before 0.2.1 keep working. The new panel access and Tailscale features need the panel node's agent on 0.2.1, which the update installs.
- If you plan to close IP access, update Docker to 28 or newer on the panel's server first.
