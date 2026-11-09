# Seylo

Seylo is an open-source, self-hosted deploy panel. One panel controls many
Linux servers ("nodes") and deploys apps, databases and compose stacks to
them: builds from Git, zero-downtime health-gated deploys, domains with
automatic HTTPS, logs, metrics, terminals, backups and more.

Each node runs one small Go agent that dials the panel over a single
WebSocket, so the panel never connects to a node and nodes need no inbound
port for the agent. Apps keep running, restarting and routing while the
panel is away.

Documentation: https://docs.seylo.dev (its source is the docs app in
[Seylo-dev/Website `apps/docs`](https://github.com/Seylo-dev/Website/tree/main/apps/docs))

> Status: early (0.x). The panel, the agent and the installer run end to end
> on test VMs (`make e2e`: 38 checks passed on 0.2.0, including an update
> from the 0.1.1 release with real data, and 0.2.1 adds checks 39 and 40;
> results in [test/e2e-colima/RESULTS.md](test/e2e-colima/RESULTS.md)). Releases start
> at v0.1.0, and the install command below installs the latest one.
> [CONTRACTS.md](CONTRACTS.md) ("Not built yet") lists what is missing or
> only tested against stand-ins (Let's Encrypt, real S3 buckets, the
> Anthropic API and MCP hosts, a real Pelican Wings node).

## Features

- **Sources**: GitHub (per-panel GitHub App, push to deploy, PR previews),
  any Git host with a token or deploy key, Docker images (public or with a
  registry login), a Dockerfile typed in the panel, an uploaded archive.
- **Builds**: Railpack (default), Nixpacks or a Dockerfile, on any node
  allowed to build. Images go to a registry on the panel's node and run on
  any node, pulled by digest.
- **Deploys**: start the new version, health check it, switch the route,
  stop the old one. A failed health check keeps the old version live.
  Deploy history and instant rollback to an earlier image.
- **Crash policy**: restart after a fixed 5 s, or stop after N crashes;
  crash reports with the exit code, an out-of-memory flag and the last log
  lines; one alert per crash streak.
- **Databases**: Postgres, MySQL, MariaDB, MongoDB and Redis on the
  project's private network, with internal and TLS-exposed connection URLs,
  on-demand web UIs, a pre-logged-in shell and backups to S3 or R2.
- **Compose stacks** run by the agent, and a template catalog in
  Easypanel's format (our own templates).
- **Networking**: a private Docker network per project, automatic domains
  from one wildcard record per node, custom domains with Let's Encrypt,
  paths, basic auth, IP allowlists, rate limits and redirects, first-run
  IP:port access that closes once a domain is live, timed exposes locked to
  an IP, Cloudflare tunnels, maintenance pages.
- **Many nodes**: move a service with its volumes to another node, replicas
  across nodes behind one entry node (mutual TLS between nodes), per-node
  health checks and disk alerts, agent and Docker updates and reboots from
  the panel. Nodes move to the panel's domain by themselves once it is
  live.
- **Operate**: logs kept across deploys with search, a console (stdin), a
  shell, a file browser for every volume, metrics with 30 days of history,
  cron jobs, uptime checks, alerts to email, webhooks, Discord, Slack,
  Telegram, ntfy, Pushover and Gotify.
- **People**: email and password, two-factor codes, passkeys, GitHub
  sign-in, invites with per-project and per-service permissions, scoped API
  keys, an activity log of every change. Adding a sign-in method or a key,
  approving a CLI sign-in and, from the browser, handing out admin or node
  access need a sign-in from the last 15 minutes ("Confirm it's you").
- **Automation**: every action is one operation that is also a REST route
  (`/api/v1/<action>`, OpenAPI in `openapi.json`), an MCP tool (read-only
  by default, deletes need a person's approval) and a tool for the built-in
  AI assistant (Anthropic API key required). A laptop CLI covers sign-in,
  deploy, logs, env and tunnels.
- **Self-hosting**: a one-line installer, signed releases, one auto-update
  switch for the panel and every node with rollback, Docker cleanup that
  only touches what Seylo created, theme presets and white labelling.
- **Next to Pelican Wings**: shares the Wings fork's Traefik and gives game
  servers first claim on the CPU. Tested with a stand-in Traefik only so
  far.

## Install

On a Linux server (x86-64 or ARM64, systemd, kernel 5.6 or newer, cgroup v2):

```sh
curl -fsSL https://install.seylo.dev | sudo sh
```

The installer checks that ports 80 and 443 are free, verifies the signed
release manifest (OpenSSL 3 or minisign), installs Docker if you agree (23
or newer is needed; snap Docker is not supported), turns on Docker's
live-restore, starts the panel and a node on that server and prints a
one-time setup link. Add more servers from the panel's Nodes page: the join
command connects over HTTPS with the panel's key pinned.

The laptop CLI is the same binary. Download the build for your system from
the [latest release](https://github.com/Seylo-dev/App/releases/latest) and
check it against the signed `checksums.txt` before you run it (needs
[minisign](https://jedisct1.github.io/minisign/); on Linux use
`sha256sum -c -` instead of `shasum -a 256 -c -`):

```sh
base=https://github.com/Seylo-dev/App/releases/latest/download
f=seylo_darwin_arm64   # or seylo_darwin_amd64, seylo_linux_amd64, seylo_linux_arm64
for x in checksums.txt checksums.txt.minisig "$f"; do curl -fsSLO "$base/$x"; done
minisign -Vm checksums.txt -P RWTwvrETQsecIkFOCm1ceiZwfxVq6sFfiEmJfWnUVv7UBIn0jWm2h1ip
awk -v f="$f" '$2 == f' checksums.txt | shasum -a 256 -c -
chmod +x "$f" && sudo mv "$f" /usr/local/bin/seylo
```

`RWTwvr...` is the release key; [SECURITY.md](SECURITY.md) explains what is
signed and how to check a download on Windows. Or build the CLI with
`go install github.com/seylo-dev/app/go/cmd/seylo@latest` (such a build
reports version `dev`).

## Repository layout

| Path | What |
|---|---|
| `brand/brand.json` | Product name, slug, paths and URLs; everything else is generated from it |
| `proto/` | Agent <-> panel protocol (protobuf, managed with buf) |
| `go/` | The `seylo` binary: node agent, node CLI and laptop CLI |
| `apps/panel` | Panel API (Bun + Elysia, SQLite) that also serves the web app |
| `apps/web` | Web app (Vite + React) |
| `packages/` | Shared TypeScript: generated protocol and brand, operation registry, env analyzer, UI |
| `installer/` | One-line installer (`installer/test` runs it against a fake signed release) |
| `deploy/`, `.goreleaser.yaml` | Panel image and release build |
| `templates/` | One-click template catalog |
| `test/e2e-colima` | End-to-end test on three VMs |
| `test/playwright` | Browser tests of the web app |
| `tools/brandgen` | Generates brand constants for Go, TypeScript and the installer |

See [CONTRACTS.md](CONTRACTS.md) for conventions, the protocol and how the
pieces fit together.

## Development

Requirements: Go 1.27, Bun 1.4, [buf](https://buf.build) and `make`.

```sh
make install   # JS dependencies
make build     # bin/seylo, the web app and the panel
make test      # Go (-race), TypeScript and installer tests
make lint      # buf, gofmt, vet, staticcheck, Biome, tsc
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers running the panel from source,
generated code, the Docker integration tests in a VM, the browser tests and
the three-VM end-to-end test (`make e2e`).

## Contributing and security

Contributions are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). Changes
to the documentation go to the docs app in the Website repo,
[Seylo-dev/Website `apps/docs`](https://github.com/Seylo-dev/Website/tree/main/apps/docs).
Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md)
(GitHub's private reporting, or security@seylo.dev), which also covers the
threat model, where secrets live and how releases are signed.

## License

[AGPL-3.0](LICENSE). Parts of the node agent are ported from Pelican Wings
(MIT); those files keep their original notices, and [NOTICE](NOTICE) lists
them with the license text.
