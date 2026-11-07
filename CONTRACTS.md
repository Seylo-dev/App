# Contracts

How the pieces of this repository fit together and the rules every change
follows. Keep it current when you change a contract. Setup, make targets and
the test suites are in [CONTRIBUTING.md](CONTRIBUTING.md); user docs live at
https://docs.seylo.dev.

## Repository map

```
brand/brand.json          product identity; the only place the name, slug, paths and URLs are typed
tools/brandgen/           Go program: brand.json -> go/gen/brand, packages/brand/src, installer/brand.env
proto/seylo/agent/v1/     agent <-> panel protocol (see proto/README.md)
buf.yaml, buf.gen.yaml    buf lint/breaking config and codegen (Go + protobuf-es)
go/                       Go module github.com/seylo-dev/app/go (go.mod here so Go never walks node_modules)
  cmd/seylo/              main: signal handling, then internal/cli
  gen/brand/              generated brand constants          (do not edit)
  gen/pb/                 generated protobuf Go code          (do not edit)
  internal/               see "Go packages" below
apps/panel/               Bun + Elysia panel: op API, agent hub, live socket, jobs, SQLite; serves the web app
apps/web/                 Vite + React 19 + TanStack Router/Query web app
packages/brand/           generated brand constants for TypeScript (@seylo/brand)
packages/proto/           generated protocol + frame codec for TypeScript (@seylo/proto)
packages/ops/             operation registry: contracts, generators, typed client (@seylo/ops)
packages/ui/              UI kit (shadcn-style components) and design tokens (@seylo/ui)
packages/env-analyzer/    .env parser with source ranges, ${{svc.VAR}} references, cross-node diagnostics, literal host names (`hostMentions`) (@seylo/env-analyzer)
installer/                install.sh.tmpl + generated brand.env and install.sh (scripts/render-installer.sh)
openapi.json              generated from the op registry (scripts/gen-openapi.ts)
biome.json                TypeScript/CSS formatting and lint rules
scripts/                  codegen helpers and the generated-code check
deploy/panel.Dockerfile   panel image: Bun runtime + the built panel and web app (`make panel-image`)
.goreleaser.yaml          release build (signs nothing); scripts/release-manifest.sh writes the update manifest and scripts/release-sign.sh signs it and checksums.txt
test/e2e-colima/          three-VM end-to-end harness and checklist (`make e2e`, results in RESULTS.md)
test/playwright/          browser tests (`test/playwright/run.sh`)
.github/workflows/ci.yml  CI on GitHub's runners: check-gen, lint, test, build (publishes nothing)
.github/workflows/release.yml   tag releases: Draft release (unsigned), Sign (the only job with the release key, environment `release`), Publish
.gitleaks.toml            secret scan config: gitleaks' default rules plus the known fake test secrets
templates/                one-click template catalog (meta.yaml + index.ts per app; README.md has the format)
```

