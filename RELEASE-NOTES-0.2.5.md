# Seylo 0.2.5

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-5

## New

- **AI assistant chat.** A chat bubble on every page and an **Assistant** page in the sidebar (Settings > AI assistant > Assistant page, on by default). Each person has their own chats with history. What the assistant does shows as action cards. A change that needs an approval shows as an approval card in the chat, the same request as on the Approvals page, so deciding in either place decides both; the Approvals page now shows where each request came from (Assistant and the chat, or MCP and the token). **Auto** mode, per person and kept across chats and devices, runs changes without asking, with your own permissions.
- **Personal details** in Settings > Your account, above Security: your name, your email (changing it asks you to confirm it's you), and your avatar: upload an image, or pick a generated face by style and Randomize. Every account gets a random face. Avatars show in the sidebar, People, Activity and Approvals.
- **Preferences** in Settings > Your account: hide the sidebar's Hidden (N) group, and take Dashboard, Nodes, Templates, Activity, Assistant or Approvals out of the sidebar. Settings always stays; Approvals comes back while a request waits for you.
- **Appearance**: ten presets (Default, Classic, Midnight, Graphite, Clay, Harbor, Orchid, Steel, Marigold, Meadow), each with a light and a dark version, so Light, Dark and System work with every preset. System follows your device, also when it switches. The accent color now also sets links, focus rings, the selected sidebar item and button hovers, with readable text on any accent. Custom CSS has a short guide and an **Insert example** button. Branding shows the built-in logo and favicon when none is uploaded.
- **Dashboard**: a greeting for the time of day, counts as chips, projects as **Cards** (the default), **List** or **Table** (remembered per browser), and a **Live** chip on the Nodes card (on by default) with smooth 2-second graphs while you watch.
- **Service usage**: CPU, memory and network each open their last 30 minutes, with a small graph in each cell.
- **Node location** is filled in from the node's public IP when it joins (Geolocation by DB-IP), marked **Detected** until someone saves the field. Not done after the installer's `--no-telemetry`, or with `SEYLO_TELEMETRY=off` or `DO_NOT_TRACK=1`.
- **Docker version check**: nodes look for a newer Docker Engine once a day. The Machine card shows the version in amber with a "?" when one is available; **Update Docker** is off when there is nothing newer.
- **MCP**: one-click install links for popular AI tools. "Ask before destructive actions" and read-only by default stay on by default and can be switched off.
- **Domains behind Cloudflare's proxy**: the Domains tab shows each domain's DNS state with the IP its record should point at, and an origin check tells whether the record in Cloudflare reaches this service's node. A certificate stuck on Generating says why.
- **Templates** show the apps' real logos.

## Changed

- **Faster page changes.** Pages start loading their data when you hover or focus a link, and the service screens no longer wait for the service before asking for their own data. Live updates refetch only the project, service or node they are about (before, one container change refetched every project's services on screen), a running build no longer refreshes the open screens every second, and a page change no longer redraws the sidebar.
- **Scheduled Docker cleanup is on by default**: daily at 04:00 node time and when a disk passes 80%. Settings > Docker cleanup shows the last cleanup.
- The panel allows each person 300 requests at once and 50 a second (was 120 and 20): a 0.2.5 screen asks for more at once, and a few quick reloads showed "Too many requests". Sign-in keeps its strict limit.
- **Regenerate certificate** refuses while the origin check finds that something other than the node answers for the domain, and names the IP to point the record at.
- The **Game servers first** column on Nodes shows only when a node runs next to Wings.
- Settings > AI walks through getting an Anthropic API key, with links.
- Opening a new panel without its setup link tells you to run `seylo panel setup-link` on the server.

## Fixed

- The dashboard showed "No projects yet" when the projects list failed to load; it now shows the error.

## After you update

- Nodes that never had their cleanup schedule changed get scheduled cleanup turned on.
- Nodes with an empty Location get one looked up once.
- People who may use the assistant see its chat bubble. Turn the Assistant page off in Settings > AI assistant, or hide it from your sidebar in Settings > Preferences.
- The Midnight and Classic presets now have both a light and a dark version; panels that used them keep the look they had.
