# Seylo 0.2.25

Update from Settings > Updates: the panel updates first, then each node. Nothing to run on the servers. New installs: `curl -fsSL https://install.seylo.dev | sudo sh`.

What's new in full: https://docs.seylo.dev/self-hosting/whats-new-in-0-2-25

## New

- **Wildcard domains.** A domain can be `*.example.com`: every name one level under `example.com` (`shop.example.com`, `north.example.com`) reaches the service, with the domain's port, path, access rules and redirect to HTTPS. Not `example.com` itself, not `a.b.example.com`. Exact domains, on any service, always come first. Create one DNS record named `*`.
  - The DNS check looks up a random name under the base (`seylo-check-<random>.example.com`), so only the `*` record answers it, and names the record to create `*`. The origin check through Cloudflare asks such a name too.
  - Let's Encrypt cannot issue wildcard certificates over its HTTP check and the panel never asks for a DNS provider token, so a wildcard gets no Let's Encrypt certificate. Behind Cloudflare's proxy that does not matter: visitors get Cloudflare's certificate, and SSL/TLS Full accepts the node's default one (the row reads "Cloudflare's certificate"). With DNS straight to the node HTTPS warns (the row reads "No certificate" and says what to do). For Full (strict), upload a certificate that names `*.example.com` itself, such as a free Cloudflare Origin CA certificate.
  - A wildcard is never the primary domain. `DOMAINS` lists it as written.
  - Refused: a wildcard over a public suffix (`*.co.il`), over a node's wildcard domain for automatic domains, over the panel's own domain, and on the panel's own service. An exact name under another service's wildcard, or a wildcard over names another service has, needs the right to edit that service's domains.
  - API and MCP: `domains.add` takes `host: "*.example.com"`; `domains.list` returns `wildcard: true` and `certificate.wildcard` (`cloudflareEdge` or `noCertificate`); `domains.checkDns` returns `probe`.
  - Works next to Wings: the wildcard comes after every exact domain and before the Wings fork's redirect of unknown names to HTTPS.

## After the update

- Nothing to run by hand: no migration.
- Wildcard domains need each node's agent 0.2.25 (it advertises `routing.wildcard-hosts.v1`). The panel sends a wildcard only to nodes that advertise it; an older node leaves it out, keeps serving the service's other domains, and the row reads "Update `<node>`".
