# Seylo 0.2.24

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-24

## New

- **The visitor's country, as a request header.** Every request Traefik sends to an app now carries `X-Seylo-Country`: the visitor's country as two upper-case letters (ISO 3166-1 alpha-2), `XX` when it is not known. An app can pick a currency, a language or a store from it without a lookup of its own and without Cloudflare in front. On by default.
  - Visitors cannot set it. Traefik deletes any `X-Seylo-Country` the visitor sent, and every spelling an app could read as the same header (`X_Seylo_Country`, `X.Seylo.Country`, ...: CGI, PHP and nginx turn them all into `HTTP_X_SEYLO_COUNTRY`).
  - The country comes from the visitor's address (`X-Real-Ip`). Behind Cloudflare's proxy it is the visitor's, from `CF-Connecting-IP` on requests from Cloudflare's addresses, not the country of Cloudflare's server. A request served by a copy on another node gets the same country.
  - Each node keeps DB-IP's IP to Country Lite database (CC BY 4.0, no account) in memory and downloads the new one every month. With a MaxMind account (Settings > General > Visitor country), nodes use MaxMind's GeoLite2 Country when DB-IP cannot be downloaded.
  - A lookup takes well under a millisecond. It runs as its own small systemd service (`seylo-geoip`) apart from the agent, so agent updates and restarts never touch requests; its socket holds the port while it restarts.
  - Off for every app in Settings > General > Visitor country, or for one service on its Domains tab (Visitor country). Off, a visitor's own `X-Seylo-Country` is still deleted.
  - The node health check **Visitor country header** says whether the lookup answers and how old its database is. On a node: `seylo geoip status` and `seylo geoip lookup <ip>`.
  - Works next to Wings: the Wings fork's Traefik reads it from Seylo's route files and needs no change.

## After the update

- Nothing to run by hand: no migration. The header needs each node's agent 0.2.24; Settings > General lists the nodes that are not there yet.
- Every route file is written again once with the new middleware when the agent updates; Traefik reloads them without a restart.
- On a node with ufw active, the agent adds one rule so Traefik reaches the lookup on the `seylo-edge` bridge, the same kind the installer adds for the edge listener's 5756: `ufw allow in on seylo-edge to any port 5758 proto tcp`. New installs get it from the installer. The agent checks the path from inside Traefik's container before any route file asks the lookup, so a node with another firewall that drops it gets no header (requests are never held up) and its health check says what to allow.
- Each node downloads DB-IP's file (a few MB) from `download.db-ip.com` over HTTPS right after the update. Until that finishes (seconds), apps get `XX`. A node whose outbound HTTPS is blocked keeps answering `XX`, and its health check says why.
- Apps that read the header should treat `XX`, and a missing header (a node not updated yet, or the header turned off), as unknown.