The Go module path is `github.com/seylo-dev/app/go` (lowercase, as Go
module paths are; the repository is github.com/Seylo-dev/App) with `go.mod`
in `go/`, so `go install github.com/seylo-dev/app/go/cmd/seylo@latest`
builds the CLI. Releases ship through goreleaser. `tools/brandgen` is its
own small module, `github.com/seylo-dev/app/tools/brandgen`. Linker flags
(`-X <module>/internal/version.Version=...`) take the path from `go/go.mod`
(the Makefile's `GO_MODULE`), never from brand.json.

### Go packages (`go/internal`)

Each package has a `doc.go` that states its job and the interfaces other
packages use. "Built" means implemented and tested.

| Package | Job | State |
|---|---|---|
| `conn` | Frames, stream ids, credit windows, control-first writer, WebSocket transport with SPKI pinning, trust on first use (`ServerSPKI`), `Pinger`/`Abort`, `ParsePin`/`FormatPin`, in-memory `Pipe` | Built |
| `rpc` | Calls and streams over `conn`: `Session` (CALL/RESULT with deadlines and cancel, OPEN/DATA/WINDOW/CLOSE with credit flow control, panic recovery, `Stats`, `Abort`), `AgentHandshake`/`PanelHandshake`/`HelloSignedBytes`; handler registry `Mux` (`HandleUnary/Stream/Raw`), `Peer`, `Stream`, `Link`, `PanelClient`, `Emitter`, `Error`/`StatusOf`; `rpc/rpctest` in-process harness and `FakePanel` | Built |
| `stub` | `stub.NotImplemented(feature)`, the typed "not built yet" error | Built |
| `datadir` | On-disk layout of `/var/lib/seylo` | Built |
| `docker` | Docker Engine access; names and `seylo.*` labels | Built: `Engine` over the moby client (`Moby`), `dockertest.Fake` for unit tests |
| `systemd` | `systemctl`/`journalctl` for the agent unit (`Units`, `Journal`), the `seylo.service` and `seylo.slice` unit files (`InstallUnits`) | Built |
| `version` | Build version (ldflags) | Built |
| `nodecheck` | Node "Health check" (formerly Doctor): `Check`, `Run`, `Default(Env)` with 16 checks (kernel, OS, memory, disk, inodes, Docker, cgroups, Docker live-restore, ports 80/443, proxy, route files, DNS, firewall, clock, panel, Wings), read-only Docker socket client | Built (also run against the real test VM) |
| `cli` | Cobra command tree: node (`agent --join`, `join`, `status`, `health`, `troubleshoot`, `panel start|status|logs|setup-link`), laptop (`login`, `logout`, `deploy`, `logs <svc>`, `env`, `tunnel`), hidden `panel bootstrap`, `install-units`, `update-guard`. Builds for linux, darwin and windows (amd64/arm64, `cmd/seylo` `TestCrossBuild`): node commands are `//go:build !windows` (Windows gets stubs, so no agent package is compiled there) and answer "runs on a Linux server" off Linux | Built |
| `agent` | Daemon composition root: `Run` (config.yml, agent key, join/resume, reconnect with backoff and jitter, moves to the panel's new address (`move.go`), heartbeat, outbox drain, machine facts, DISK_LOW alerts (`disk_alert.go`), local API), `Join`, `Wire`, `Deps`, `Components`, `Facts`, one `wire_<area>.go` per area | Built |
| `localapi` | Agent unix-socket API (HTTP, 0600): `Serve`/`Handler`/`Backend` in the agent, `Client` for the node CLI | Built; panel start/logs answer NOT_IMPLEMENTED until `Deps.PanelControl` is set |
| `panelapi` | Laptop CLI client for the panel op API (hand-written over the contracts, not generated), saved logins in `~/.config/seylo/config.json`, `SEYLO_PANEL_URL` + `SEYLO_TOKEN` for CI | Built (tested against a fake panel) |
| `troubleshoot` | Redacted Markdown report + upload to `<site>/l`; exact secret values from the persisted desired state (`crash.SecretValues`) are stripped before the shape-based pass, and an upload prints which sections it contains | Built (uploads verified against the site API) |
| `state` | `FileDesiredStore`, `DesiredSync` (revision rules, save then publish), `MemoryStore` (actual state, epoch/seq; in memory by design), bounded `FileOutbox`, `Reporter`, `DesiredFeed`, `WriteFileAtomic` | Built |
| `reconcile` | Converge to desired state, health-gated deploys, rollback, adoption by labels, `Resolve`, `SetSleeping`, moving running containers to another project's network without a restart (`reattach.go`) | Built (`Runtime`; the project move verified in the VM, `TestITMoveProjectReattach`, `TestITMoveProjectInterruptedLeavesTheOldNetwork`) |
| `crash` | Crash policy and reports | Built (`Streaks`, `Redact`) |
| `health` | Service health probes | Built (`Probes`, `Watch`) |
| `volumes` | Volume export/import (.tar.gz through `os.Root`) for moving services; `WriteArchive` for any archive of a live volume (walks through `os.Root`, checks each opened file against its listing, so symlink swaps mid-walk never reach host files) | Built (`Transfer`, `WriteArchive`) |
| `proxy` | Traefik route files (`Build`, `FileRouter`: atomic write, `Verify` probe through Traefik, `Status` from acme.json, Traefik's log (`CertFailures`, `WatchCertFailures`: CERTIFICATE_FAILED with the CA's reason) and DNS, certificate issuer and expiry, `RetryCertificate` (renames one route's routers so Traefik runs ACME again, no restart), `Certificate`, `ProxyContainers`), the agent's own Traefik (`Traefik.Ensure`), the LB-only Traefik next to Wings (`LBOnly`, `FileConfig.LBDir`), `MobyDocker` for networking's Docker calls | Built (routing, middlewares, custom and ACME certificates and ACME failures via Pebble, a failed host fixed and retried to a certificate in both modes (`TestIntegrationACMERetry`), switch under load, shared Wings Traefik plus the LB Traefik verified in the VM) |
| `edge` | Agent HTTP listener on the `seylo-edge` gateway: maintenance/status pages, tool sessions from panel-signed tickets (`Verifier`, `Tools`), cookie handoff | Built (Box ticket flow, tool host and handoff through Traefik verified in the VM) |
| `portgate` | Agent-owned IP:port TCP relays from the desired state (`SyncAll`, `ListenersFor`): allow lists, local expiry, redirect-then-close, TLS termination for exposed Mongo, Redis, Valkey, KeyDB, Dragonfly and ClickHouse's native port (`dbengine.TLSAtGate`, `Config.Certificate`, `OpenPort.tls`), per-listener and per-source connection caps, idle cut-off (15 min, databases 2 h), one shared `Resolve` per container port every 2 s | Built (relay to a container, allow list, redirect and expiry, redis-cli/valkey-cli `--tls`, mongosh `tls=true` and clickhouse-client `--secure` through the gate verified in the VM) |
| `build` | Railpack/Nixpacks/Dockerfile builds: git/upload/inline/image sources, capped buildx builders (one per project), FIFO queue (`max_parallel_builds`), detached jobs with replayable output, push to 127.0.0.1:5755, local image and cache retention. Every variable reaches Railpack and Dockerfile builds as a BuildKit secret (Dockerfile builds also get the non-secret ones as build args); Nixpacks builds see only non-secret variables (it bakes every variable into the image), the build log says so. The panel's `EnvVar.secret` is a real classification (`@seylo/env-analyzer` `isSecretEntry`: `# @public`/`# @secret` comment, name, value, references to secrets; `EnvGraph.isSecret`) | Built (Docker builds verified in the VM) |
| `registry` | 127.0.0.1:5755 relay over RegistryTunnel (`TCPRelay`), `Tunnel` handler (registry and service-port targets; a `RegistryTarget.scope` makes it an HTTP-aware gate: only the node's pull/push repositories, never DELETE of content, the catalog or foreign blob mounts), the registry container on the panel's node (`Server`, GC) | Built (push/pull through the relay, and scoped push/pull/refusals with the real Docker and registry, verified in the VM) |
| `compose` | `Parse` for ParseCompose: compose-go normalized project JSON + unsupported-feature warnings; never reads node files | Built |
| `logs` | Per-service log store on disk (text segments, size and age retention), capture from Docker across generations with a restart cursor, follow, search, build logs | Built (capture, follow and restarts verified in the VM) |
| `metrics` | Node usage from /proc, per-service Docker stats (memory = usage - inactive_file), an hour of history, live watch | Built (verified in the VM) |
| `console`, `shell` | Attach to the main process with history replay; PTY shells, database clients (via `dbtools`) and one-shot Exec through docker exec, with a marker-based process sweep; `ConsoleInfo` and the first `ShellResponse.info` carry user and working directory; `console/dockerapi` is the small Docker client the observe area shares (kept apart from `docker.Engine` on purpose, see Not built yet) | Built (verified in the VM) |
| `fs` | Volume file access through `os.Root` (no `..` or symlink escape), atomic uploads, tar.gz/zip archive and extract | Built (escape fuzzing run as root in the VM) |
| `cron` | On-node scheduler (`Local`): ServiceSpec.cron_jobs and SERVICE_KIND_CRON in one-off containers (service image, env, volumes, project network), 5-field schedules in IANA time zones, timeout, forbid/allow/replace, `RunNow`, CronRun results with the last 100 lines (secrets redacted) through the outbox; a job whose schedule it cannot read is reported once as a failed CronRun (`unreadable-<hash>`) instead of being skipped silently | Built (runs, failure, timeout, skip verified in the VM) |
| `backup` | Volume .tar.gz archives and dumps (pg_dump/pg_dumpall, mysqldump/mariadb-dump, mongodump, redis-cli/valkey-cli/keydb-cli --rdb; Dragonfly `SAVE RDB <run>` and ClickHouse `BACKUP ... TO File()` into the data volume, read and deleted by a helper that mounts the volumes) in helpers from the database's own image, streamed multipart to S3/R2/MinIO (minio-go), `keep_last` retention, restores (staging folder swap, pg_restore/psql/mysql/mongorestore, the RDB swap of the Redis-like engines, ClickHouse: rename the databases the zip holds to `<name>__seylo_pre_restore_<time>`, `RESTORE`, then drop the renamed copies; a failed `RESTORE` drops what it created and renames them back, names passed as `Identifier` query parameters), `SleepSuspend` with crash-safe markers (a volume restore stops every service that mounts the folder, compose members included; a stop-service volume backup stops every writer), BackupProgress. RDB restores move every append-only file aside as `<name>.before-restore-<time>` (the copies of earlier restores are deleted once a restore is in place, so a volume keeps one undo) and also write the RDB as `appendonly.aof` (an RDB preamble, without the 40-byte diskless EOF marker `redis-cli --rdb -` leaves): with `--appendonly yes` the server would start empty otherwise | Built (every engine, Postgres 18, pgvector 15 to 18, Valkey 8.1, 9.0 and 9.1, ClickHouse 26.3 and 26.8, Redis with append-only, and volumes round-tripped through MinIO in the VM; truncated and incomplete ClickHouse zips fail and leave the databases as they were) |
| `tunnel` | Cloudflare tunnels (`CloudflareDocker`): cloudflared on the project network, quick trycloudflare.com tunnels (URL from the log, kept current) or token tunnels, supervised; `Relay` interface for the Tunnel RPC | Built (quick tunnel served a page end to end from the VM) |
| `cleanup` | Prune managed resources only (`Local`, rules in `Plan`): stopped job/old-generation/orphan containers, images past the newest 3 per service, volumes and services/<id> data of removed services, orphan project networks; dry run with sizes; build cache only through the builder's `CachePruner`. `LocalScheduler` runs `NodeSettings.cleanup` by itself: a cron expression in the node's time zone and a disk line fed by the disk checks, each run a durable `CleanupRun`; an expression it cannot read is one failed `CleanupRun` per changed schedule | Built (unlabeled look-alikes survive, verified in the VM; the disk trigger on a filled tmpfs in the VM) |
| `hostshell` | Root login shells on the node itself for HostShell: a PTY from /dev/ptmx (`golang.org/x/sys/unix`), the agent user's login shell from /etc/passwd in a new session with a clean environment, `Manager` with the `Allowed` gate, at most 2, 15 minutes idle, `CloseAll` when the setting turns off, hang-up of the process group on close; Linux only | Built (PTY, cap, idle and close-all verified as root in the VM) |
| `dbtools` | On-demand database web UIs (pgweb, phpMyAdmin, mongo-express, Redis Commander for every Redis-like engine, and ClickHouse's own Play page behind `nginx:1.30.6-alpine`, which sets the admin's Basic header on every request, replaces the Authorization and X-ClickHouse-* headers and refuses credential URL parameters (`user`, `password`, `quota_key`, or any percent-encoded parameter name) with 403) signed in from the spec, stopped when idle; `ClientCommand` for pre-logged-in shells (psql, mysql/mariadb, mongosh, redis-cli, valkey-cli, keydb-cli, clickhouse-client); `ExposedUsers` creates/rotates the exposed user (ClickHouse: `CREATE USER ... sha256_password` and `GRANT ALL` on the database) and makes it TLS-only (Postgres: certificate + ssl + hostssl block; MySQL: SET PERSIST certificate + REQUIRE SSL; MariaDB: REQUIRE SSL on its own certificate), with the edge's ACME certificate for `tls_hostname` or a kept self-signed one | Built (all UIs, Postgres 18 included; exposed users, TLS-only logins and rotation in Postgres/MySQL/MariaDB/Mongo/ClickHouse verified in the VM) |
| `box` | Box idle sleep and wake through reconcile `SetSleeping`/`Resolve`, activity from edge requests and code-server's heartbeat file | Built (unit tested; not run against a real reconcile yet) |
| `dbengine` | Per-engine facts backup, dbtools and portgate share: `Port` (ClickHouse: native 9000), `HTTPPort`, `RedisLike`, `RedisCLI`, `TLSAtGate`, `SeparateExposedUser`, and `Capability` (`database.engines.v2`) | Built |
| `jobrun` | Docker access of the jobs packages (moby client): one-off runs with streamed stdin/stdout/stderr, helpers by spec hash, on-demand helpers with idle reaping, Exec, cleanup inventory that re-checks `seylo.managed` before every removal; every container removal takes the container's anonymous volumes with it (images with a VOLUME line, such as database images, would leave one per backup, restore or cron run that nothing else removes); `jobrun/itest` is the VM test setup | Built (verified in the VM) |
| `wings` | Pelican Wings detection (`FileDetector`), re-attaching our networks to the fork's Traefik (`Attacher`), games-first CPU weight (`SliceCPU`) | Built (attach after recreate and cgroupfs weight verified in the VM; no real Wings yet) |
| `update` | Signed agent self-update with a systemd rollback guard, panel swap (snapshot, health check, restore), Docker update, reboot, release manifest builder (`releasetool`) | Built; see "Releases and updates" |

Naming note: the node health check package is `nodecheck` (not `doctor`)
because `health` is the per-service probe package.

Find every unfinished feature with:

```sh
grep -rn 'stub.NotImplemented' go/internal
```

## Build, test, lint

Toolchain: Go 1.27, Bun 1.4, buf 1.75. Go tools (`protoc-gen-go`,
`staticcheck`) are pinned with `tool` directives in `go/go.mod`;
`protoc-gen-es` and TypeScript are pinned in the root `package.json`.

| Target | What it does |
|---|---|
| `make install` | `bun install --frozen-lockfile` (needed before `gen` and TS tests) |
| `make gen` | brandgen, `buf generate` + the `@seylo/proto` barrel, op and module indexes, `openapi.json`, the web route tree |
| `make check-gen` | Fails if committed generated code is stale, or the Drizzle schema changed without a migration (CI) |
| `make build` | Static `bin/seylo` (`CGO_ENABLED=0`), then `bun run build` (web, then panel) |
| `make test` | `go test -race` for `go/` and `tools/brandgen`, `bun test` in every workspace, `make test-installer` |
| `make test-installer` | `installer/test/run.sh`: install.sh in `--root` mode against a fake signed release (curl, docker, systemctl shims; minisign and OpenSSL 3 verifiers, dash), plus `scripts/release-preflight.sh`; skips without minisign |
| `make lint` | `buf lint`, gofmt, `go vet`, staticcheck, Biome, `tsc` for every workspace |
| `make breaking` | `buf breaking` against `main` |

Root `bun run` scripts: `build` (web then panel), `test`, `typecheck`,
`lint` and `format` (Biome), `gen` (`make gen`).

Generated code is committed and never edited by hand. Change the source
(`brand/brand.json`, `proto/`, op contracts, module folders, route files,
i18n section files) and run `make gen` (or `bun run gen`, the same thing).
Generated TypeScript files end in `.gen.ts`, except
`apps/panel/drizzle/` (migrations, from `bun run db:generate` in
apps/panel) and `openapi.json`.

The generated indexes let features land without touching a shared list:

| Generated file | Built from |
|---|---|
| `packages/ops/src/ops/index.gen.ts` | every `packages/ops/src/ops/<module>.ts` |
| `apps/panel/src/modules/index.gen.ts` | every `apps/panel/src/modules/<name>/index.ts` |
| `apps/web/src/i18n/en/index.gen.ts` | every `apps/web/src/i18n/en/<section>.ts` |
| `apps/web/src/routeTree.gen.ts` | the route files in `apps/web/src/routes` |
| `go/gen/pb`, `packages/proto/src/gen` | `proto/` |
| `openapi.json` | the op contracts |

Migrations: `apps/panel/drizzle/panel` starts with `0000_init.sql`, frozen
since the first release (0.1.0): installs out there have it applied, so it
never changes again. Every schema change after it is a new, add-only
migration (`0001_features` for 0.2), which the panel applies at start, also
right after an update (e2e check 38 updates a 0.1.1 install). After a
schema change run `bun run db:generate` in apps/panel and commit the new
migration with the change. Two people
generating migrations at the same time produce conflicting journals: if
`drizzle/panel/meta/_journal.json` conflicts, drop your uncommitted
migration, take theirs, and run `db:generate` again.

## Protocol

Summary; the full rules are in `proto/README.md` and the comments of
`envelope.proto` and `options.proto`.

- One WebSocket per agent at `/api/agent/connect` on the panel,
  subprotocol `<slug>.agent.v1` (`seylo.agent.v1`), opened by the agent.
  The handshake signature context is `<slug>-agent-hello-v1`
  (`apps/panel/src/agent-hub/signature.ts`); the panel side of the
  handshake (join with a token, resume with the node key, one session per
  node) is built and tested in `apps/panel/src/agent-hub/`. Each binary message is one frame: `[kind u8][stream u32 BE][payload]`.
- Stream 0 is the connection (handshake, then events). The agent opens odd
  stream ids, the panel even ones; ids are never reused on a connection.
- Unary methods: CALL then RESULT. Streaming methods: OPEN, size-delimited
  messages in DATA, CLOSE. Raw methods (`stream_mode` option): OPEN, raw
  bytes in DATA, CLOSE carrying the response.
- DATA is flow controlled per stream (initial window from OPEN, WINDOW
  grants). Control frames go first; DATA is chunked to 32 KiB and
  round-robined across streams.
- Every RPC has a `capability` option; call a method only when the peer
  advertised its capability.
- Durable reports (crashes, final deploy/build results, cron runs, backups,
  alerts) go through the agent's on-disk outbox and `PanelService.Report*`,
  deduped by outbox id. Progress, state deltas and metrics are best-effort
  EVENT frames. The panel stores only the durable kinds (deployProgress,
  buildProgress, cronRun, backupResult, nodeAlert, updateResult, cleanupRun; others get
  INVALID_ARGUMENT), at most 1 MiB per report (crash lines capped at 100 x
  2000 chars), about 10 per second per node (RESOURCE_EXHAUSTED past a burst
  of 600). A node may report only on services it runs (a placement, or a
  deployment in flight to or away from it; `agent-hub/service-scope.ts`):
  crash reports, durable events, deploy/health/cron events, state deltas,
  snapshots and metrics about other services are dropped, and an update
  result finishes only a step of that node. Limits per connection
  (`agentLimits` in `agent-hub/session.ts`): ClientHello within 10 s,
  agent-opened stream windows clamped to 1 MiB, WINDOW grants past
  2^31-1 are a protocol error, 64 agent-opened streams and 256 calls in
  flight (RESOURCE_EXHAUSTED beyond), 32 MiB unread on agent streams. One
  GetStateSnapshot per node at a time. panel.db retention (daily,
  `modules/nodes/retention.ts`): agent reports and crash reports 30 days
  (newest 200 crashes per service always kept), webhook deliveries 30 days
  (rejected ones 1 day), notification deliveries 30 days, resolved alerts
  180 days, deploy log lines of failed/cancelled/superseded deployments
  after 30 days (newest 20 per service and the live one keep theirs); a
  service keeps its two newest source uploads.
- Proto changes are add-only within v1 (`proto/README.md`).
- `GitSource.username` (added in 0.2): the HTTPS user name the agent's
  credential helper answers with the token (validated: no spaces or line
  breaks). Empty means `x-access-token`. The panel sends the git
  provider's (`oauth2` for GitLab, the token's owner for Gitea,
  `x-token-auth` or the account for Bitbucket) and a git credential's
  user name. Older agents ignore it, so Bitbucket clones need a 0.2 agent.
- `go/internal/conn/testdata/frames.json` is the Go <-> TypeScript golden
  fixture for the frame codec; both test suites read it.
  `go/internal/rpc/testdata/envelopes.json` does the same for the hello
  signature bytes, Call/Result/Open/Close and size-delimited stream
  messages (`TestGoldenEnvelopes`, `packages/proto/src/envelope.test.ts`).
- Panel pin: `sha256:<64 hex>` of the panel certificate's SPKI
  (`conn.FormatPin`; `ParsePin` also takes `sha256/<base64>`). The join
  command passes it as `--pin`; config.yml stores it as `panel_pin`.
  `--trust-on-first-use` records the first certificate's pin instead.
- Agent connection policy: reconnect with exponential backoff 1 s to 60 s
  with jitter (half to full delay); 5 minutes after a rejection that needs
  a person (bad token, unknown node, bad signature, disabled, too old) or a
  pin mismatch; ALREADY_CONNECTED retries normally. AGENT_TOO_OLD also
  makes the agent install the latest signed release itself
  (`update.AgentUpdater.UpdateToLatest`: `<release base>/latest/download/
  manifest.json(.minisig)`, at least `min_agent_version`, at most once an
  hour per version), since the panel cannot send UpdateAgent to an agent
  it refuses. A WebSocket ping every
  30 s (15 s timeout) drops a silent panel. The outbox drains in id order
  after every connect; UNIMPLEMENTED stops draining until the next
  connection, INVALID_ARGUMENT drops that one report, anything else
  retries with backoff up to 60 s. Each delivery and the first
  GetDesiredState get 30 s; three delivery timeouts in a row abort the
  session (a panel whose event loop is stuck still answers pings). The
  outbox keeps at most 10,000 reports / 64 MiB (oldest dropped first); ids
  never repeat across restarts, and on start the next id is at least the
  current time in microseconds, so restoring an older copy of the data
  folder (seq rolled back, same node identity) cannot reuse ids the panel
  already stored. After an accepted join the node id and
  pin are kept in memory even when config.yml cannot be written (the
  token is spent); the write is retried every 30 s.
- Moving to the panel's new address (`agent/move.go`): when
  HelloAccepted names a `panel_url` (https:// only; `panel_pin` empty =
  system roots) that differs from the address the agent dialed, the agent
  closes that session (the panel holds one per node), dials the new
  address and resumes there (ALREADY_CONNECTED is retried 5 times, 1 s
  apart; a different `panel_id` counts as a failure). Only a session over
  TLS (pinned, pinned on first use, or CA-verified) moves the node: the
  `panel_url` of a plain-HTTP session is ignored (logged once per agent
  start), because anyone on its path can write that HelloAccepted and the
  ServerHello whose `panel_id` the move checks; those nodes move by joining
  again with the https:// command (`seylo join --force`). The address in
  use named without a pin never drops the node's pin (a different pin, or
  a pin where there was none, still moves). Only after that
  handshake does config.yml change: `panel_url`/`panel_pin` become the new
  address, `insecure_transport` and `trust_on_first_use` are dropped, and
  the old address is kept under `fallback:`. In the move's first cycle a
  connect to `panel_url` that fails before the panel answered makes the
  next attempt dial the fallback once. The next successful connect to
  `panel_url` ends the cycle: a pinned `https://` fallback (the agents'
  TLS port) stays with `standing: true`, any other is dropped. A standing
  fallback is dialed once `panel_url` failed for 5 minutes (then every 5
  minutes), so a node whose panel domain was removed or changed finds the
  panel again; moving from one domain to the next keeps that pinned
  address as the fallback. Connected through a fallback, the agent moves
  to the `panel_url` the panel names, or, when it names none, makes an
  `https://` fallback `panel_url` again (a plain `http://` one, which only
  a hand-written config.yml has, never is and never moves the node: that
  session proves nothing about the panel). A failed move keeps the
  old address (a move that started from an `https://` fallback puts it
  back as `panel_url`), raises one `PANEL_MOVE_FAILED` node alert per
  address with the reason, and is retried after an hour or an agent
  restart; every successful move sends the resolve. An agent that dials
  loopback (the panel's node) never moves. The node checks and troubleshoot reports follow the current
  address (`Deps.PanelAddress`). Go reads the system trust store once per
  process: a CA added to it later needs an agent restart.
- Deadlines: `Call.timeout` / `Open.timeout` (relative) win over the
  absolute `deadline`, which is read on the callee's clock; senders set
  both. A callee that gets only a deadline that already passed on arrival
  runs the call without a local deadline (the caller's timer still
  cancels it). The agent measures the panel's clock offset from incoming
  calls (`deadline - timeout` against the receive time) and raises one
  CLOCK_SKEW node alert at 30 s or more, resolved when the clocks agree.
- Disk (`agent/disk_alert.go`): every 10 minutes the agent reads the file
  systems holding the data dir and Docker's root (`docker.Info.RootDir`,
  when Docker answers) like df (used / (used + available)). Above 85% it
  raises one DISK_LOW node alert per streak naming the full ones (one disk
  holding both counts once), resolved once all are at or under 85%. The
  first check after an agent start that finds them fine also sends the
  resolve. No panel setting changes the threshold. Every check also hands
  the fullest disk's use to the scheduled cleanup's disk trigger.
- Scheduled cleanup (`cleanup.LocalScheduler`, `agent/wire_jobs.go`): the
  agent follows `NodeSettings.cleanup` from the desired state it keeps on
  disk, so it runs while the panel is down and after agent restarts. A
  cron expression (five fields, robfig/cron, in the node's own time zone:
  `time.Local`, named in `NodeFacts.time_zone`) fires at its time; the
  timer sleeps at most a minute, and a due time more than 5 minutes past
  (clock jump, suspend) is skipped, like cron jobs. The disk trigger runs
  when the fullest disk passes `disk_percent`, at most once an hour, and
  every 6 hours while it stays above. Runs use the same Pruner as Prune
  (one at a time, `seylo.managed` only; unused volumes only with
  `unused_volumes`) and every run, failed or not, is a durable
  `CleanupRun` (at most 200 lines, `removed_count` is the total). A cron
  expression the agent cannot read (the panel checks with another parser)
  keeps the disk trigger and is reported once as a failed SCHEDULE run
  that removed nothing ("the schedule cannot be read on this node: ...",
  run id `cleanup-schedule-r<desired revision>`, so a restart on the same
  revision is not a second one; a new one only when the schedule changes).
- Host shells (`agent/host_shell.go`, `hostshell`): HostShell opens a root
  login shell on the node with a PTY. The agent refuses it
  (PERMISSION_DENIED) unless `NodeSettings.host_shell` is on and
  config.yml does not set `no_host_shell: true` (only someone with root
  on the node can set that), checked for every shell on the agent, not
  only on the panel; at most 2 at a time (RESOURCE_EXHAUSTED), hung up
  after 15 minutes without input or output, and every open one is closed
  when the setting turns off. The first message is `HostShellInfo`; the
  agent's own log names who opened it (`opened_by`, `session_id`).
- Refused specs: `reconcile.Runtime.Sync` validates each spec
  on its own. A refused one keeps the service's last valid spec (it keeps
  running) or is left out when there is none, the rest of the state is
  taken, and `SyncDesiredResponse.refused` lists `{ service_id,
  generation, message }`; refusals of a stale revision are not reported.
  ApplyService still answers INVALID_ARGUMENT for its one spec. Either
  way the service's log gets one SYSTEM line per refused generation.

## Conventions

### General

- Small files with one job, clear names, comments that explain why. Plain
  hyphens, never em dashes, in code, comments and docs.
- No dead code and no silent stubs. Unfinished work returns
  `stub.NotImplemented("<package>.<Func>")` (Go) and is listed in this file.
- Pin exact dependency versions (`bun add --exact`, `go get` writes exact
  versions). Prefer well-maintained libraries to hand-rolled code.
- The product name, slug, data dir and URLs come from the generated brand
  package (`gen/brand` in Go, `@seylo/brand` in TS), never from literals.
  Names of Docker resources come from `internal/docker` (`ContainerName`,
  `ProjectNetwork`, ...) and paths from `internal/datadir`.

### Go

- Errors: wrap with `fmt.Errorf("doing x: %w", err)`; export sentinel
  `ErrXxx` values for conditions callers branch on; check with `errors.Is` /
  `errors.As`. Errors that reach users through RPC are `*rpc.Error` with a
  status code; anything else becomes a generic INTERNAL status
  (`rpc.StatusOf`) so internals never leak.
- Logging: `log/slog` only. Pass a `*slog.Logger` in (`agent.Options`)
  instead of using the global in library code. Keys are `lower_snake`
  (`service_id`, `node_id`, `generation`). Never log secrets: env values,
  tokens, keys, passwords in URLs.
- Context: first parameter of anything that blocks or does I/O; respect
  cancellation; no `context.Background()` below `main` except in tests and
  long-lived goroutines that own their lifetime (like `conn.Writer`).
- Concurrency: document which goroutine owns what; prefer channels for
  wakeups that must also honour a context (see `conn.SendWindow`).
- Tests: table-driven where it fits, run with `-race`, no network beyond
  `httptest`. Docker integration tests go behind a build tag
  (`//go:build integration`) so `go test ./...` stays hermetic.
- No CGO; the binary must cross-compile for linux/amd64 and linux/arm64.

### Agent wiring

How the feature areas plug into the agent (`go/internal/agent`) without
editing `agent.go`. The core (`agent.go` and the other files of the
package not named `wire_*.go`, with `conn`, `rpc`, `state`, `localapi`,
`datadir`, `stub` and `cmd/seylo`) is the protocol side: connection, RPC
session and handler registration, desired/actual state store and outbox,
local API, join and resume. The areas:

| Area | Wire file | Packages |
|---|---|---|
| runtime | `wire_runtime.go` | `docker`, `reconcile`, `health`, `crash`, `volumes` |
| network | `wire_network.go` (and `cert_retry.go`) | `proxy`, `edge`, `portgate`, `wings` |
| build | `wire_build.go` | `build`, `registry`, `compose` |
| observe | `wire_observe.go` | `logs`, `metrics`, `console` (with `console/dockerapi`), `shell`, `fs` |
| jobs | `wire_jobs.go` | `cron`, `backup`, `tunnel`, `cleanup`, `dbtools`, `box`, `jobrun` |
| node | `wire_node.go` (and `host_shell.go`) | `update`, `nodecheck`, `troubleshoot`, `cli`, `panelapi`, `systemd`, `version`, `hostshell` |

- Each area has one file, `wire_<area>.go`, with two functions.
  `agent.Wire` runs every `provide<Area>(d *Deps) error` in the order
  runtime, observe, network, build, jobs, node (phase 1: build components,
  set the area's `Deps` fields; read only the core block and fields of the
  areas before it), then every `wire<Area>(reg *Registry, d *Deps) error`
  in the same order (phase 2: every provided field is set; register
  handlers, add loops, subscribe). The runtime provides `d.Docker` first
  and sets `d.Reconcile` in phase 2 because it needs other areas'
  components. Tests for a wire file go in `wire_<area>_test.go` and may use
  `newTestDeps(t)` from `wiring_test.go`. Feature packages never import
  each other's internals; they use the interfaces in each package's
  `doc.go`.
- `Deps` (`deps.go`) core block, set by the agent: `Layout`, `Logger`, `Config`
  (node id, panel URL, `CanBuild` from config.yml; the node id is empty
  until the first join, `ConnInfo.NodeID` always has it), `Desired`
  (desired store), `DesiredSync` (`Sync`/`Apply`/`Remove` with the
  revision rules: save to `Desired`, then publish to `Feed`; handlers use
  it), `PanelControl` (optional: set it to back `seylo panel start|logs`),
  `Feed`
  (`state.DesiredFeed`: accepted desired state + `Settings()`; reconcile
  publishes, others `Subscribe`), `State` (actual-state store), `Reports`
  (`state.Reporter`, durable), `Events` (`rpc.Emitter`, best effort),
  `Panel` (`rpc.PanelClient`) and `PanelPeer` (`rpc.Peer`, both follow
  reconnects and answer UNAVAILABLE while disconnected), `Facts`
  (`Update(func(*NodeFacts))` for your fields; never set capabilities),
  `Components`. Area blocks: runtime `Docker`, `Prober`, `Reconcile`;
  network `Router`, `Gate`, `Tickets`, `Wings`, `CPU`; build `Builder`;
  observe `Logs`, `Metrics`, `Files`; jobs `Cron`, `Backups`, `Cloudflare`,
  `Pruner`, `CleanupScheduler` (the node area feeds it the disk checks'
  readings); node `Updater`. A new cross-area field goes in the core block.
- Handlers (`Registry` is `rpc.Mux` for AgentService), by short method
  name:

  ```go
  rpc.HandleUnary(reg, "RestartService", func(ctx context.Context, req *agentv1.RestartServiceRequest) (*agentv1.RestartServiceResponse, error) {...})
  rpc.HandleStream(reg, "LogsFollow", func(ctx context.Context, first *agentv1.LogsFollowRequest, s *rpc.TypedStream[*agentv1.LogsFollowRequest, *agentv1.LogsFollowResponse]) error {...})
  rpc.HandleRaw(reg, "FsRead", func(ctx context.Context, req *agentv1.FsReadRequest, s rpc.RawStream) (*agentv1.FsReadResponse, error) {...})
  ```

  `ctx` ends when the panel cancels or the connection drops;
  `rpc.CallInfoFrom(ctx)` gives the method and metadata (acting user).
  Return `rpc.NewError(code, msg)` for a user-facing status; anything else
  becomes INTERNAL. Streams: `Send` blocks until the panel granted credit,
  `Recv` returns io.EOF after the panel half-closed, the stream closes when
  the handler returns. Raw: `Read` until io.EOF (uploads), `Write`
  (downloads), return the response for the final CLOSE. Registration
  mistakes (unknown method, wrong shape or types, duplicates) make `Wire`
  fail with `rpc.ErrRegistration`. Unregistered methods answer
  UNIMPLEMENTED, and a capability is advertised only when all of its
  methods are registered, so register a capability's methods together.
- Background work: `d.Components.Add(name, func(ctx) error)` (started
  after wiring; nil = done, error = restart with 1s..30s backoff; a panic is
  caught and restarted), `d.Components.OnConnect(func(ctx, ConnInfo))`
  (each accepted handshake: session id, panel capabilities, edge ticket
  key) and `OnDisconnect`.
- Events and reports: progress, deltas, metrics and fact changes go
  through `d.Events.Emit(&agentv1.Event{...})` (never blocks, dropped
  while disconnected). Final deploy/build results, cron runs, backup
  results, node alerts and update results go through
  `d.Reports.Event(ctx, ev)`; crashes through `d.Reports.Crash(ctx, r)`.
  Both are on disk when they return and reach the panel at least once.
  Never call `d.Panel.ReportCrash/ReportEvent` yourself (the outbox drain
  does); `d.Panel.GetDesiredState` and `d.Panel.RegistryTunnel` are yours
  to call.
- Feature packages never import `agent`: take callbacks or the interfaces
  above, and adapt `Deps` in your wire file.
- Testing without a network (`go/internal/rpc/rpctest`): register on
  `rpc.NewAgentMux()`, then `panel := rpctest.NewPeer(t, reg)`;
  `panel.Call(ctx, "RestartService", req, resp)` and
  `panel.Open(ctx, "LogsFollow", req)` (an `rpc.Stream`:
  Send/Recv/Read/Write/CloseSend/Finish) run the handler with the wire's
  marshalling, Status mapping, metadata (`rpc.WithMetadata`) and credit
  windows (`rpctest.WithWindow`). A handler panic fails the test.
  `rpctest.NewRecorder()` is a fake `Emitter` + `Reporter` with
  `WaitEmitted`, `WaitDurable` and `WaitCrash`; `state.NewMemoryOutbox()`
  is an in-memory outbox. `rpctest.NewFakePanel(t)` is a whole Go panel
  over httptest (join tokens, node keys, `Session(nodeID)` to call the
  agent, recorded reports and events, `WithTLS()`); the agent's own tests
  in `daemon_test.go` show how to run a daemon against it.
- Interop with the real TypeScript panel: `bun
  go/internal/agent/testdata/interop-driver.ts` starts the panel in
  process, joins `TestInteropRealPanel` (build tag `interop`) and runs
  unary calls, server and bidi streams, raw uploads and downloads, a
  cancel, durable reports and state deltas. `SEYLO_INTEROP_VM_TEST=<linux
  test binary>` runs the agent side in the test VM instead.
  `testdata/nodeops-interop-driver.ts` (`TestInteropNodeOps`, run in the VM
  for the PTY) does the same for scheduled cleanup and host shells through
  the panel's own ops and sockets.

### Docker resources

- Every resource we create carries `seylo.managed=true` plus the identifying
  labels from `docker.InstanceLabels` (`seylo.service`, `seylo.project`,
  `seylo.kind`, `seylo.generation`, `seylo.replica`, `seylo.protected`,
  `seylo.role`). Cleanup and pruning only touch resources with
  `seylo.managed=true`.
- Every container gets `traefik.enable=false` and `--cgroup-parent=seylo.slice`
  and Docker restart policy `no`.
- Names: containers `seylo-<service>-<generation>[-<replica>]`, networks
  `seylo-p-<project>` and `seylo-edge`, route files `seylo-<service>.yml`,
  service volumes `seylo-v-<owner service>-<volume>` (bind-backed by
  `<datadir>/services/<owner>/volumes/<volume>`). These are on-node
  contracts: changing one orphans existing resources.
- Service instances (reconcile's) carry `seylo.service` and no
  `seylo.role`, plus `seylo.spec-hash` (`reconcile.SpecHash`: a matching
  hash is adopted as is). Containers any other component runs (cron runs,
  DB web UIs, cloudflared, Traefik, builds, registry) use
  `docker.RoleLabels(role, serviceID)`; reconcile never touches them.
- Isolation: service containers join only their `seylo-p-<project>`.
  Traefik is connected to the project network of every routed service
  (`reconcile.ProxyContainers` on the Router, else `seylo-traefik`), never
  the other way round, so projects cannot reach each other.
- The protected panel service (`docker.PanelServiceID` `panel00000000000`
  in `docker.PanelProjectID` `panelproject0000`): reconcile binds
  `<dataDir>/panel` at the same path (the spec has no volumes), publishes
  its FORWARD public ports through Docker instead of the portgate (the
  panel answers while the agent restarts; the hash includes the ports),
  and adopts a protected instance without a `seylo.spec-hash` label at the
  desired generation as is (the installer's container). Send it with
  `deploy.mode = RECREATE`.
- Unhealthy running instances leave the route while another replica of
  the serving generation is healthy; a lone unhealthy replica stays
  routed (the service is DEGRADED). Reconcile writes SYSTEM lines into
  the service log (deploy started, healthy and serving, failed, rolled
  back, exited with code N).
- `services/<id>/runtime.json` is reconcile's memory across agent restarts
  (crash-policy halt, the crash streak and its latest crash, failed
  generation, sleeping, containers re-attached to another project's
  network); it and file mounts are written with
  `state.WriteFileAtomic` (fsync of the file and the folder).
- A service moved to another project (`services.moveProject`) arrives as a
  spec whose `project_id` changed. When that is the only change
  (`SpecHash` with the old project equals the container's), reconcile
  keeps the running containers: they join `seylo-p-<new project>` with the
  same aliases, are health checked on the new address, the route switches
  to that address and is verified through Traefik, and after
  `Options.ReattachDrain` (2 s) they leave the old network; the route then
  names them again. Their labels keep the old project and hash, so
  `runtime.json` (`reattached`: container id -> project and hash) decides
  their network, whether they serve the spec, `Resolve` and adoption after
  an agent restart; the entry goes with the container. A failed health
  check leaves them on the old network and fails the generation. A move
  interrupted after it was recorded (a newer spec during the drain skips
  the drain; an agent stop or crash, a failed disconnect) is finished by
  the next pass: containers in doubt (every recorded one after a start)
  leave every `seylo-p-*` network but their own (`healNetworks`), so the
  old project stops reaching them and its network can be removed. Anything
  else changed too (the new project's shared variables, for example) is an
  ordinary rollout. Project networks any of our service containers still
  use are never removed, and the proxy is not taken off them. Agents from
  before this always roll new containers (recreate-mode services, such as
  databases, restart once).
- Containers of services the desired state does not name are removed only
  once a desired state with revision > 0 was accepted; with none (a fresh,
  wiped or damaged `desired.pb`) the agent keeps what it adopted running
  until the panel sends one, like the route files and cleanup.
- Build and registry infrastructure: the panel registry container and
  its own bridge network are both `seylo-registry` (`seylo.role=registry`,
  `seylo.protected=true`, never published, storage `<datadir>/registry`),
  started by the agent on first `Tunnel(RegistryTarget)`; buildx builders
  are one per project, `seylo-builder-<project id>-<cores>c-<gb>g`
  (`BuildRequest.project_id`, the service id when a panel sends none;
  other ids are hashed to `x<16 hex>`), so `RUN --mount=type=cache`
  folders and the layer cache never cross projects (VM test
  `TestCacheMountsStayInTheirProject`). Each is a docker-container driver
  under `seylo.slice` with the size's CPU and memory cap; the build queue
  bounds how many run at once; the builder list is in
  `<datadir>/builds/docker`. A builder no build used for 14 days is
  removed with its cache; the one shared builder of older agents
  (`seylo-builder-<cores>c-<gb>g`) and builders of another size are
  removed on the first build or cache sweep. Pinned Railpack/Nixpacks
  binaries live in `<datadir>/tools`.
- Networking: the own Traefik `seylo-traefik` (`traefik:v3.7.15`,
  file provider only, restart unless-stopped, `seylo.role=traefik`) reads
  `<datadir>/traefik/dynamic` and keeps `acme.json` in
  `<datadir>/traefik/acme`; entry points `web` :80, `websecure` :443,
  `seylo-lb` :5757 (TLS, other nodes' load-balanced traffic, local replicas
  only; with `NodeSettings.lb_tls` mutual TLS: LB routers use the TLS options
  `seylo-lb` from `seylo-lb.tls.yml` (client certificate from the panel's LB
  CA required, anchor router for the `server_name` SNI), and balancing nodes
  verify peers by `server_name` and present their own certificate instead of
  `insecureSkipVerify`), resolver `le` (HTTP-01; `SEYLO_ACME_CA=staging|<url>` overrides the
  directory; for a test CA, config.yml `acme_ca_certificates` (a PEM file,
  mounted as `LEGO_CA_CERTIFICATES`) and `acme_ca_server_name`, or the
  `SEYLO_ACME_CA_CERTIFICATES` / `SEYLO_ACME_CA_SERVER_NAME` env). Next to the Wings fork the files go to its
  `<proxy.data_dir>/dynamic` instead. The edge listener binds
  `<seylo-edge gateway>:5756`; Traefik rewrites to its paths under
  `/_seylo/` (`/page/maintenance/<id>`, `/page/status/<id>`, `/ticket`,
  `/handoff`, `/probe`). Next to the Wings fork the LB entry point is a
  second Traefik of ours, `seylo-traefik-lb` (LB entry point only, file
  provider on `<datadir>/traefik/lb-dynamic`, where the router writes each
  service's LB routers in its own `seylo-<id>.yml`); reconcile attaches it
  to project networks like the fork's Traefik. Tool session cookies are
  signed with `<datadir>/network/edge-session.key` (kept across agent
  restarts). Route certificate failures come from the Traefik container's
  log (the last 24 h, kept until a certificate appears). RetryCertificate
  (`routing.certificate-retry.v1`, `proxy/certretry.go`) makes Traefik ask
  the CA again for an ACME route's hosts without a certificate, without a
  restart: Traefik's ACME provider runs for every router's hosts without a
  certificate on each changed dynamic configuration (an equal one is
  skipped), so the route's routers get a new name
  (`seylo-<svc>-r-<route>-c<n>`, `BuildInput.CertRetries`), the file is
  written atomically, and the hosts' failures are dropped
  (`CertFailures.Retried`: failure lines from before the retry, as a
  restarted log follower replays them, are ignored; Traefik logs whole
  seconds, so one in the retry's second counts). The route is
  CERTIFICATE_PENDING until a certificate or a new failure appears, and the
  agent publishes the service's status at once (`Refresh`). Other routers
  keep their names, so nothing else reloads; the name stays for later
  renders (a deploy does not trigger another attempt) and goes with the
  route or service. The count is in memory: an agent restart rewrites every
  route file anyway (a new probe secret), which Traefik also takes as a
  change. NOT_FOUND when the route is not on the node, FAILED_PRECONDITION
  when it is not ACME or every host has a certificate (Traefik renews
  those). The same next to the Wings fork: the files are in its dynamic
  folder, and the LB file does not change. Exposed Mongo and
  Redis ports are TLS-terminated by the portgate with the certificate
  from `dbtools.Certificate` (ACME for `tls_hostname`, else the
  self-signed one in `<state>/db-tls/<id>.{crt,key}`). Tool hosts are `seylo-box-<id>.<wildcard>` and
  `seylo-db-<id>.<wildcard>`. Edge tickets: `edge.TicketContext` documents
  the format the panel signs. Portgate remembers picked ports in
  `<datadir>/network/portgate.json`.

### TypeScript

General:

- Strict mode, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, ESM.
  TypeScript 7 (`tsc` is the native compiler). Formatting and lint by Biome
  (`bun run format`); 2 spaces, double quotes, 140 columns.
- Import the protocol from `@seylo/proto`, brand values from `@seylo/brand`,
  contracts from `@seylo/ops`. Never type the product name, slug or data dir.
- Exact dependency versions in every `package.json` (`bun add --exact`);
  peer dependencies use ranges, with an exact dev copy.
- Tests with `bun test`, next to the package (`test/` or `*.test.ts`).

Ops (the only way the web app, CLI, MCP and AI reach the panel):

- A contract is `defineOp({...})` in `packages/ops/src/ops/<module>.ts`; its
  handler is `implement(contract, run)` in
  `apps/panel/src/modules/<module>/`. The architecture's single `op({..., run})`
  is split in two so the web app can import contracts without server code.
- Ids are `<module>.<action>` and never change once released. Queries are
  `GET /api/v1/<id>` with query parameters; mutations and destructive ops
  are `POST /api/v1/<id>` with a JSON body. Responses are the output JSON,
  or `{ "error": { code, message, details? } }` with the matching status.
- The pipeline (`apps/panel/src/ops/pipeline.ts`) is the same for every
  transport: authenticate -> validate input -> permission -> approval ->
  rate limit -> run -> check output -> audit. Input validation comes before
  the permission check because scoped permissions read the resource id from
  the input; anonymous callers are refused before validation.
- Unbuilt ops use `notImplemented(contract)` from
  `apps/panel/src/ops/implement.ts` (answers NOT_IMPLEMENTED after the
  auth gate); `Object.values(mod).filter(isOpContract).map(notImplemented)`
  stubs a whole module.
- Handlers throw `OpError(code, message, details)` for expected failures.
  Anything else becomes INTERNAL with a generic message and a log line.
  Messages are safe to show to people.
- Outputs are cleaned against the output schema (undeclared fields are
  dropped), so returning a database row never leaks a column.
- After a change, a handler publishes `ctx.live.publish(topic, { type:
  "invalidate", ops: [...] })` for the queries it affected. Topics: `panel`,
  `project:<id>`, `service:<id>`, `node:<id>`.
- Permissions: see "Permission model" below.

#### Permission model

- Actions are `<area>.<verb>` strings named by op permissions
  (`permission.global|project|service(action, resource)`); `public` and
  `signedIn` ops need no action. `actionCatalog(allOps)` and
  `grantableActions(allOps, "project" | "service")` in `@seylo/ops` list
  them for screens (labels come from i18n, keyed by action), so the list
  never drifts from what the pipeline checks.
- Global roles (`users.role`): `owner` and `admin` hold every action.
  Only owners change owner roles; admins manage admins and members; the
  last active owner cannot be demoted, disabled or removed; nobody changes
  their own role. `member` holds only what grants give.
- Action lists (grants and keys) hold `*` (everything), `<area>.*` (every
  action of one area, for example `services.*`) or exact actions; match
  them with `actionAllowed(list, action)` from `@seylo/ops`.
- Grants (`grants` table): one row per member per project or service, with
  a list of actions (`*` = all grantable ones). A project grant covers the
  project's services, so it takes project and service actions; a service
  grant takes service actions only; global actions are never granted.
  Anyone with `grants.manage` on a resource can share it, but only with
  actions they hold there. Invites carry the same grant list and turn into
  grants on accept.
- Credentials: browser sessions (HttpOnly cookie `<slug>_session`, hashed
  opaque token, 30-day sliding) or `Authorization: Bearer <token>`. A
  bearer token is an `api_keys` row: kind `api` (`<slug>_key_...`) or
  `mcp` (`<slug>_mcp_...`, from apiKeys.create or the MCP OAuth flow). A
  key acts as its owner, narrowed by its `actions` list (`*` = all of the
  owner's), its optional `projectIds` (then it holds no global actions)
  and `readOnly` (queries only). MCP tokens are read-only by default.
  Bearer wins over the cookie. Only sessions create keys, and account
  security ops (password, 2FA, passkeys, GitHub link, sessions, profile)
  refuse keys (`requireSession` in `src/auth/sign-in.ts`). A session lives
  at most 90 days from sign-in and its token rotates on password and 2FA
  changes. Ops that add a way in (`auth.passkeyRegisterBegin`,
  `auth.githubLinkStart`, `auth.totpEnroll`, `apiKeys.create`,
  `cliLogin.approve`, a first password in `auth.changePassword`) also need
  a fresh session: signed in or confirmed with `auth.reauth` (password, an
  authenticator or recovery code, or a passkey via
  `auth.reauthPasskeyBegin`) in the last 15 minutes (`requireFreshSignIn`
  in `src/auth/fresh.ts`, `sessions.reauth_at`); otherwise FORBIDDEN with
  `details.reason: "reauth"`, which the web turns into a re-auth dialog
  and a retry. Wrong answers count toward the per-address lock. The MCP
  OAuth consent page (`/oauth/authorize`) sends a stale session to the web
  app's `/reauth?redirect=<back>` page first and refuses a stale Allow.
  Admin ops that hand someone else lasting access need the same fresh
  session when a browser session runs them, while API keys pass
  (`requireFreshIfSession`; every key was made under a fresh sign-in):
  `invites.create` with role admin, `users.updateRole` to a higher role
  (admin or owner), `nodes.createJoinToken`, `gitProviders.create` and
  `gitProviders.update` with a new token or user name (a token with write
  access to repositories and webhooks). Member invites, grants and
  demotions are not gated.
- Host shells (`modules/hostShell`): `hostShell.setEnabled` takes
  `nodes.manage`, but turning host shells on needs the owner role and a
  fresh browser session (`requireFreshSignIn`); turning them off works for
  admins and API keys and closes every open one. `hostShell.open` needs
  the global `nodes.hostShell` (owners and admins only, since global
  actions are never granted), a fresh browser session (API keys and MCP
  tokens are refused even with `*`; the op is `mcp: false`), the node
  setting on, the agent's `node.host-shell.v1` and fewer than 2 open shells
  and unused tickets on the node (CONFLICT `reason: tooMany`, `hostShellOff`
  when off). Every 30 s an open shell checks that its browser session still
  exists, the person is still an active owner or admin and the setting is
  on, and closes otherwise. A shell counts against the cap from the
  socket's open, but is listed in `hostShell.status` and raises the
  `security_change` alert only once the agent's stream answered (its
  `HostShellInfo`); one the node refuses (config.yml `no_host_shell`, its
  own cap, a setting it has not synced) raises none and is audited as
  closed with `refused by the node: <message>`. Turning them on raises a
  `security_change` alert too.
- Model callers (transport `mcp` or `ai`, or any `mcp` token on any
  transport) only reach ops with `mcp: true`; everything else is FORBIDDEN.
- Approval: a destructive op from a model fails with `APPROVAL_REQUIRED`
  (403) unless the call carries
  `approvalId`, which only the approvals module sets when it replays a call
  a person approved (the approvals module checks that the approval matches the op and input).
- Second factor: sign-in ops return a `LoginResult`; with 2FA there is no
  session yet, only a 5-minute ticket (`auth_challenges`) that
  `auth.verifySecondFactor` exchanges for one. Passkey sign-in (user
  verification required) skips it. Five wrong passwords or codes in a row
  from one client address lock that email (account or not, so the answer
  never tells which emails exist) or account for that address for 30 s,
  doubling up to 15 minutes; 15 quiet minutes forgive the streak, and
  `users.enable` clears every address's streak (`src/auth/lockout.ts`,
  in memory). A soft brake per typed email counts wrong passwords from
  every address: past 50 within the same forgiveness window each sign-in
  for that email waits 2.5 s first and the account gets one
  `security_change` alert per streak (never a lock; `users.enable` clears
  it too). Recovery codes are stored as HMACs (`secrets.sign(code,
  "recovery-code")`), not bare SHA-256: they carry only 50 bits.
- Audit: the pipeline records the permission's target and its name before
  the op runs (so deletes keep it); refused attempts keep the target id but
  no name. Public sign-in ops call `ctx.auditAs(user)` so the entry belongs
  to the person who signed in (or whose password was tried).
- Setup link: the installer writes a `<slug>_setup_...` token to
  `<dataDir>/setup-token` (one line, 0600) before the panel's first start
  and prints `<url>/setup?t=<token>`. While no owner exists the panel
  imports it on start (valid one hour) or writes a fresh one there;
  `bun scripts/setup-link.ts [baseUrl]` in apps/panel prints a new link.
  Creating the owner burns the token and deletes the file.
- Links the panel hands out: invites are `<origin>/invite?t=<token>`
  (panel domain when set, else `OpCall.origin`, else a path the web app
  completes with its own origin).

Panel:

- Feature code lives in `apps/panel/src/modules/<name>/`; the module index
  is generated, so parallel work never edits a shared list. A module
  carries everything it adds: `ops`, background `jobs` (`defineJob`),
  `http` for endpoints that cannot be ops (webhooks, MCP, terminal
  sockets) and `start` for subscriptions made once at boot
  (`deps.agents.onEvent`, schedules). See `modules/module.ts`.
- Settings: a module declares its keys by augmenting `SettingValues` from
  its own folder (`declare module "../../settings"`); see `src/settings.ts`.
- SQLite through Drizzle (`bun:sqlite`, WAL). Tables are snake_case plural,
  ids are 16 chars of `[0-9a-z]` (`newId`), timestamps integer milliseconds.
  Change `src/db/schema/*.ts` (one file per area, see Panel areas), then
  `bun run db:generate`, and commit the migration. Usage rollups go to
  `metrics.db`, never `panel.db`. Secrets never go in JSON columns such as
  `services.spec`: use a `*_sealed` column or `service_secrets`.
- Secrets are sealed with `deps.secrets.seal(value, purpose)` (AES-256-GCM,
  HKDF key per purpose from `master.key`); add new purposes to
  `SealPurpose`. Tokens are stored as SHA-256 hashes only.
- Logging: pino JSON with camelCase keys (`opId`, `nodeId`); take the
  logger from deps. Never log secrets, tokens or env values.
- Config comes from `<SLUG>_*` environment variables (`src/config.ts`);
  nothing else reads `process.env`.

Web:

- Every visible string through `t("section.key")`. Each section is one
  file, `src/i18n/en/<section>.ts` (default export); add keys to the
  screen's own section and create a new section file for a new screen.
- Styling only through tokens (`packages/ui/src/styles/theme.css`) and the
  utilities mapped from them; theme presets override variables.
- Server data only through `useOp` / `useOpMutation`; no hand-written
  fetches.
- An op the panel answers with NOT_IMPLEMENTED renders "Not built yet" in
  place (`components/query-error.tsx`), never an empty screen.

#### Theme and branding injection

The panel rewrites `index.html` on every request
(`apps/panel/src/modules/settings/boot.ts`, wired in `http/static.ts`), so
the first paint already has the panel's theme, name and favicon. Names and
types come from `@seylo/ops` (`settings.PanelBoot`, `settings.bootDom`,
`settings.resolveThemePreset`); never type the ids by hand.

- `<html>` gets `data-color-mode="light|dark|system"` and, when the mode is
  not `system`, `data-theme="<preset>"` (absent for `seylo`, whose tokens
  are `:root`). For `system`, an inline script resolves the preset with
  `prefers-color-scheme` before the body paints.
- `<title>` becomes the panel name; `<link rel="icon">` points at
  `/branding/favicon?v=<hash>` when one is uploaded.
- Last in `<head>`, after the charset meta and the app stylesheet, in this
  order: `<script type="application/json" id="panel-boot">` with the
  `PanelBoot` JSON, the theme script, `<style id="panel-accent">` (overrides
  `--primary`, `--ring`, `--link` when an accent is set) and
  `<style id="panel-custom-css">` (owner's custom CSS, last so it wins).
  `<` inside them is escaped so nothing can close the element.
- The web app reads the JSON once at start (`JSON.parse` of
  `document.getElementById(settings.bootDom.dataId).textContent`), and
  falls back to the public `settings.boot` op when the element is missing
  (Vite dev server). It listens to `prefers-color-scheme` changes and
  re-applies `resolveThemePreset`. After an appearance or branding save it
  refetches `settings.boot` and rewrites the two `<style>` elements, the
  `data-theme` / `data-color-mode` attributes, the title and the icon link
  in place: no reload. Compare `revision` to skip work.
- Branding files are served at `/branding/<logoLight|logoDark|favicon>`
  (public, immutable with `?v=`, SVG sandboxed by CSP). Logos in the boot
  data are those paths or null (use the product mark).

#### Schedules, alerts, email and the live socket

- Recurring work: `deps.schedules.ensure({ key, jobType, payload?, cron? |
  intervalSeconds?, jitterSeconds?, missedRun?: "runOnce" | "skip", runNow? })`
  (`jobs/schedules.ts`), usually in a module's `start()`. Cron is five
  fields (or `@daily` and friends) in UTC. Each due schedule enqueues one job
  with dedupe key `schedule:<key>`, so a slow run is never doubled; calling
  `ensure` again with the same timing keeps `nextRunAt`. `remove(key)`,
  `removePrefix(prefix)`, `keys(prefix)`, `get(key)`.
- Alerts: `deps.alerts.raise({ event, key, title, message?, serviceId?,
  projectId?, nodeId?, link?, severity? })` (`modules/alerts/sink.ts`). One
  row per `key` ("<incident kind>:<subject>:<start>"); mutes and the
  notification rules decide who is told; delivery is a retried job per
  channel. `deps.alerts.resolve(keyPrefix, recovered?)` closes the incident
  and can record the good news (feed only). Agent events (deploy/build
  results, health, backups, node alerts, updates, crashes via
  `agents.onCrash`, node offline after a 60 s grace) become alerts in
  `modules/alerts/events.ts`.
- Email: `deps.notify.sendEmail({ to, subject, text, html? })` returns
  `"sent" | "noChannel" | "failed"` through the panel's SMTP channel.
- Running ops for someone: `deps.ops.execute(call)` is the pipeline;
  `runOpAs(deps, { op, input, userId, transport, approvalId? })`
  (`modules/approvals/run-as.ts`) runs one as a person. Models (MCP, AI)
  never set `approvalId`; only `approvals.approve` does.
- Live sockets are re-checked every 15 s and on each subscribe and closed
  (code 4401) when their session ended; `deps.live.disconnect({ sessionId }
  | { userId })` closes them at once. The re-check also drops topics the
  fresh access no longer allows (an `error` FORBIDDEN per topic);
  `deps.live.recheck({ userId })` does it at once (grants and role changes). `ai:<id>` is for the conversation's
  owner only; `deployment:<id>` needs `services.view` on its service.
- MCP: `POST /mcp` (Streamable HTTP, stateless JSON replies, protocol
  2025-03-26 to 2025-11-25), MCP tokens only (`api_keys.kind = "mcp"`).
  OAuth: `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource[/mcp]`, `POST /oauth/register`
  (public clients, https / loopback http / app-scheme redirects),
  `GET|POST /oauth/authorize` (server-rendered consent: read only by
  default, or read and change), `POST /oauth/token` (code + S256 PKCE,
  rotating refresh tokens, access tokens 24 h, a grant lives 90 days),
  `POST /oauth/revoke`. A token sees only the tools it could use;
  destructive calls become approvals.

#### Panel service, CLI login, uptime targets and more

- The panel as a service (`modules/nodes/panel-service.ts`): with `SEYLO_IMAGE`
  set (the installer passes it, with `SEYLO_HOST_PORT`), the panel node's first
  connect creates project `panelproject0000` and service `panel00000000000`
  (protected, generation 1, a live deployment of that image). `panelContributor`
  runs last (`DesiredContributor.order`, higher runs later) and fixes its env
  (`PORT`, `HOST_PORT`, `SECURE_COOKIES=false`, never the image), the published
  port (FORWARD), alias `panel`, RECREATE and no volumes; with a panel domain it
  adds the route. Proxy trust and HTTPS (`src/http/proxy-trust.ts`, `https.ts`,
  `domain-redirect.ts`): X-Forwarded-For/-Proto/-Host count only from the
  addresses of `SEYLO_TRUSTED_PROXIES` (default `<slug>-traefik`, resolved
  through Docker DNS every 30 s), never from the published IP:port; cookies get
  Secure on every HTTPS request (trusted X-Forwarded-Proto, or Host equal to
  the panel domain) whatever `SECURE_COOKIES` says; HTTPS responses carry
  `strict-transport-security: max-age=31536000`; every response carries
  `x-frame-options: DENY`, nosniff and `referrer-policy: same-origin`, pages
  `frame-ancestors 'none'`. Once `panelDomainStatus` is active, page loads on
  any other host (not loopback, not /api) answer 302 to `https://<domain>`. After a successful UpdatePanel the new panel records the
  release manifest's `panel { image, digest }` at generation + 1 before the
  flusher starts. Deploy, stop and setPlacements answer CONFLICT `reason: panel`.
- CLI browser login (`cliLogin.*`): `start` (public) -> user code, device code,
  `/cli/approve?code=` URL (absolute with `OpCall.origin`); a fresh browser session
  approves with a scope and lifetime (`approve`, default 7 days) or denies;
  `poll` creates the API key ("CLI on <name>") on the first poll after approval
  and returns it once. Requests live 10 minutes (`cli_login_requests`, swept on
  `start`); only the device code's hash and the chosen scope are stored.
  The web page (`/cli/approve`) never opens a request from `?code=`: the person
  types the code their terminal shows (kept in page state, not the URL), and
  nothing is preselected (read only or everything, some or all projects must be
  picked before Approve; the lifetime starts at 7 days), so a link someone else
  sends is not one click from a key acting as the person who opens it.
- `deployment:<id>` carries `{ type: "log", lines }` and, on every status or step
  change, `{ type: "deployment", deployment }` (`publishDeploymentChange(deps,
  serviceId, deploymentId)`).
- Uptime targets (`modules/uptime/targets.ts`): loopback, link-local, cloud
  metadata (169.254.169.254, 100.100.100.200, fd00:ec2::254,
  `metadata.google.internal`, `*.internal`), private and reserved ranges
  (IPv4-mapped and NAT64 included) are refused on save (BAD_REQUEST `reason:
  internalTarget`) and before every probe, unless every address is a node's
  own public address, or `settings.general.uptimeAllowInternalTargets` is on
  (admins, `settings.updateGeneral`). A domain row is no exception (it says
  nothing about where the name resolves). `checkTarget` returns the vetted
  address and the request connects to it (`http/pinned-fetch.ts`: Host header
  and TLS server name keep the host), so DNS rebinding cannot swap it.
  A name that does not resolve (an error or an empty answer) is never ok
  (`reason: unresolvable`): only `allowInternal`/the admin setting returns
  `byName` (no address), and `probe`/`listRemoteRefs` refuse a hostname URL
  with neither (`mayRequest`). An uptime check on such a name can still be
  saved; each probe records "Not checked: the name did not resolve".
  Probes never follow redirects and never echo the keyword. `git.branches`
  and the deploy's panel-side ls-remote use the same filter (admins may list
  private git servers) and do not follow redirects.
- Host ownership (`modules/domains/ownership.ts`): a host belongs to the
  service that routes it; another service may add paths under it only when
  the caller may edit that service's domains (CONFLICT `reason: hostTaken`).
  The panel domain, database `tlsHostname`s and `<slug>-db-*`/`<slug>-box-*`
  tool hosts are never service hosts; the panel domain and `tlsHostname`
  refuse service hosts too; custom certificates may not name hosts that
  belong elsewhere. Templates need `domains.edit` for custom hosts.
- Git providers (`modules/gitProviders/`): connections to GitLab
  (gitlab.com or self-managed, also under a path), Gitea/Forgejo (any
  https:// URL) and Bitbucket Cloud (one workspace) hold one token sealed
  with purpose `git.provider`; `gitProviders.manage` (global, admins)
  creates, changes and deletes them (a new token from a browser session
  needs a fresh sign-in, see Re-auth), and the token is checked with the
  provider before it is saved. Every API request goes to the connection's
  own API base only (`http.ts`): the address is vetted with
  `checkTarget` (cloud metadata and names that do not resolve are refused;
  private addresses are allowed, admins add connections) and the request
  connects to that address (no rebinding), redirects are refused, answers
  are capped at 8 MiB. A provider source is `{ type: "provider",
  providerId, provider, repo, branch, deployOnPush }`, written only by
  `gitProviders.connectRepo` (`services.setSource` and `services.create`
  refuse it); its clone URL is built from the connection's address, so the
  token only goes to that host. `connectRepo` creates a repository webhook
  (`git_provider_webhooks`, one per service, secret per hook sealed with
  purpose `git.webhook`) at `POST /api/hooks/<kind>/<hook id>` on the panel
  domain, else the address the caller reached the panel at; without either
  the row keeps the reason. GitLab hooks need an https:// address (its
  token is the secret itself, sent with every delivery), so a GitLab hook
  waits for the panel domain with that reason instead of using a plain
  http:// address; Gitea and Bitbucket sign the body and may (the Source
  tab warns). `updateSpec` drops the hook (row now, the provider's hook in
  the `gitProviders.removeHook` job) when the source leaves that
  repository, `deleteServiceTree` when the service goes, and the poll
  schedule (`repairHooks`, once an hour per service) re-creates hooks that
  are not on the current panel domain and hooks the provider refused to
  create (at the domain, else at the address they were meant for).
  Deliveries: GitLab `X-Gitlab-Token`
  (the secret itself), Gitea/Forgejo `X-Gitea-Signature` /
  `X-Forgejo-Signature` (hex HMAC-SHA256 of the body), Bitbucket
  `X-Hub-Signature` (`sha256=` + hex HMAC-SHA256), compared in constant
  time; a delivery id is required (`Idempotency-Key` or
  `X-Gitlab-Event-UUID`, `X-Forgejo-Delivery` or `X-Gitea-Delivery`,
  `X-Request-UUID`), a body seen by the same hook under another id within
  3 days is a replay (`webhooks/replay.ts`, also used by GitHub, keyed per
  hook because providers post one body to the hook of every service of a
  repository), a delivery id already handled for the hook's service is a
  duplicate (scoped to the service: GitLab before 17.4 sends sibling hooks
  of one push the same event UUID), rejected deliveries go to the
  service's delivery list with their own row id (20 an hour at most).
  Checked deliveries are rate limited per hook (20, then one every 3
  seconds; 429 with `Retry-After`, logged as rejected); unchecked ones do
  not use the budget. A push never builds a sha from the payload alone:
  the branch head the provider's API reports is deployed (a payload sha
  is used only when the API cannot say and the body is signed, never for
  GitLab's token). Every push path (provider and GitHub webhooks, both
  pollers) goes through `deployments/queue.ts` `queuePushDeploy`, newest
  head wins: a push while a push deploy of the service's branch is still
  queued joins it: that deploy builds the newer head (its log says so) and
  the delivery is recorded as "A deploy was already queued", so at most
  one push deploy waits behind the running one. A push while a deploy runs
  queues behind it; polling never skips a new head because a deploy runs
  (it records the head when it reads it, so a skipped head never
  deployed).
  Merge/pull requests are read from the API (state, head, fork check);
  previews follow GitHub's rules (shared-env acknowledgement, forks
  refused, `[skip ci]` in the title). Branch polling (`gitProviders.poll`,
  a schedule every minute) catches missed pushes at a cadence per service
  set by its webhook: every minute while it has none that was created,
  every 5 minutes as a safety net while it has one, and not at all while
  that hook delivered within the last 5 minutes (`source_polls.checked_at`
  holds the last look, failed looks included). Commit statuses
  (`statusNotes`, per connection) are posted by the
  `gitProviders.commitStatus` job from `onDeploymentChange`
  (`deployments/store.ts`): pending, running, success, failed, cancelled,
  with fixed descriptions (never the deploy's error: repository
  collaborators need not be panel members; the link leads to the
  deployments page); a commit shown as queued whose deploy a newer push
  took over is posted as cancelled "Superseded by a newer push";
  Bitbucket only with a public panel address (it requires a link).
- Watch paths (`@seylo/ops` `watch-paths.ts`, `services.setWatchPaths`,
  `spec.watchPaths`): ordered globs (`*` not across `/`, `**` across
  folders and `**/` also none, `?`, `!` excludes; anchored at the root; a
  trailing `/` means everything below); for each changed file the last
  matching pattern decides, with only `!` patterns everything else
  counts; a push deploys when one file counts. Matching never backtracks
  (`globMatches` runs the glob as a set of positions over the path once;
  repeats such as `**/**/` collapse), so a pattern cannot stall the panel
  on a deep path; a changed path longer than 4096 characters is not
  matched and makes the list incomplete (which deploys). `webhooks/gate.ts`
  `pushGate` runs on every push path (GitHub webhook and polling, provider
  webhooks and polling, the deploy trigger URL; stacks too): `[skip ci]`,
  `[ci skip]`, `[skip cd]`, `[cd skip]` in the head commit message skip;
  files come from the payload (`commits[].added/modified/removed`;
  truncated when GitLab's `total_commits_count` or Gitea's `total_commits`
  is larger, or GitHub's 2048 cap), else from the compare API between
  before and after (GitHub compare, GitLab compare, Gitea 1.22+ compare,
  Bitbucket diffstat `<new>..<old>`; capped answers count as incomplete);
  an unknown or incomplete list without a match deploys. A deploy writes
  the deciding line into its log (`queueDeploy({ notes })`); a skip is the
  delivery's detail. The trigger URL reads a JSON body in the GitHub,
  GitLab or Gitea push shape or `{ changedFiles }`; with only `?commit=`
  the files between the live deployment's commit and that one come from
  the source's compare API (`webhooks/compare.ts`). The web app's tester
  runs the same matcher.
- Sources and credentials (`modules/services/source-guard.ts`): a git
  credential only goes to its own host and a registry login to its own
  registry (checked on save and again before the token leaves the panel at
  deploy time); attaching a credential, registry login or GitHub App
  installation (or git provider connection) to a project needs
  `git.manage`/`registries.manage`/`github.manage`/`gitProviders.manage`
  unless a service of that project already uses it. Image
  sources (also compose members and templates) may not name loopback hosts
  or port 5755 (the registry relay). Non-managers listing credentials,
  registries, channels or the GitHub device account get names and hosts
  only; webhook URLs show scheme and host only. `apiKeys.list all` and
  `approvals.approve` need a browser session (deny works with keys).
- Env references (`modules/env/ops.ts` `checkEnvReferences`): a `${{svc.VAR}}`
  the caller may not read (env.view on the target, databases.credentials for
  database credentials; addresses are fine) is refused with FORBIDDEN
  `reference` on every path that writes a .env: `env.set`, compose
  preview/create/update (each member's `environment:`, the stack's own
  members count as the writer's) and `templates.create` (the template's own
  services count). A push to a stack's repo has no person to check, so it
  may not add references outside the stack other than addresses
  (`compose/references.ts` `assertPushReferences`).
- Audit events that are not ops: `writeAuditEvent` (`ops/audit.ts`) records
  `mcp.authorizeClient` (the person, with `decision` and `access`) and
  `hostShell.close` (the person, `nodeId`, `nodeName`, `openedAt`,
  `durationSeconds`, `reason`, with the duration in `durationMs`; the open is
  the `hostShell.open` op entry). Open host shells are rows in
  `host_shell_sessions` (their `last_seen_at` moves with the 30 s check), so
  the next panel start writes the close of those a restart or crash ended,
  with reason `the panel restarted`, `lastSeenAt` and the duration up to it. Anonymous
  client registration only goes to the panel log; `/oauth/register` is
  rate limited per address (strict class), clients nobody authorized are
  forgotten after 24 h, and at the 500-client cap the oldest unused one
  (older than 10 minutes) makes room.
- MCP tool results go through `redact(output, op.sensitive.output)` like the
  assistant's (env values, database passwords, `files.read` content).
- Alerts: a failure before anything shipped (queued/building) raises
  `build_failed` with key `build-failed:<buildId>` (the same key as the agent's
  BuildProgress FAILED, so it alerts once); later ones `deploy_failed`. A route
  reported `CERTIFICATE_FAILED` raises `certificate_failed` once per streak
  (key `certificate:<domainId>:<start>`) and stores the ACME error on the domain
  (`certificate.error`); ACTIVE resolves it. Issuer and expiry come from
  `RouteStatus.certificate_*`. Every durable `CleanupRun` is stored once per
  (node, run id) in `cleanup_runs` (newest 100 per node, with manual
  `cleanup.run` calls) and raises `cleanup_ran` (off by default, key
  `cleanup:<node>:<run>`) or `cleanup_failed` (`cleanup-failed:<node>:<run>`).
  `cleanup.setSchedule` is destructive (models need approval). It,
  `cron.create`/`cron.update` and a cron service's schedule
  (`services.create`/`services.update`) store Sunday as 0
  (`jobs/cron-expr.ts` `normalizeCronSchedule`: croner, and so 0.1 panels,
  also took 7, also as the end of a range, `1-7`, `MON-SUN`, which the
  agent's robfig/cron refuses; `1-7` becomes `1-6,0`, never `*`), and
  refuse what the agent still cannot read (`nodeCronProblem`: `L`, `W`,
  `#`). Rows saved before are normalized when read: the cron list, a cron
  service's detail and the desired state the node gets. A schedule the
  agent cannot read anyway is not skipped silently: the agent reports one
  failed `CronRun` per job and schedule (`unreadable-<hash>`, exit code -1,
  the parser's reason as its line; the same id after an agent restart, so
  the panel stores it once), and `cron_failed` shows that line. Alert
  sizes use the web app's units (binary steps, "3 GB").
- Bodies read before authentication are capped while streaming: op JSON
  bodies at 4 MiB (`maxOpBodyBytes`, `readBodyText` in `@seylo/ops/elysia`),
  the GitHub webhook at 5 MiB (after answering 404 without an App), git
  provider webhooks at 5 MiB (after answering 404 for an unknown hook id)
  and deploy trigger URL bodies at 5 MiB. The
  webhook needs `X-GitHub-Delivery`, records at most 20 rejected deliveries
  an hour, and answers `duplicate` for a signed body already handled under
  another delivery id within 3 days (in memory). The App's hook is created
  active (pointing at the IP:port address before a domain exists) and
  `syncWebhookConfig` moves it to the panel domain with the panel's secret
  when the domain changes. Deploy trigger URLs allow 10 calls then one per
  6 s per trigger; a call while a deploy is queued joins it (a newer
  `?commit=` replaces its commit).
- Registry GC: every successful deploy enqueues `deployments.registryGc`; a daily
  `deployments.registryGcSweep` retries services whose old images are still in
  the registry.
- Template logos: `logoUrl` is always `/api/templates/<slug>/logo.svg` (public):
  a built-in template's own `templates/<slug>/logo.svg`, else a generated
  monogram. No third-party logos.
- First-run IP:port also opens when an app without ports gets its first port
  (`services.update`, no domain yet) and for compose members whose file
  publishes a TCP port. Exposures record `openedBy` "ai"/"mcp" from
  `OpContext.transport`.
- Load balancing: `services.setPlacements { entryNodeId }` names the node that
  balances over the others (the rest serve their own replicas); null keeps every
  node balancing its own domains' traffic. A copy on another node is reached at
  `https://<node address>:5757`, where the address is its public IPv4, else
  public IPv6, else `facts.privateIpv4` (nodes on one private network). The
  balancing node sends GET/HEAD/OPTIONS through a Traefik `failover` service
  (`seylo-<id>[-pNNN]-retry`): a 502-504 from the pool is resent once to its
  own copies (up to 1 MiB of body is buffered); other methods are never
  replayed. A node with no copy of the service right now answers 503 on its
  LB entry point (a service with no servers), not 404.
- Node addresses: agents report `NodeFacts.private_ipv4` (the local address
  they dial the panel from, or the default-route address when the panel is on
  the same host; empty when that address is public). `nodes.publicAddress`
  (IPv4, IPv6 or a host name; `nodes.updateSettings`, admins) is the owner's
  override for 1:1 NAT clouds: never written by a connect, it wins over
  `publicIpv4`/`publicIpv6`/the private IPv4 in `domains/lookup.ts`
  `nodeAddress`/`nodeHost` (first-run and timed-expose links),
  `databases/info.ts` `exposedAddress`, the LB `remoteUpstreams`,
  `panelPublicUrl` and `panelUrl`. The panel node's is seeded once from the
  host the owner opened the setup link at (`nodes/address.ts`, setting
  `panelSetupHost`) when it knows no public address; the panel adds a
  `network.publicAddress` result to every node health check (warn when no
  public address is known). The join command's panel URL is the panel
  domain, else the panel node's public address, else its public IPv4, else
  the non-loopback address the caller reached the panel at (`OpCall.origin`),
  else the panel node's private IPv4 (`nodes/ops.ts` `panelUrl`).
- Deployments keep the env they started with (`deployments.env_sealed`,
  sealed JSON): an app's desired spec uses its target deployment's env, so a
  saved but undeployed env change, or a failed deploy, never reaches the
  running version. Databases and Boxes (no deployment) get the current env.
- Agent versions: the hello and `NodeFacts.agent_version` carry the bare
  version ("0.1.1"); `parseVersion` also accepts the older
  "0.1.0 (commit ..., built ...)". An update run's agent step finishes by
  version when the node already runs it, is busy updating itself (ABORTED) or
  answers ALREADY_EXISTS.

### Not built yet

Every item is a clear error or a placeholder, never a silent no-op. Go
stubs: `grep -rn 'stub.NotImplemented' go/internal`.

| What | Where it shows |
|---|---|
| `seylo panel start` and `seylo panel logs` on a node whose panel is not a managed service | NOT_IMPLEMENTED from `agent.PanelControl` only when nothing set it (`wire_node.go` sets it) |
| Panel TLS for agents is built: the installer (`--agent-tls-port`, default 3443, 0 = off) and `seylo panel bootstrap` set `SEYLO_AGENT_TLS_PORT`, publish it and open it in ufw/firewalld; the panel serves the agent endpoint there with a self-signed key from the data dir (`agent-tls.key`/`.crt`, made once) and join commands for a panel without a domain use `https://<address>:<port>` with `--pin sha256:<SPKI>`. Agents (and the installer) refuse a plain `http://`/`ws://` join to another host unless `--insecure` (config `insecure_transport`), which the join command carries only when the panel has no TLS port (`insecureTransport: true`, the card warns). Nodes that joined over the TLS port (or a domain) move to the panel domain by themselves once it is live (Protocol section). Not built: moving a node that joined over plain HTTP, to the TLS port or to the domain: a plain-HTTP session cannot prove the address it names comes from the panel, so the agent ignores it (logged once per start) | Nodes joined over plain HTTP keep working on their address and log a warning on every connect; join them again with the https:// command from the Add node card (`seylo join --force`) |
| Signed releases: `brand.minisignPublicKey` is a placeholder and no release was published (`make release` writes and signs `manifest.json`; tested only as a snapshot with a throwaway key). `make release` refuses to run until the key is set, matches `MINISIGN_SECRET_KEY` and the GitHub repo is pushable (`scripts/release-preflight.sh`) | `updates.check` stores "signing key is not configured"; agents refuse UpdateAgent with FAILED_PRECONDITION; the installer refuses to download without `--allow-unsigned` |
| `UpdateDocker` (Docker updates from the panel) ran against scripted apt/dnf output only. Panel self-update, node updates through an update run (panel step first, then one agent step per node) and the broken-image rollback ran in `make e2e` (RESULTS.md checks 1, 2, 22), and so did the update from the 0.1.1 release (built from its tag) to this build with real rows (check 38), against a local release mirror with a test key, not a real GitHub release | Unit tests only for Docker updates |
| Database TLS: Mongo, the Redis-like engines and ClickHouse's native port get TLS from the agent's portgate (VM-tested with redis-cli/valkey-cli `--tls`, mongosh `tls=true` and clickhouse-client `--secure` against real containers; plain clients get nothing), but not through a real panel yet; MariaDB keeps its own generated certificate; the ACME certificate for `tls_hostname` ran with Pebble, not Let's Encrypt. ClickHouse's HTTP port (8123) is never exposed: only the native port is, and the HTTP interface is internal (`INTERNAL_HTTP_URL`) | MariaDB clients see a self-signed certificate; HTTP clients of ClickHouse reach it from the same node only |
| Exposed database users through the real panel ran for Postgres (e2e checks 10 and 37: TLS-only user, `psql sslmode=require`, plain refused), Valkey (`valkey-cli --tls`, plain refused) and ClickHouse (`clickhouse-client --secure`) in check 37; MySQL/MariaDB/Mongo/Redis exposure is VM-tested on the agent side only | Unit and VM package tests |
| The engines added in 0.2 ran through the agent's VM package tests (create, client, web UI, exposure, backup and restore through MinIO; every offered version), the panel's unit tests and Playwright; Valkey 9.1, ClickHouse 26.8 and Postgres 18 with pgvector also ran through `make e2e` (check 37: created by the panel, an app reaching them by references, the database shells, TLS exposure, backups to MinIO and restores). KeyDB and Dragonfly did not run through a real panel | Unit, VM package, browser and e2e tests |
| Engine changes in place: a Postgres database cannot switch to or from pgvector (the pgvector images are Debian, the plain ones Alpine: a different collation library under the same data) or change major version; no engine changes major in place | Create a new database and restore a dump into it |
| Dragonfly has no append-only file: it runs with `--dbfilename dump --df_snapshot_format=false --snapshot_cron "*/5 * * * *"`, so a crash loses up to five minutes of writes (a stop saves first). Only Dragonfly 2.0 is offered | Behaviour as described |
| KeyDB publishes no multi-arch version tag and has had no release since 6.3.4 (2023): it is pinned by the digest of its `latest` index, which is `x86_64_v6.3.4` + `arm64_v6.3.4`. It gets no security fixes: the 2025 Redis Lua scripting advisories (CVE-2025-49844 use-after-free RCE, CVE-2025-46817, CVE-2025-46818, CVE-2025-46819; fixed in Redis 6.2.20 and Valkey) are unpatched in it, and its one `default` user may run scripts. The New database form, `databases.engines` (`notice`) and the op descriptions say so and point to Valkey; `databases.setExposure` refuses KeyDB without `allowedCidrs` (`exposure.needsAllowedCidrs`, reason `allowlistRequired`). Lua stays on (renaming EVAL would break clients such as BullMQ) | One KeyDB version, unmaintained, exposed only to listed addresses |
| ClickHouse restores replace the databases the backup holds (like `pg_dumpall --clean`), renamed aside until `RESTORE` succeeds: while it runs the disk holds both copies, and a database `RENAME DATABASE` cannot move (it needs the default Atomic engine) stops the restore before anything changed. If putting the copies back fails too (the server went down), they stay as `<name>__seylo_pre_restore_<time>` and the restore error says so. Users and grants are not restored over existing ones. ClickHouse and Dragonfly take a new admin password by restarting with the new environment (`passwordChange: "restart"`), not live | Behaviour as described |
| Boxes and backup `stop_service` against the real runtime: sleep/wake ran with a fake `SetSleeping`/`Resolve` | Unit tests only |
| Runtime gaps: resource changes roll a new container instead of `docker update`; the portgate's `Resolve` may still pick an unhealthy replica (routes skip it); a brand slug with a dash would nest `<slug>.slice` under the systemd cgroup driver (`seylo` has none). The systemd driver path ran in a VM with `native.cgroupdriver=systemd` (docker, reconcile, wings incl. games-first CPU through systemctl, proxy, agent, jobrun, metrics, nodecheck packages) | Behaviour as described |
| Observe Docker access goes through `console/dockerapi`, not `d.Docker`: kept on purpose. It needs raw multiplexed log frames with `until` (partial lines, the restart cursor), separate stdout/stderr for non-TTY exec, exec inspect for the process sweep, destroy events and one-shot stats, none of which `docker.Engine` exposes; moving it would mean five new Engine methods and re-verifying logs capture, console, shell and metrics for no user-visible change. It only reads, attaches and execs | Two Docker clients in the agent (both scoped to our containers) |
| Networking gaps: UDP public ports (portgate relays TCP; `portgate.ErrUDP`), the real next-to-Wings test (the Wings fork change is not made yet; the shared mode and its LB Traefik ran with a stand-in Traefik in the VM), ACME failures are read from the last 24 h of Traefik's log only. The `network.firewall` check names closed portgate ports but not 5757 on nodes with load-balanced services (it would need the other nodes' addresses in the agent) | Logged errors / reopen links |
| GitHub: sign-in, linking and the repo-access device flow use the GitHub OAuth App client id in `brand.oauthClientId` (`SEYLO_GITHUB_CLIENT_ID` overrides it for sign-in and linking); they, the App manifest flow, installations, webhooks and polling are tested only against a mocked GitHub (`test/playwright/run.sh` gives its panel a placeholder id, so the browser tests never call github.com); a public git repo build was not run | Tested against mocks; with a placeholder id sign-in and linking answer UNAVAILABLE (`githubAvailable: false`) and the device flow NOT_IMPLEMENTED |
| Moving compose stacks or their members (compose files from any git host are read through the agent's `FetchGitFile`), to another node or another project; cloning a whole stack (members clone one by one, as standalone apps) | CONFLICT `reason: compose` |
| Clone and project move gaps: a service with open PR previews cannot change project (close them first); app volume data copied without stopping the source may be inconsistent (the dialog stops it by default); a compose member cloned standalone keeps references to the other members' compose aliases, which only resolve in the same project; literal host names are matched by service name, not by compose aliases; a project move's route switch through a real Traefik is unit-tested only (the VM tests check `Resolve` and Docker DNS, not an e2e curl through Traefik during the switch) | CONFLICT `reason: previews`; the dialog lists references |
| `BuildSource.image` (mirroring private images into the panel registry) is not used | Each node pulls private images itself with `ImageRef.auth` |
| The AI assistant against the real Anthropic API and real MCP hosts (tested with a scripted client and `app.handle`) | Works as tested |
| Real-agent checks not done yet: `FetchGitFile` through the panel (compose from a git host; tested against a local git http-backend), backups to a real cloud bucket (MinIO only), Mongo/Redis/MySQL databases, Boxes. Load balancing has no active health check of other nodes: a dead node's share is retried on the balancing node's own copies per request (GET/HEAD/OPTIONS only; a POST to a copy that just died fails once) | Covered by unit, fake-agent and VM package tests |
| CLI sign-in: `cliLogin.approve` keeps `readOnly` optional (the web page always sends it; an API client that leaves it out gets full access, as before; the lifetime defaults to 7 days like the page). `viewerAddress`, the audit details, the per-computer limit and the `security_change` alert on every approval are built | API clients choose their own scope |
| Removing or changing the panel domain after nodes moved to it: `settings.updateGeneral { domain: null }` (or a new domain) drops the old domain's route at once. Nodes that joined over the agents' TLS port keep it as a standing pinned fallback and come back through it after 5 minutes (then move to a new domain by themselves); a node whose address before the move was an unpinned https:// address (another domain) has no fallback after the first cycle and cannot reach the panel until it rejoins (`seylo join --force`). Plain-HTTP nodes never move, so this does not reach them | Those nodes go offline after a domain removal or change; the node offline alert fires |
| Re-auth scope: member invites, project and service grants and demotions are not gated (scoped access only), and API keys never are (admin keys may invite admins, promote and create join tokens, since every key was made under a fresh sign-in). Passkey and GitHub re-auth ran in Playwright against a stubbed browser passkey prompt and mocked GitHub answers (the test panel has no domain or client id); the real passkey assertion is checked by the panel's own tests only | Behaviour as described |
| Disk alert threshold: the agent's DISK_LOW line is fixed at 85% (data dir and Docker root, every 10 minutes); the panel has no setting for it (the scheduled cleanup's own disk line is a setting) | Fixed threshold |
| Scheduled cleanup: agents before 0.2 ignore `NodeSettings.cleanup` (the Cleanup view says so by the agent version); runs missed while the agent was down are not caught up; the disk trigger's pacing (an hour, 6 hours) is fixed | Behaviour as described |
| Host shells: the shell runs as the agent's user in the agent's cgroup, so an agent restart or update ends it; processes started in their own session (`setsid`, many daemons) survive closing it, like an SSH logout; there is no session recording (the audit log has who, the node, when and how long); a panel restart ends every open one (the next start writes its close with reason `the panel restarted` and the duration up to the last 30 s check, so the real end can be up to 30 s later) | Behaviour as described |
| Screens: no Settings screen to add git credentials or registry logins (`git.createCredential`, `git.generateSshKey`, `registries.create` through the API; the Source tab picks stored ones), none for a compose stack's `${VAR}` values (`env.set` on the stack) | API only |
| Docker Hub browsing: Docker Hub only (no GHCR, Quay or other registries' catalogs); inspect reads one platform's config (amd64 or arm64; other CPUs are listed only); search shows no publisher logos (no third-party images, monograms instead) and pages stop at 20; private repositories are browsed only by people with `registries.manage`; the popular images row is a list in code (`components/docker-hub/popular.ts`). Nodes pull an image anonymously (their own address's limit) unless the form picked a Docker Hub login; that login is added with `registries.create` (no Settings screen yet, see Screens) | Behaviour as described |
| Git providers: the GitLab and Bitbucket clients are tested against recorded answers in `apps/panel/test/fixtures/git-providers/` written from the providers' documented responses, not captured from live accounts; no real gitlab.com, self-managed GitLab or Bitbucket Cloud run yet. Gitea ran for real (`scripts/dev/it-gitea.sh`, Gitea 1.24.6). Not built: compose stacks from a provider repository (`compose.ComposeSource` has GitHub and git URLs only), GitLab system hooks (one hook per service instead), Bitbucket Atlassian API tokens (workspace or repository access tokens and app passwords only), provider servers with self-signed certificates (the panel and git use the system roots), "Retry failed" for provider deliveries (GitHub only), watch paths for previews (every push to an open request deploys its preview), a watch paths editor on a stack's Source tab (`services.setWatchPaths` works for stacks), conditional requests in provider branch polling (GitHub's poller sends ETags; providers are read every 5 minutes at most while their webhook exists), "superseded" statuses for GitHub push deploys (GitHub pushes join a queued deploy too, but the panel posts no GitHub commit statuses) | GitLab/Bitbucket: fixture tests only; the rest as described |
| Panel moves and panel backups: no way to move the panel to another server, no built-in backup schedule for `panel.db`/`master.key` (update snapshots only) | Docs say to copy `/var/lib/seylo/panel/` |
| LB mutual TLS across agent versions: an agent from before `NodeSettings.lb_tls` support ignores it, presents no client certificate, and nodes that enforce it refuse its forwarded traffic (GET/HEAD/OPTIONS fall back to the balancing node's own copies) until it updates | During an update run only |

### Verification

Besides the unit tests, the Go packages that drive Docker have integration
tests that run in a Linux VM (`scripts/dev/vm-gotest.sh`), git providers
run against a real Gitea in that VM (`scripts/dev/it-gitea.sh`: the panel
test `gitea.integration.test.ts` and the agent's `TestITGiteaPrivateClone`), the web app has
Playwright suites (`test/playwright/run.sh`), and `make e2e` runs the real
installer on three fresh VMs and 38 end-to-end checks against test-signed
releases from a local mirror (`test/e2e-colima/README.md`; the evidence of
the latest run is in `test/e2e-colima/RESULTS.md`). Every op contract has a
handler.

The first-run port's automatic close (24 h after the domain is live) is
checked by moving the stored `closeAt` into the past and waiting for the
panel's own sweep. Check 31 (panel domain, runs last and undoes itself)
gives the panel an sslip.io name of A with a Pebble certificate: HTTPS, HSTS
only on HTTPS, a Secure HttpOnly session cookie from a sign-in over HTTPS,
IP:port pages 302 to the domain (API and loopback not), the macOS CLI
against the domain, and nodes moving to it: the panel turns the domain
active itself (a test build trusts `<data dir>/panel/test-ca.pem`), closes
B's and C's connections, they move (no pin, `fallback:` with the old
address), dial A:443 only, come back on the domain after an agent restart
(the pinned fallback now `standing: true`) and, once the domain is removed,
return to `https://<A>:3443` by themselves within about 7 minutes (5 minutes
of failed connects first). Kept VMs move to the working tree with
`make e2e-refresh` (`test/e2e-colima/refresh.sh`: the next test release
through the panel's own update, which applies new migrations like any
update). Checks 32-38 cover the 0.2 features (Docker Hub against the real
Docker Hub, a Gitea provider with watch paths and `[skip ci]`, the
disk-triggered cleanup, host shells, clone and project move, Valkey,
ClickHouse and pgvector) and the update from the 0.1.1 release, built from
its tag, to this build with real rows (`0001_features` applies, rows and
keys survive, a cron job saved with 7 for Sunday reads 0 and runs).

## Capabilities

Defined per method in `agent_service.proto` / `panel_service.proto` (the
`capability` option) and read at runtime with `rpc.MethodCapability` (Go)
or the method descriptor's options (TS). Current names:

| Capability | Methods |
|---|---|
| `state.sync.v1` | GetNodeFacts, GetStateSnapshot, SyncDesired, ApplyService, RemoveService, RestartService |
| `build.run.v1` | Build, CancelBuild, UploadBuildContext |
| `build.git-file.v1` | FetchGitFile |
| `exec.run.v1` | Exec |
| `terminal.console.v1`, `terminal.shell.v1` | Console, Shell |
| `fs.basic.v1` | FsList, FsStat, FsRead, FsWrite, FsMkdir, FsRename, FsDelete, FsChmod |
| `fs.archive.v1` | FsArchive, FsExtract |
| `logs.follow.v1`, `logs.search.v1` | LogsFollow, LogsSearch |
| `metrics.read.v1` | GetMetrics, WatchMetrics |
| `tunnel.tcp.v1` | Tunnel |
| `backup.run.v1` | RunBackup, RestoreBackup |
| `node.prune.v1`, `node.update.v1`, `node.healthcheck.v1`, `node.troubleshoot.v1`, `node.reboot.v1`, `node.docker-update.v1` | Prune, UpdateAgent, RunHealthCheck, Troubleshoot, Reboot, UpdateDocker |
| `node.host-shell.v1` | HostShell |
| `node.agent-logs.v1` | AgentLogs |
| `routing.certificate-retry.v1` | RetryCertificate |
| `panel.report.v1` | ReportCrash, ReportEvent |
| `node.panel-update.v1` | UpdatePanel |
| `compose.parse.v1` | ParseCompose |
| `cron.run.v1` | RunCronNow |
| `volume.transfer.v1` | ExportVolume, ImportVolume |
| `panel.desired.v1` | GetDesiredState |
| `panel.registry-tunnel.v1` | RegistryTunnel |

An agent advertises a capability only once every method in it works.

Capabilities without methods name something new an agent handles in
messages it already takes. The area that implements it calls
`reg.Advertise(name)` while wiring (`rpc.Mux.Advertise`; naming a method
capability there is a registration mistake), and the panel reads it with
`ctx.agents.capabilities(nodeId)`, or from `nodes.facts.capabilities` while
the node is offline (`modules/databases/capability.ts`).

| Capability | Means |
|---|---|
| `database.engines.v2` | Valkey, KeyDB, Dragonfly and ClickHouse (`DatabaseEngine` 6-9): shells, web UIs, backups and TLS on the exposed port. The panel creates, moves or clones such a database only onto a node that advertised it, refuses exposure elsewhere, and the desired state never sends their exposure to an agent without it (an older one would relay the port without TLS) |

## Releases and updates

Release assets (GitHub release `v<version>` of `<githubOrg>/<githubRepo>`,
built by the Release workflow: `make release-draft`, then
`scripts/release-sign.sh` in the Sign job; `make release` does both locally):

- `<slug>_linux_amd64`, `<slug>_linux_arm64`: static agent binaries, and
  the laptop CLI as `<slug>_darwin_amd64`, `<slug>_darwin_arm64`,
  `<slug>_windows_amd64.exe`, `<slug>_windows_arm64.exe`, with
  `checksums.txt` (sha256 of the binaries, `install.sh` and
  `openapi.json`) and `checksums.txt.minisig`.
- `install.sh`: the rendered installer (`scripts/render-installer.sh`).
- `openapi.json`: the op API description (`scripts/gen-openapi.ts`); the
  docs sync their API reference from `releases/latest/download/openapi.json`.
- `<image>:<version>` and `:latest`: the multi-arch panel image
  (`deploy/panel.Dockerfile`, non-root uid 1000, data in
  `<dataDir>/panel`, health check on `/api/health`).
- `manifest.json` + `manifest.json.minisig` (minisign, prehashed): the
  update manifest. Fields: `schema` (1; absent means 1), `version` (no
  `v`), `releasedAt`, `changelogUrl`, `minAgent`, `minUpgradeFrom`,
  `panel {image, digest}` (digest required), `agents {"linux-amd64":
  {url, sha256, size}}` (size optional), `installer {url, sha256, size}`.
  Add-only; `update.Manifest` (Go) and `modules/updates/manifest.ts` read
  the same file.

Agent update (`UpdateAgent`): the agent verifies the signature itself with
`brand.MinisignPublicKey` (`SEYLO_UPDATE_PUBLIC_KEY` in the unit's
environment overrides it for test releases), refuses a version that is not
newer or is below `minUpgradeFrom`, downloads its binary, checks size and
SHA-256, runs `<new> version`, keeps the old binary in
`<dataDir>/update/agent.prev`, arms a systemd guard
(`seylo-update-guard` transient timer running the old binary's
`update-guard` after 3 minutes), swaps the binary atomically and restarts.
The new agent confirms after its first accepted handshake; otherwise the
guard restores the old binary and restarts it. Either way exactly one
durable `UpdateResult` (target AGENT) reaches the panel. Failures before
the swap are reported at once and returned as the RPC error.

Test-build overrides (the end-to-end tests only; release builds leave
them empty and use brand.json): link the agent and `releasetool` with

```sh
-X github.com/seylo-dev/app/go/internal/update.TestReleaseBaseURL=<mirror>/<org>/<repo>/releases
-X github.com/seylo-dev/app/go/internal/update.TestReleasePublicKey=<RW... test key>
```

`TestReleaseBaseURL` replaces `https://github.com/<org>/<repo>/releases`
(same layout) for auto-update on connect, the AGENT_TOO_OLD self-update
and manifest download URLs; `TestReleasePublicKey` replaces
`brand.minisignPublicKey` (`SEYLO_UPDATE_PUBLIC_KEY` still wins). Such a
binary logs "TEST BUILD" at start (`update.IsTestBuild`). The installer's
equivalent is a render-time key: `INSTALLER_TEST_PUBLIC_KEY=<RW...>
scripts/render-installer.sh <version> <out>` writes an install.sh that
trusts that key and warns "TEST BUILD" on every run.

Panel swap (`UpdatePanel`, on the panel's node): returns once accepted,
then pulls the new image, stops the protected panel service (reconcile
`Apply` with `stopped`), copies `panel.db` and `metrics.db` (with WAL
files) to `<dataDir>/update/panel-snapshots/`, starts the new image as a
new generation with deploy mode RECREATE, and waits until the state store
reports it RUNNING. On failure it stops it, restores the snapshot and
starts the old image. A journal (`update/panel-swap.json`) lets a
restarted agent finish or undo a swap: it is rewritten at each phase
(`healthy` right after the health check, `done` with the result before it
is queued). On start, `done` only re-queues the result and `healthy`
reports success; `starting` reports success when the new image is the
desired one and passes the health check, else rolls back like
`snapshotted`. A swap whose agent is stopping leaves the journal for the
next start instead of rolling back with a dead context, and a rollback
whose Stop fails never copies the snapshot over the database (the error
names the snapshot folder). Outcome: durable `UpdateResult`
(target PANEL). VM-tested against the real reconcile runtime
(`reconcile` `TestITPanelAdoptAndSwap`: adopt, swap, broken image rolled
back with panel.db restored). `Apply` uses the stored desired revision.

Test builds of the panel (the e2e only): `bun build` with
`--define __TEST_RELEASE_API_URL__='"<mirror>/repos/<org>/<repo>/releases/latest"'`
and/or `--define __TEST_RELEASE_PUBLIC_KEY__='"<RW... key>"'` compiles in a
release mirror and a throwaway minisign key (`modules/updates/manifest.ts`
`testReleaseOverrides`). They are build-time constants on purpose: no
environment variable can point a shipped panel at another release source or
key. Such a panel logs a "TEST BUILD" warning on start.

Docker update (`UpdateDocker`): reports `from`/`to` from apt or dnf/yum at
once, plus `warning` when Docker's live-restore is off (every service and
the panel stop while dockerd restarts); unless `dry_run` it upgrades the installed Docker packages in the
background and reports a durable `UpdateResult` (target DOCKER). Reboot
waits `delay` (default 5s) and refuses while an update runs (ABORTED).
Errors map to statuses: busy ABORTED, up to date ALREADY_EXISTS, bad
signature PERMISSION_DENIED, refused INVALID_ARGUMENT, no signing key or no
runtime FAILED_PRECONDITION, anything else UNAVAILABLE with the message.

Installer contract ("panel + node here"): `seylo panel bootstrap` writes
`<dataDir>/panel/setup-token` and `<dataDir>/panel/join-token` (one line
each, 0600, uid 1000), creates the `seylo-p-panelproject0000` network and
runs the first panel container as service `panel00000000000` in project
`panelproject0000` (generation 1, protected, published on the chosen port,
default 3000), waits for `/api/health`, writes config.yml with
`panel_url: http://127.0.0.1:<port>` and the join token, then prints
`http://<ip>:<port>/setup?t=<setup token>` (`<ip>`: the IPv4 route's
source, else the IPv6 route's in brackets, else a public interface
address; `<server-ip>` with a hint only when there is none). Join: `install.sh join --panel
<url> --token <t> [--pin sha256:<hex>]` runs `seylo join --no-start`, then
starts `seylo.service`. Re-runs update the binary and units and keep the
node; `uninstall [--purge]` removes the agent (and with `--purge` every
`seylo.managed` container, network, volume and the data dir).
Port check (before anything changes): a new panel install stops when
another program holds 80 or 443 (named from `ss -ltnp`) unless `--force`,
and when the panel port is taken; our own containers (a Traefik or panel
left by an earlier install) and Wings' Traefik on a Wings server pass, and
joins only warn.

Docker preflight: the installer refuses snap Docker (root dir under
`/var/snap` or the binary under `/snap`), a Docker without a
`docker.service` unit (the agent's unit requires it) and versions below
nodecheck's `minDockerMajor`, and warns below `recommendedDockerMajor`
(both rendered in from `go/internal/nodecheck/checks.go` by
`scripts/render-installer.sh`, so the two never disagree). It then turns
on Docker's live-restore (merges `"live-restore": true` into
`/etc/docker/daemon.json` with jq or python3, keeps the old file as
`daemon.json.before-<slug>`, checks it with `dockerd --validate` and runs
`systemctl reload docker`, which restarts nothing), because the agent runs
containers with Docker's restart policy off and a dockerd restart would
otherwise stop every service and the panel. It leaves an explicit
`"live-restore": false`, swarm mode and Wings nodes alone (with a warning).

Download checks: before anything else the installer downloads
`manifest.json` + `manifest.json.minisig` of the release (`latest/` for
"latest", then everything else from `download/v<manifest version>/`) and
verifies the signature with `brand.minisignPublicKey` (minisign when
installed, otherwise OpenSSL 3; with neither it stops). The binary must
match `agents["linux-<arch>"].sha256` and the panel image defaults to
`panel.image@panel.digest`, so `seylo panel bootstrap` starts the image by
digest. A manifest for another version than `--version` is refused. A build
with the placeholder key refuses to download unless `--allow-unsigned`
(`--binary` and `--image` need no download). The manifest readers expect
releasetool's layout (`json.MarshalIndent`, two-space indent);
`installer/test` checks that. `--release-url <base>` (or
`<PREFIX>_RELEASE_URL`) downloads from a mirror of
`https://github.com/<org>/<repo>/releases` (same layout); the e2e uses it
with its local release server.

Node CLI on the panel's node: `seylo panel setup-link` writes a new
setup token and restarts the panel container so it imports it.

## Agent hub, node state and desired state

Everything a module needs to reach nodes hangs off `deps.agents`
(`ctx.agents` in op handlers), typed in `apps/panel/src/agent-hub/hub.ts`
and `calls.ts`. Never build frames or touch sessions yourself.

Calling an agent. Methods are the keys of `AgentService.method` from
`@seylo/proto`; request and response types follow from the name.

```ts
const res = await ctx.agents.call(nodeId, "fsList", { root: { serviceId, volume }, path }); // unary, default timeout 30 s
const logs = ctx.agents.open(nodeId, "logsFollow", { target: { case: "serviceId", value: serviceId }, tail: 200 });
for await (const batch of logs) send(batch.entries);   // streaming; break or logs.cancel() sends CANCELLED
const shell = ctx.agents.open(nodeId, "shell", { message: { case: "open", value: { serviceId } } });
await shell.send({ message: { case: "input", value: bytes } });   // client/bidi streams; awaiting send is the backpressure
const file = ctx.agents.openRaw(nodeId, "fsRead", { root, path }); // raw bytes: file.body (download), file.writer (upload), file.response
```

- Options: `{ timeoutMs, signal, metadata }`; streams add `initialWindow`
  (default 256 KiB). The panel grants credit as the consumer reads, so a
  slow browser slows the agent instead of filling panel memory.
- Every failure is an `OpError`; let it propagate. `details.reason` says
  why: `offline` (UNAVAILABLE: no session, or it dropped mid-call),
  `timeout` and `cancelled` (UNAVAILABLE), `capability` (NOT_IMPLEMENTED:
  the agent did not advertise the method's capability; update the node),
  `agent` (the agent's status mapped to BAD_REQUEST, NOT_FOUND, CONFLICT,
  FORBIDDEN, NOT_IMPLEMENTED, UNAVAILABLE or INTERNAL; the message is the
  agent's own, except INTERNAL, which is generic).
- `open`/`openRaw` throw right away for offline and capability; later
  failures reject `done` / `response` and the iterator.
- `ctx.agents.capabilities(nodeId)` (null when offline) and
  `ctx.agents.supports(nodeId, "fsArchive")` decide what the UI offers.
- Wire details (`agent-hub/channel.ts`, `writer.ts`): both directions of a
  stream start with `Open.initial_window`; credit returns as the consumer
  reads, in WINDOW frames of at least half a window. Control frames go out
  at once; DATA is chunked to 32 KiB and round-robined per stream; a
  stream's half-close or final CLOSE never overtakes its queued DATA.
- Handshake: agents older than `deps.agents.minimumAgentVersion()` (panel
  version N-2 minor, raised by the release manifest's `minAgent`) get
  `HelloRejected { AGENT_TOO_OLD, min_agent_version }`; dev builds always
  connect. ServerHello advertises `panel.report.v1`, `panel.desired.v1` and
  `panel.registry-tunnel.v1` once the nodes module attached PanelService.
  HelloAccepted carries `panel_url = https://<panel domain>` and an empty
  `panel_pin` on every connect of a node that is not the panel node, once
  `panelDomainStatus` is `active` for the current domain (the hourly check
  reached `/api/health` there with the panel's public roots, so agents
  verify it with their system roots; `agent-hub/move-target.ts`); nothing
  before. When the domain check job sees the domain turn active, it closes
  the connection of every online node that did not dial the domain (the
  session's Host header, `hub.dialedHost`), so each reconnects and moves at
  once. `hub.dialedAddress` is the base URL the session reached
  (`requestOrigin` of the upgrade: https on the agents' TLS port or from the
  trusted Traefik, http on loopback); `nodes.get` returns it as
  `panelAddress` (null while offline) for the node sheet. A failed move (`NODE_ALERT_KIND_PANEL_MOVE_FAILED`) raises one
  `node_health_check_failed` alert per streak, resolved by the agent. Test
  builds only (compiled with the `__TEST_RELEASE_*` defines): the domain's
  HTTPS probe also trusts `<panel data dir>/test-ca.pem` (the e2e's Pebble
  root); a shipped panel never reads it.
- PanelService (`agent-hub/panel-service.ts`): ReportCrash stores
  `crash_reports`, ReportEvent stores `agent_reports` (30 days), both
  deduped by (node, outbox id), then fan out; GetDesiredState returns the
  current state unless the agent has that revision; RegistryTunnel relays
  to `Tunnel(RegistryTarget)` on the node with `nodes.is_panel_node` (the
  first node that joins).

Events. Subscribe in your module's `start(deps)`:
`deps.agents.onEvent("deployProgress", (nodeId, progress, event, meta) => ...)`
(kinds are the `Event.payload` cases: `stateDelta`, `deployProgress`,
`buildProgress`, `healthChanged`, `cronRun`, `backupResult`, `nodeAlert`,
`metrics`, `nodeFacts`, `updateResult`), `deps.agents.onEvent(listener)` for
all of them, and `deps.agents.onConnection((nodeId, online) => ...)`.
`meta` is `{ durable, outboxId }`: durable events came through
`PanelService.ReportEvent`, were stored first and arrive once per
(node, outbox id). Crash reports: `deps.agents.onCrash((nodeId, report,
{ outboxId, crashId }) => ...)`, once per crash, after the `crash_reports`
row exists.

Node state (actual state, in memory, no round trip): `deps.agents.state`
(`agent-hub/node-state.ts`). `get(nodeId)` returns `{ online,
connectedAt, facts, capabilities, synced, appliedRevision, services:
Map<serviceId, ServiceStatus>, latestMetrics }`; `serviceStatuses(serviceId)`
gives the service's `ServiceStatus` (phase, instances with health, routes,
open ports, tunnel URL) on every node that reports it;
`serviceUsage(serviceId)` its latest CPU, memory and network per node;
`latestMetrics(nodeId)`; `onChange(listener)`. Fed by a snapshot after each
connect plus StateDelta, HealthChanged, MetricsReport and NodeFacts events.
`synced` is false until the current session's snapshot arrived; after a
panel restart the store is empty until agents reconnect.

Desired state. After you commit a change to rows that end up on a node,
mark it dirty; never call ApplyService or SyncDesired yourself:

```ts
ctx.agents.desired.markDirty({ serviceId });   // deploy, rollback, spec/env/domain/volume/cron/backup change, service delete
ctx.agents.desired.markDirty({ projectId });   // project-wide change (networks, project delete)
ctx.agents.desired.markDirty({ nodeId });      // node setting (games-first CPU, wildcard, log retention, builds)
await ctx.agents.desired.settled();            // only when the op must wait until agents accepted it
```

Marks are synchronous, never throw, and coalesce (50 ms debounce). The
flusher (`desired/flusher.ts`, started by the nodes module) resolves
targets to nodes (`service_placements`, nodes it sent the service to, and
nodes that still report it), bumps `nodes.desired_revision`, compiles with
`compileDesiredState(db, nodeId, { revision, secrets, contributors })` and
sends ApplyService/RemoveService, or a full SyncDesired for `{ nodeId }`,
`{ all }` and on every connect. A deleted service, or one with no
placement on that node any more, gets `RemoveService { delete_data: true }`;
one that is only not runnable is dropped and keeps its data. Offline nodes
are not an error; a failed send turns into a full sync next time. The
connect sync waits for the node's state snapshot (at most 5 s), so services
deleted while it was away are purged with their data. Nodes are sent to in
parallel within a pass; desired-state calls time out after 15 s and a node
that timed out is skipped for a minute or until it reconnects. An
`accepted_revision` above the one sent (or a snapshot `applied_revision` at
or above the panel's counter, e.g. after a database restore) moves
`nodes.desired_revision` past it and resends. A spec the agent refuses
(ApplyService INVALID_ARGUMENT, or an entry of `SyncDesiredResponse.refused`
from agents that take the rest of the state) is logged and reported through
`deps.agents.desired.onRefused`; the deployments module fails that node's
result of the deploying generation with the agent's reason, raises one
`deploy_failed` alert (key `deploy-failed:<service>:<generation>:<node>`, the
same as an agent's DeployProgress FAILED) and the rollout ends at once with
the previous version as the target. A whole SyncDesired refused by an older
agent falls back to one ApplyService per service. Volume names follow the agent's datadir rule
(`services.volumeNamePattern`: no dots), checked in `insertService` too.

The compiler (`desired/compile.ts`) starts from the services module's
`serviceSpecFor`, adds `cron_jobs` and load-balancer upstream URLs
(`http://<other node IPv4>`), maps `NodeSettings` from `nodes`, then runs
contributors. A module that owns rows agents need registers one in its
`start()`: `deps.agents.desired.contribute({ name, service(ctx), node(ctx) })`
(`desired/contributors.ts`); `ctx.spec` / `ctx.settings` are changed in
place, in registration order. The networking contributor
(`modules/domains/contributor.ts`) sets env, routing, dev access, public
ports, database/Box specs and the global maintenance page.

Live topics the nodes module publishes (`modules/nodes/live.ts`): `panel` invalidates
`nodes.list`, `system.info`, `updates.status` on node changes and
`metrics.nodes`, `metrics.summary` on each metrics sample (about every
10 s); `node:<id>` invalidates `nodes.get`, `nodes.healthReport`,
`metrics.node`; `service:<id>` invalidates `metrics.service`, and
`services.get` (with `project:<id>` -> `services.list`) whenever a node
reports a change in the service's status.

Socket and ticket shapes for the web app live in the op contracts:
`StreamTicket` and `LogsSocketMessage` (`ops/logs.ts`), `TerminalTicket`,
`TerminalClientMessage` and `TerminalServerMessage` (`ops/terminals.ts`).
Terminal sockets carry raw bytes in binary frames and those JSON control
messages in text frames. Endpoints (the ops return the full `url`):
`/api/streams/logs?t=` and `/api/streams/terminal?t=` (WebSockets, same
origin only; a missing, used or expired ticket closes with 4401),
`GET /api/files/download?t=` and `PUT /api/files/upload?t=` (raw body,
20 GiB cap, or the declared `sizeBytes`). Tickets are single use, live one
minute, sit in memory (`agent-hub/relay.ts`) and re-check the action on
use. Terminal sessions close after 30 minutes without input or output.
Host shells (`modules/hostShell`) use their own socket,
`/api/streams/host-shell?t=`, with the same message shapes and the
terminal relay (`startTerminal` in mode `host`); their tickets live in
their own store and the session closes after 15 minutes idle.

Updates: `updates.*` read `manifest.json` + `manifest.json.minisig` from
the latest GitHub release, verified with
`brand.minisignPublicKey`. A run is update_runs/update_steps advanced by
the `updates.run` job: panel step (UpdatePanel on the panel node), then one
agent step per older node (UpdateAgent with the verified bytes); a durable
`UpdateResult` or the new version on reconnect finishes a step, 10 minutes
without either fails it and the run. `nodes.updateDocker` is a one-step run
finished by its `UpdateResult`. The release check runs every 6 hours
(schedule `updates.check`) and starts a run when auto-update is on.

Metrics: each `metrics` event feeds `modules/metrics/ingest.ts`: a 5-minute
in-memory window (range `live`) and `metrics.db` buckets 1m (26 h), 5m
(8 days) and 1h (35 days); `30d` groups hourly buckets by 6 hours. Network
rates come from the cumulative counters of consecutive samples.

## Placeholders

`oauthClientId` and `minisignPublicKey` in `brand/brand.json` may be
`PLACEHOLDER_*` (both are set here; a fork may leave them out); code checks
with `brand.PlaceholderPrefix` / `isPlaceholder()` and disables the feature
instead of failing. The site has its own brand file;
`scripts/dev/check-site-brand.sh` checks that both name the same site, docs
(`https://docs.seylo.dev`) and install URLs and GitHub repo.

## Panel areas

Modules live in `apps/panel/src/modules/<name>/` with their contracts in
`packages/ops/src/ops/<name>.ts`. Each schema file in
`apps/panel/src/db/schema/` belongs to one area. Paths are in `apps/panel`
unless noted.

| Area | Modules (ops + panel) | Other paths | Schema files |
|---|---|---|---|
| Agent hub and nodes: PanelService handlers, calls and streams to agents, in-memory node state, the desired-state compiler (DB rows to `DesiredState`/`ServiceSpec`), nodes (join tokens, can-build, wildcard, games-first, health checks, reboot, Docker updates), fleet updates, cleanup runs and schedules, relays for logs, metrics (rollups into metrics.db), console, shell, host shells and files | `nodes`, `updates`, `cleanup`, `logs`, `metrics`, `terminals`, `hostShell`, `files` | `src/agent-hub/`, `src/desired/`, `src/db/metrics/`, `drizzle.metrics.config.ts`, `drizzle/metrics/` | `infra.ts`, `runtime.ts` |
| People and access: setup link, email and password, GitHub device flow, sessions, TOTP and recovery codes, passkeys, API keys; users, invites and grants; the audit log; the op pipeline, permission checks and the op framework | `auth`, `setup`, `users`, `invites`, `grants`, `apiKeys`, `audit` | `src/auth/`, `src/security/`, `src/ops/`, `scripts/create-owner.ts`, `scripts/setup-link.ts` | `identity.ts`, `audit.ts` |
| Services and deploys: projects, services (all kinds, compose stacks split into members), deploys, builds, releases and rollback, PR previews, push-to-deploy webhooks and deploy triggers, watch paths, the per-panel GitHub App, GitLab/Gitea/Bitbucket connections, git and registry credentials, templates (QuickJS runner) and the template catalog, Docker Hub as a template source | `projects`, `services`, `compose`, `deployments`, `builds`, `previews`, `webhooks`, `github`, `gitProviders`, `git`, `registries`, `templates`, `dockerHub` | `src/template-runner/`, `templates/` (repository root) | `projects.ts`, `deploys.ts`, `git.ts`, `templates.ts` |
| Networking, env and data: domains, DNS checks and the Cloudflare DNS link, middlewares, first-run IP:port access and redirect-then-close, the env editor backend and `${{svc.VAR}}` references, databases (engines, credentials, web UIs, exposure with TLS), backups and restores, dev access (timed expose, Cloudflare tunnels), Boxes, maintenance pages, signing edge tickets (with the key from `security/edge-ticket-key.ts`) | `domains`, `env`, `databases`, `backups`, `exposures`, `tunnels`, `boxes`, `maintenance` | `packages/env-analyzer/` | `env.ts`, `networking.ts`, `backups.ts` |
| System and automation: notification channels, alert rules and delivery, uptime checks, the job runner and recurring schedules, cron jobs (panel side), approvals, the MCP server and its OAuth, the AI assistant (routing, budget, usage), settings (branding, white label, themes, custom CSS, telemetry), and the panel core around them | `system`, `settings`, `notifications`, `alerts`, `uptime`, `cron`, `approvals`, `mcp`, `ai`, `telemetry` | `src/{jobs,live,http}/`, `src/{main,panel,deps,config,settings,logger,ids}.ts`, `src/modules/module.ts`, `src/db/client.ts`, `packages/ops/src/generators/{mcp,ai-tools}.ts` | `automation.ts`, `ops.ts`, `mcp.ts`, `settings.ts`, `columns.ts` |

### Services and deploys

Shared shapes live in `ops/services.ts` (`ServiceSummary`, `ServiceDetail`,
`Source`, `HealthCheck`, `CrashPolicy`, `Resources`, `NodeRef`, `DataCopy`,
`MoveImpact`) and
`ops/builds.ts` (`BuildSettings`, `RepoPath`); other op files import them,
never the reverse. Permission actions: `projects.view|create|update|delete`,
`services.view|create|update|delete|deploy|control|scale|move` (project or
service scope), global `github.manage`, `git.manage`, `registries.manage`.

Clones (`services.clonePreview`, `services.clone`, `services/clone.ts`):
`services.view` on the source and `services.create` in the target project
(checked in the handler, `move-project.ts` `requireTargetProject`). A clone
copies the spec (source, build, container, ports, health check, crash
policy, resources, deploy strategy, cron schedule), notes, template slug,
replicas, volumes (names and paths) and a Box's or database's settings
row, never domains, deployments, cron jobs, backups, alerts, uptime
checks, deploy triggers, tunnels, exposures, maintenance pages or grants.
What the caller cannot read stays behind: the `.env` and file mounts need
`env.view` on the source, and since writing them needs it anywhere,
`env.edit` in the target project (file mounts also `files.write` there;
`clonePreview.env` says `hidden` or `noWrite`). The copied `.env` names the
clone where it named the source itself (`impact.ts` `renameSelf`:
`${{web.X}}` and `web` as a URL host or `host:port`; a value that is only
the name is kept and listed), and passes `checkEnvReferences` in the target
project; `clonePreview.references` lists the renamed ones (`renamed`) and
what points elsewhere. The newest upload archive needs `files.read`, database
logins come only with a data copy (`databases.credentials`; an empty clone
gets new passwords for every `service_secrets` name), other volume data
`files.read`, the main domain's access rules `domains.view` on the source
and `domains.edit` in the target (they go onto a new automatic domain
`<name>.<node wildcard>`). Push deploys and previews are off on the clone,
a compose member becomes a standalone app (`member: null`), compose stacks
and protected services are refused (CONFLICT `reason: compose|protected`).
The clone is created `stopped` and never deployed: `serviceSpecFor` sends
such a "parked" service as a stopped spec without an image (so its node
keeps its folders), and `services.start` of a stopped, never-deployed
service deploys it (needs `services.deploy`). Names default to
`<name>-copy`, `-copy-2`, ... (40 characters, free in the target project).
A data copy is a `service_copies` row and the slow job `services.cloneData`:
it stops the source when asked (always for databases, which needs
`services.control`), waits until its node reports it stopped, pipes every
volume ExportVolume -> ImportVolume through the panel (`relayVolume` with
`toServiceId`), records `bytesCopied`, and starts the source again
(`sourceStopped` survives a panel restart, and the row a deleted clone).
While a copy runs, `queueDeploy`, `services.start` and `boxes.open` refuse
the clone and a source it stopped, and `services.move` (to another node)
refuses the clone and any source it reads (CONFLICT `reason: copying`,
`copies.ts`); a second copy from the same source is refused. `ServiceDetail.dataCopy` is the
newest copy; the web shows it under the header.

Moves to another project (`services.moveProjectImpact`,
`services.moveProject`, `services/move-project.ts`, `impact.ts`): the op's
permission is `services.move`, and the handler also needs every grantable
service action on the service ("manage": the new project may give the
caller more than they hold now) and `services.create` in the target. The
impact lists services of the old project that reference the service
(`${{name.VAR}}` or its host name typed into a value,
`@seylo/env-analyzer` `hostMentions`), services of the new project that
already use its name, its own references and host names that point into
the old project (`unresolved` or `retargeted`), shared variables it stops
receiving, grants on the service and pending invites naming it; names and
keys only where the caller may see them. Blockers (CONFLICT, FORBIDDEN for
`access`): `sameProject`, `protected`, `compose` (stacks and members),
`preview` (a preview service), `previews` (open previews), `nameTaken`,
`deploying`, `copying`, `access` (also when the caller could not attach
the source's git credential, registry login, GitHub installation or git
provider connection in the new project, `source-guard.ts`: once a service
there uses it, every service there may), and `references`: a service of the new
project references the name for more than an address (an own variable or
a database credential, `isOpenVariable`), written while nothing had that
name, so its writer was never checked; the same rule makes a clone skip or
refuse such a name. With anything in the impact the op needs `confirm:
true` (CONFLICT `reason: confirm`). The service's own `.env` must pass
`checkEnvReferences` in the target. In one transaction the row's
`project_id` changes, grants on the service are deleted (access follows
the new project; a per-service grant would otherwise reach its shared
variables) and invite entries naming it removed. A running service gets a
deployment with trigger `move` and `deployments.project_move` (from, to,
removed grants and invite entries): the live image and run settings again,
no build, env sealed at start in the new project; the agent re-attaches or
rolls. Until that deployment ships (queued or building), `serviceSpecFor`
keeps the old project in the node's spec, so a recompile in between never
moves the containers ahead of their deployment. Success logs "runs on its new project's network"; failure or cancel
puts the project, grants and invite entries back (`project-move-restore.ts`
from the engine's `finish`) unless the old project is gone or took the name.
A stopped or never-deployed service just changes project (no deployment).
`compose.preview` and `templates.preview` are POST mutations (bodies too
large for a query string) that change nothing. Project collapse and order
are per person (`project_prefs`). Global `templates.manage` gates custom
templates.

APIs for other modules (all in `apps/panel/src/modules/`):

- `services/insert.ts` `insertService(tx, { projectId, name, kind, nodeId, spec?, volumes?, ... })`:
  the only way to create service rows (checks name, node and spec).
  `services.spec` JSON is `ServiceSpecJson` in `services/spec.ts`; run
  settings are snapshotted per deployment (`deployments.run_settings`),
  so they reach nodes on the next deploy.
- `deployments/queue.ts` `queueDeploy(deps, { serviceId, trigger, actor, waitFor?, ... })`:
  the only way to deploy. The runner (`deployments/engine.ts`) is a state
  machine on the deployment row, kicked by ops, agent events and the
  `deployments.tick` job (timeouts, recovery after a restart). A deploy
  switches `services.target_deployment_id` and marks the service dirty.
- `services/desired.ts` `serviceSpecFor(db, secrets, serviceId, nodeId)`:
  the services part of the desired state (the compiler calls it).
- `services/delete.ts` `deleteServiceTree(deps, row)`: a service with its
  compose members, previews, grants, uploads and registry images.
- `services/copies.ts` `assertNoActiveCopy(db, serviceId, { anySource })`:
  CONFLICT while a clone's data copy writes the service's folders or reads
  a source it stopped (`anySource`: or reads it at all).
- `services/impact.ts`: `ownReferenceEffects`, `referrersOf`,
  `sharedVariablesLost`, `plantedReferences`, `renameSelf` on plain project shapes
  (`projectEnvOf(buildEnvGraph(...))`), and `moveImpact` for an op caller.
- HTTP: `POST /api/hooks/github` (signature checked, GUID deduped),
  `POST /api/hooks/{gitlab,gitea,bitbucket}/<webhook id>` (git provider
  webhooks, see "Git providers"),
  `POST /api/hooks/deploy/<token>` (deploy trigger URLs),
  `POST /api/uploads/services/<serviceId>` (a `.tar.gz` source, then a deploy).
- Live: deployment log lines on `deployment:<id>` (`{ type: "log", lines }`),
  invalidations on `service:<id>`, `project:<id>` and `panel`
  (`deployments.recent`, `builds.queue`).
- Templates run only in `apps/panel/src/template-runner` (QuickJS-wasm,
  32 MiB, 1 s); the catalog format is `templates/README.md`.
- Docker Hub (`modules/dockerHub/`): `dockerHub.search`, `dockerHub.tags`
  and `dockerHub.inspect` are `signedIn` queries like the template catalog
  (MCP too, not audited); `dockerHub.create` needs `services.create` on the
  project and audits with `env` redacted. Search ranks images named exactly
  like the query first (the official one, then by pulls), then official
  images and verified publishers, then the rest in Docker Hub's order
  (website search `api/search/v4`, images only; `v2/search/repositories`
  when v4 fails); a query of several words is also looked up hyphenated.
  Pages go up to `searchMaxPage` (20, 25 results each): `hasMore` is false
  there and the web's "Show more" stops. Tags come newest first, 100 a page,
  with `suggested`: the most specific version tag with latest's digest
  (looking one page further when needed), else latest. Inspect reads the
  config for linux/amd64 or linux/arm64 (the caller's `arch` first):
  anonymous token from auth.docker.io, a free HEAD for the digest, the
  manifest list, the platform manifest and the config blob (at most 2 MiB),
  each checked against its sha256. What is kept of a config is capped
  (`configLimits`: 200 items a list, names 256 characters, values 4000,
  label values 2000, VOLUME paths 500, and 64K characters for the whole
  config, `configBudget`); an ENV entry whose value is too long is left out
  rather than cut, so the image's own default applies. `registryId` is the
  login a private image was read with (null for public ones); the web form
  preselects it. `client.ts` contacts only `http.ts` `dockerHubHosts`
  (hub.docker.com, auth.docker.io, registry-1.docker.io and Docker's blob
  CDNs production.cloudflare / production.cloudfront.docker.com and its R2
  bucket) over HTTPS, follows redirects by hand only among them and never
  carries the Authorization header to another host; bodies are capped while
  read. A redirect to any other host answers `UNAVAILABLE` naming that host
  ("Docker Hub sent this panel to <host>"), and the panel log's `docker hub
  request failed` line carries it in `detail`: that is the host to add when
  Docker moves its CDN. Caches are in memory per panel: search 10 min, tags
  30 min, configs by digest 7 days, tokens until they expire. A 429 answers
  `RATE_LIMITED` (`details.reason: dockerHubRateLimit`, `retryAfterSeconds`)
  and the client asks nothing more of that limit (Hub API, the
  auth.docker.io token server, HEADs, anonymous pulls, login pulls) until it
  lifts. The oldest registry login for Docker Hub (`registries`, server
  docker.io or an alias) is the panel's Docker Hub login: public images
  (proven by the anonymous HEAD) are pulled with its token so inspecting
  spends its limit; its private repositories are read (tags through a Hub
  API token from `/v2/auth/token`) only for callers with
  `registries.manage`, and those answers are cached apart. A refused login
  is not retried for 5 minutes. `dockerHub.create` makes one app like a
  template app (`templates/install.ts`): image `<repository>:<tag>`
  (`imageRef`, official images without `library/`), optional `registryId` (a
  Docker Hub login, `assertSourceAllowed`), main TCP port, volumes named
  from their paths (`volumeNameFor`), optional `command` (replaces CMD), the
  .env (syntax checked, `checkEnvReferences`), the node's automatic domain
  or first-run IP:port when `public` (default), then `queueDeploy` (trigger
  `manual`) unless `deployNow` is false; the row is deleted again when a
  later step fails. Tests replay recorded answers
  (`test/fixtures/dockerhub`, `record.ts` re-records); `DOCKERHUB_LIVE=1`
  runs one live search, tag list and inspect.

### Networking, env and data

- Desired state: the domains module registers `networkingContributor`
  (`modules/domains/contributor.ts`) with `deps.agents.desired.contribute`.
  It sets a service's `routing`, `devAccess`, `PortSpec.public`, `env` and
  the database/Box `kindSpec`, and `NodeSettings.maintenance`. The pieces
  are plain functions other code may call: `serviceNetworking` and
  `globalMaintenance` (`domains/desired.ts`), `resolveServiceEnv`
  (`env/desired.ts`), `databaseRuntime` (`databases/desired.ts`),
  `boxRuntime` (`boxes/desired.ts`). Env values resolve through one
  project graph (`env/graph.ts`): built-in variables, every service's own
  keys across references (loops stay unresolved and the analyzer reports
  `reference-cycle`), shared variables injected into every non-database
  service (own keys win). Because the container resolves references
  whoever wrote them, `env.set` refuses (FORBIDDEN, `details.reference`) a
  `${{target.VAR}}` the caller could not see in the References list
  (`env.view` on the target, `databases.credentials` for database
  secrets; addresses are open). Shared variables reach every service of the
  project, so anyone who can run code in one service of a project can read
  them: a per-service grant is not a boundary for shared variables.
- Edge tickets (`modules/databases/edge-ticket.ts`; the agent's
  `edge.TicketVerifier` must accept exactly this): token
  `<payload>.<signature>`, both base64url without padding; payload is the
  JSON `{"v":1,"sub","uid","exp","jti"}` (`exp` in Unix seconds, 60 s
  after issue, single use by `jti`); signature is Ed25519 over the ASCII
  `<slug>-edge-ticket-v1`, a 0x00 byte, then the payload string. Subjects
  `db-ui:<serviceId>` and `box:<serviceId>`. Links are
  `https://<slug>-db-<serviceId>.<wildcard>/_<slug>/ticket?t=<token>` and
  `https://<slug>-box-<serviceId>.<wildcard>/_<slug>/ticket?t=<token>`;
  without a wildcard domain on the node the ops answer CONFLICT
  (`details.reason` `noWildcardDomain`).
- Regenerate certificate (`domains.retryCertificate`,
  `modules/domains/certificate-retry.ts`): a mutation with `domains.edit`
  on the service (an API key needs that action and must not be read-only,
  as MCP tokens are by default; `mcp: true`, a mutation and never
  destructive, so models need no approval), audited, refusals included. Only `https: acme` domains whose certificate is
  pending or failed (CONFLICT `reason` `notAcme`, `certificateValid`). Once
  a minute per domain, in memory (RATE_LIMITED `reason: certificateRetry`
  with `retryAfter`; a refused try does not start the minute). DNS is
  looked up now (and stored): `missing` or `wrongTarget` is refused
  (CONFLICT `reason: dnsNotPointing`, the DNS check's message plus why),
  since Let's Encrypt validates through that record and counts every
  failed validation (5 per host name per hour). The agents asked are the
  online placed nodes the record points at (every online placed node when
  it is `proxied` or `unknown`); none online is UNAVAILABLE, one without
  `routing.certificate-retry.v1` is CONFLICT `reason: agentTooOld` ("Update
  the node first") before any call. A node's own refusal comes through
  when no node took the retry. Then `cert_status` is `pending` until the
  next report; the `certificate_failed` alert stays open until a route goes
  ACTIVE. The web's row shows "Generating SSL certificate" with a spinner
  while pending and, when failed, the CA's reason with "Regenerate
  certificate" (also in the row's menu and the certificate dialog); an
  error naming the CA's rate limit (429, `rateLimited`, "too many ...")
  explains the 5-per-hour limit.
- Route ids are domain ids: `RouteStatus` reports update the domain's
  certificate state and `liveAt`; when the primary domain goes live,
  first-run IP:port switches to redirect (24 h) then closes
  (`exposures/logic.ts` `applyDomainLive`). Ports the agent picked
  (listen port 0) are recorded from `ServiceStatus.open_ports`.
- `openFirstRun(tx, serviceId)` (`exposures/logic.ts`) is for the
  services module to call when it creates an app with a port.
- Recurring work (60 s schedules): `exposures.sweep`, `backups.schedule`,
  `tunnels.expire`; restores run as the `backups.restore` job (one
  attempt). Backup results come from durable `BackupResult` events;
  `backup_id` is the policy id, or `manual` for one-off runs (kept until
  deleted).
- Database engines (`modules/databases/engines.ts`, listed by the
  `databases.engines` op): Postgres 18 (default, data at
  `/var/lib/postgresql`), 17, 16, 15 and the `pgvector` variant of each
  (`databases.create { variant: "pgvector" }`, `service_databases.variant`,
  `pgvector/pgvector:0.8.7-pg<major>-trixie`), MySQL, MariaDB, Mongo,
  Redis, Valkey 9.1/9.0/8.1, KeyDB 6.3, Dragonfly 2.0 and ClickHouse
  26.8/26.3, every image pinned to an exact release (KeyDB by digest).
  KeyDB carries `notice` in `databases.engines` (unmaintained, no security
  fixes, prefer Valkey) and `exposureNeedsAllowlist`: `setExposure` refuses
  it without `allowedCidrs` and `exposure.needsAllowedCidrs` tells the web
  app to ask for them first.
  Valkey and KeyDB start through their image's entrypoint (non-root) with
  `--requirepass "$<ENGINE>_PASSWORD" --appendonly yes`; Dragonfly takes
  `DFLY_requirepass` from the environment; ClickHouse gets a generated admin
  user (`ch_` + 10 characters) from `CLICKHOUSE_USER`/`_PASSWORD`/`_DB`
  with `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1` (so it can create the
  exposed user), and its health check reads `/ping` on the container's own
  address (the first start serves 127.0.0.1 only). ClickHouse adds
  `INTERNAL_HTTP_URL` (`http://user:password@<name>:8123/<db>`, a
  credential) and `INTERNAL_HTTP_PORT` to the references; exposed URLs
  carry `secure=true` (and `skip_verify=true` with a self-signed
  certificate). The Redis-like engines have one user (`default`), used over
  TLS when exposed.
- Databases and Boxes are created with `insertService` and `queueDeploy`.
  Credentials live in `service_secrets` (`admin_password`,
  `exposed_password`, purpose `service.secret`); password resets run in
  the database through the agent's `Exec` with the password on stdin.
- DNS checks use public resolvers (1.1.1.1, 8.8.8.8);
  `domains/dns.ts` `setDnsLookups` swaps them in tests.

## Web app

`apps/web`, with the UI kit in `packages/ui`.

- Screens: the shell (sidebar, command palette, layouts), dashboard,
  project page, nodes (the node sheet's views: overview, health, cleanup,
  shell, settings in `components/nodes/`), templates (with its Docker Hub
  tab, `?tab=docker-hub`, the image form and the popular images in
  `src/components/docker-hub/`), setup and login are
  `src/routes/{__root,_app,login,setup}.tsx`, `src/routes/_app/` and
  `src/components/`. Every service and database page with all its tabs
  (overview, deployments, source, environment with Monaco, domains, logs,
  console, shell, metrics, storage and the Files popup, backups, previews,
  cron jobs, alerts, advanced, notes, settings, connection) is
  `src/routes/_app/p/$projectId/s/` and `src/components/service/`, with the
  tab sets per kind in `src/components/service-tabs.ts` (`tabsFor(kind)`).
  Every settings page, the activity (audit) page and approvals are
  `src/routes/_app/settings/`, `src/routes/_app/{activity,approvals}.tsx`,
  `src/components/settings-nav.ts` and `src/components/settings/`. Nothing
  is mocked in shipped screens.
- Live data: `lib/live.ts` `listen(topic, fn)` for topics with payloads
  (deployment logs), `useLiveUp()` to poll only while the socket is down.
  The saved accent's CSS is `lib/accent.ts` (the panel's boot.ts emits the
  same string).
- Re-auth: `lib/api.ts` wraps the one op client in `withReauth`
  (`lib/reauth.ts`), so any mutation refused with
  `details.reason: "reauth"` opens the dialog mounted once in `main.tsx`
  (`components/auth/reauth-dialog.tsx`: password, authenticator or
  recovery code, or passkey from `auth.security`, else sign in again) and
  runs once more after `auth.reauth`; nothing per op is needed. A closed
  dialog fails the call with `isReauthCancelled(error)` true, which
  `toastError` and the screens keep quiet. `/reauth?redirect=<path>` is the
  same form as a page (for the MCP consent page). `?redirect=` on `/login`
  and `/reauth` goes through `lib/redirect.ts` `safeRedirectPath`, and
  `validateSearch` always returns the key, because the router keeps raw
  search values a route leaves out.
- Shared helpers: `lib/theme.ts` (`refreshBoot()` after an appearance or
  branding save, `useBoot()`), `lib/format.ts`, `lib/types.ts`,
  `lib/service-display.ts`, `components/query-error.tsx` (`QueryError`
  renders 501 as "not built yet"), `components/pickers.tsx` (`NodePicker`,
  `ProjectPicker`). In `components/service/`: `editor/code-editor.tsx`
  (`CodeEditor`, lazy Monaco with only the editor worker),
  `editor/env-editor.tsx` (.env editor with env-analyzer markers, hovers,
  completions), `terminal/xterm-view.tsx` +
  `terminal/use-terminal-session.ts` (ticketed terminal sockets, one xterm
  write per frame), `op-state.tsx` (`OpErrorNote`, `retryOp`),
  `copy/` (the header's "..." `ServiceMenu` with the Clone and Move to
  project dialogs, and `DataCopyNote` under the header while a clone's
  data is copied). In
  `components/settings/`: `action-picker.tsx` (`ActionPicker`),
  `actions.ts` (labels from the `settingsActions` i18n section; a test
  fails when an action has no label), `grant-scopes.tsx` (`ScopePicker`),
  `device-code.tsx` (`DeviceCodePanel`), `paging.ts` (`useOpPages`).
- UI kit: shadcn-style components on the design tokens
  (`packages/ui/src/styles/theme.css`); `/dev/kit` (`src/routes/dev.kit.tsx`)
  renders every component, see `packages/ui/README.md`. New components go
  in `packages/ui/src/components/` and use tokens only. The kit's own words
  come in through `UiLabelsProvider` (the `kit` i18n section).
- Browser tests: `test/playwright/run.sh` starts a panel on a fresh data
  dir plus Vite and runs `smoke.spec.ts` (setup, sign-in, real panel),
  `databases.spec.ts` (the New database form with every engine, versions
  from the real panel's `databases.engines` and pgvector; the ClickHouse
  and pgvector Connection tabs),
  `flows.spec.ts` (CLI sign-in approval, keys, invites, 2FA, appearance,
  channels on the real panel), `reauth.spec.ts` (the re-auth dialog on the
  real panel: it ages the owner's sessions in `panel.db`, then API key,
  a git provider connection, authenticator setup, CLI approval, GitHub
  link, passkey and a node join command each ask first and go through;
  `/reauth`; sign in again),
  `git-providers.spec.ts` (Settings > Git providers, a provider repository
  in the Source tab and the watch paths tester, on the demo data),
  `dockerhub.spec.ts` (Docker Hub search, tag picker, prefilled form and
  create, popular images, with `demo/dockerhub.ts`),
  `nodeops.spec.ts` (the node sheet's Cleanup and Shell views with the demo
  data: saving a schedule, allowing and opening a host shell),
  `clone-move.spec.ts` (the Clone and Move to project dialogs on the demo
  data, with the ops answered and recorded per test) and
  `screens.spec.ts` (every screen with the demo data in `demo/`, in all
  four theme presets, plus the phone width and the accent check;
  screenshots in `$SHOTS_DIR/screens/<preset>/`; `PRESETS=` and `SCREENS=`
  narrow it).

## Proto files

`proto/seylo/agent/v1/` has one file per area (`proto/README.md` has the
rules). A new RPC touches two files: its messages go in the area's file,
the method line in `agent_service.proto`. Run `make gen` and commit the
`.proto` change with the generated code.

## Shared files and generated code

- Generated code is never edited by hand: `go/gen/`,
  `packages/proto/src/gen/`, `packages/brand/src/`, `installer/brand.env`,
  `installer/install.sh`, every `*.gen.ts` (op index, module index, i18n
  index, route tree), `openapi.json` and `apps/panel/drizzle/`. Change the
  source and run `make gen` (or `bun run gen`); migrations come from
  `bun run db:generate` in apps/panel. If a generated file conflicts in a
  merge, take either side and regenerate.
- The ops index (`packages/ops/src/ops/index.gen.ts`), the panel module
  index (`apps/panel/src/modules/index.gen.ts`), the i18n index and the
  route tree are generated: add your own file and run `make gen`.
- `apps/panel/src/security/secret-box.ts`: a new purpose is one line in
  `SealPurpose` (keep it sorted).
- `apps/panel/src/settings.ts`: never edited to add a setting; augment
  `SettingValues` from your module folder.
- Dependencies: `bun add --exact` in the workspace that needs it
  (TypeScript) or `go get` in `go/` (Go). `bun.lock`, `go.mod` and `go.sum`
  are never merged by hand: on a conflict run `bun install` or
  `go mod tidy` and commit the result.
- Brand (`brand/brand.json`, `tools/brandgen`): every name, path and URL of
  the product comes from there. Change a value, run `make gen`, and keep
  the site's brand file in step (`scripts/dev/check-site-brand.sh`).

## Before you commit

Run, from the repository root:

```sh
make gen && make check-gen   # generated code is current
make lint                    # buf, gofmt, vet, staticcheck, Biome, tsc
make test                    # Go with -race, bun test everywhere, installer
make build                   # bin/seylo, apps/web/dist, apps/panel/dist
```

All four must pass.
