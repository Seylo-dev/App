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
packages/zip/             streaming zip writer (store, deflate, data descriptors, zip64) and a strict zip reader that runs in browsers (@seylo/zip/write, @seylo/zip/read)
installer/                install.sh.tmpl + generated brand.env and install.sh (scripts/render-installer.sh)
openapi.json              generated from the op registry (scripts/gen-openapi.ts)
service-export.schema.json  JSON Schema of the service export file format, generated with openapi.json
biome.json                TypeScript/CSS formatting and lint rules
scripts/                  codegen helpers and the generated-code check
deploy/panel.Dockerfile   panel image: Bun runtime + the built panel and web app (`make panel-image`)
.goreleaser.yaml          release build (signs nothing, runs no npm: it packages `make build-ts`'s apps/*/dist); scripts/release-manifest.sh writes the update manifest and scripts/release-sign.sh signs it and checksums.txt
test/e2e-colima/          three-VM end-to-end harness and checklist (`make e2e`, results in RESULTS.md)
test/playwright/          browser tests (`test/playwright/run.sh`)
.github/workflows/ci.yml  CI on GitHub's runners: check-gen, lint, test, build (publishes nothing)
.github/workflows/security.yml  govulncheck, osv-scanner (triaged ignores in osv-scanner.toml) and zizmor on push, pull request and weekly
.github/workflows/release.yml   tag releases: Build and test (read-only token, the only job that runs npm), Draft release (unsigned, from that build), Sign (the only job with the release key, environment `release`), Publish, then Start the install smoke test (actions: write and contents: read, runs gh only); scripts/check-release-workflow.ts keeps npm out of jobs with a write token or a secret
.github/workflows/install-smoke.yml  installs a published release with its install.sh on GitHub's amd64 and arm64 runners and runs test/install-smoke/smoke.sh (read-only token, no secret)
test/install-smoke/       smoke.sh: owner, API key, a whoami service, its IP:port answers
.gitleaks.toml            secret scan config: gitleaks' default rules plus the known fake test secrets
templates/                one-click template catalog (meta.yaml + index.ts per app, logo.* where one exists; README.md has the format, NOTICE the logos' source)
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
| `nodecheck` | Node "Health check" (formerly Doctor): `Check`, `Run`, `Default(Env)` with 20 checks (kernel, OS, memory, disk, inodes, service folder modes, Docker (since 0.2.1 it also warns below Docker 28 while the panel container publishes on loopback only: route_localnet), cgroups, Docker live-restore, Docker buildx on nodes that build (`agent.BuildsOn`: config.yml `can_build` or, since 0.2.1, the panel's `max_parallel_builds` above 0; builds have no fallback without it; a build fails with what to install; run with the builds' DOCKER_CONFIG like NodeFacts.buildx, so a plugin only in ~/.docker/cli-plugins fails), ports 80/443 (free, our Traefik, or the Wings fork's proxy container from Wings detection), proxy, route files, DNS, Container DNS (`docker.dns`, since 0.2.12, see "Container DNS check"), firewall, clock, panel, Wings, the panel's files), read-only Docker socket client; `seylo health`, `seylo troubleshoot` and the agent all pass Wings detection | Built (also run against the real test VM) |
| `cli` | Cobra command tree: node (`agent --join`, `join`, since 0.2.12 `set-panel`, `status`, `health`, `troubleshoot`, `panel start|status|logs|setup-link|rotate-key`, and since 0.2.1 `panel ip-access on` and `panel tailscale status|off|on`), laptop (`login`, `logout`, `deploy`, `logs <svc>`, `env`, `tunnel`), hidden `panel bootstrap`, `install-units`, `update-guard`. Builds for linux, darwin and windows (amd64/arm64, `cmd/seylo` `TestCrossBuild`): node commands are `//go:build !windows` (Windows gets stubs, so no agent package is compiled there) and answer "runs on a Linux server" off Linux | Built |
| `agent` | Daemon composition root: `Run` (config.yml, agent key, join/resume, reconnect with backoff and jitter, moves to the panel's new address (`move.go`), heartbeat, outbox drain, machine facts, DISK_LOW alerts (`disk_alert.go`), local API), `Join`, `Wire`, `Deps`, `Components`, `Facts`, one `wire_<area>.go` per area | Built |
| `localapi` | Agent unix-socket API (HTTP, 0600): `Serve`/`Handler`/`Backend` in the agent, `Client` for the node CLI | Built; panel start/logs answer NOT_IMPLEMENTED until `Deps.PanelControl` is set |
| `panelapi` | Laptop CLI client for the panel op API (hand-written over the contracts, not generated), saved logins in `~/.config/seylo/config.json`, `SEYLO_PANEL_URL` + `SEYLO_TOKEN` for CI | Built (tested against a fake panel) |
| `troubleshoot` | Redacted Markdown report + upload to `<site>/l`; exact secret values from the persisted desired state (`crash.SecretValues`) are stripped before the shape-based pass, and an upload prints which sections it contains | Built (uploads verified against the site API) |
| `state` | `FileDesiredStore`, `DesiredSync` (revision rules, save then publish), `MemoryStore` (actual state, epoch/seq; in memory by design), bounded `FileOutbox`, `Reporter`, `DesiredFeed`, `WriteFileAtomic` | Built |
| `reconcile` | Converge to desired state, health-gated deploys, rollback, adoption by labels, `Resolve`, `SetSleeping`, moving running containers to another project's network without a restart (`reattach.go`) | Built (`Runtime`; the project move verified in the VM, `TestITMoveProjectReattach`, `TestITMoveProjectInterruptedLeavesTheOldNetwork`) |
| `crash` | Crash policy and reports | Built (`Streaks`, `Redact`) |
| `health` | Service health probes | Built (`Probes`, `Watch`) |
| `volumes` | Volume export/import (.tar.gz through `os.Root`) for moving services and for the data of service export files (`ImportOptions`: at most `MaxBytes` file bytes and `MaxEntries` headers, the stream's `SHA256`, free space for `MaxBytes` plus `FreeFloor`; a failed import with limits leaves the volume empty; `Export` counts the entries it wrote); extracted modes (`ArchiveMode`, imports and backup restores) keep the permission bits, sticky, and setgid on folders, and drop setuid and setgid on files like uploads; `WriteArchive` for any archive of a live volume (walks through `os.Root`, checks each opened file against its listing, so symlink swaps mid-walk never reach host files) | Built (`Transfer`, `WriteArchive`) |
| `proxy` | Traefik route files (`Build`, a route with `acme_hold` gets its HTTPS routers without the certificate resolver and no redirect, since 0.2.8; an ACME route with `acme_challenge_on_https` (the panel's domains whose DNS does not point straight at the node, the panel's own domain, every tool host) answers Let's Encrypt's HTTP-01 challenge on websecure too, `addAcmeChallenge` to `acme-http@internal`, and every route the origin path on websecure, since 0.2.12; `FileRouter`: atomic write, `Verify` probe through Traefik, `Status` from acme.json, Traefik's log (`CertFailures`, `WatchCertFailures`: CERTIFICATE_FAILED with the CA's reason) and DNS (a host whose every address is Cloudflare's, `proxy/cloudflare.go`, is never a DNS_MISMATCH: behind the proxy only the certificate tells, since 0.2.8), certificate issuer and expiry, `RetryCertificate` (renames one route's routers so Traefik runs ACME again, no restart), `Certificate`, `ProxyContainers`), the agent's own Traefik (`Traefik.Ensure`), the LB-only Traefik next to Wings (`LBOnly`, `FileConfig.LBDir`), `MobyDocker` for networking's Docker calls | Built (routing, middlewares, custom and ACME certificates and ACME failures via Pebble, a failed host fixed and retried to a certificate in both modes (`TestIntegrationACMERetry`), a held domain served over https, the challenge path over https kept for the app on a domain without `acme_challenge_on_https`, and the first certificate validated over a redirect to https behind a stand-in for Cloudflare with a redirect to https for every path and SSL/TLS Full in both modes (`TestIntegrationBehindCloudflareHTTPSRedirect`), switch under load, shared Wings Traefik plus the LB Traefik verified in the VM) |
| `edge` | Agent HTTP listener on the `seylo-edge` gateway: maintenance/status pages (served with `proxy.PageContentSecurityPolicy` and nosniff: no scripts or frames), tool sessions from panel-signed tickets (`Verifier`, `Tools`), cookie handoff, origin proofs for the panel's origin check of service domains (`origin.go`: `proxy.OriginPath`, signed with the node key, `OriginCapability`) | Built (Box ticket flow, tool host and handoff through Traefik verified in the VM; origin proofs unit tested, e2e check 29 written but not run yet) |
| `portgate` | Agent-owned IP:port TCP relays from the desired state (`SyncAll`, `ListenersFor`): allow lists, local expiry, redirect-then-close, TLS termination for exposed Mongo, Redis, Valkey, KeyDB, Dragonfly and ClickHouse's native port (`dbengine.TLSAtGate`, `Config.Certificate`, `OpenPort.tls`), a TLS check on exposed Postgres, MySQL and MariaDB (0.2.9, `Listener.RequireTLS`, `requiretls.go`: Postgres must open with an SSLRequest, a direct TLS ClientHello or a CancelRequest, a GSSENCRequest gets "N" from the gate and the next message must ask for TLS, and a database that answers the SSLRequest "N" gets no plain login either; MySQL and MariaDB: the server's greeting must offer TLS (CLIENT_SSL; read whole, up to 1 KiB) or the client gets an ERR 3159 "TLS is not on in this database yet" in its place (MariaDB 10.11 has no TLS), and the client's first packet must be a 4.1 SSLRequest, payload exactly 32 bytes with CLIENT_SSL, since a whole handshake response with the flag set goes in the clear and a server without TLS masks the flag off; anything else gets the protocol's error, a Postgres ErrorResponse FATAL 28000 "this port only accepts TLS connections: connect with sslmode=require" or a MySQL ERR 3159 HY000, and the connection closes; 10 s for Postgres' first bytes, 30 s for MySQL's greeting and answer, at most the 8 bytes (Postgres) or the greeting and 6 bytes (MySQL) checked are buffered and go on unchanged, and a refused startup message is read to its end, up to Postgres' 10000 bytes or 64 KiB, so the client reads the error before the close), per-listener and per-source connection caps, idle cut-off (15 min, databases 2 h), one shared `Resolve` per container port every 2 s. Through a deploy (since 0.2.1): a new connection waits for its service (`ConnectTimeout`, 5 s) instead of closing at the first miss (a failed lookup or a refusing address is tried again after a short pause; an address from an earlier lookup gets one second, then a fresh lookup), one connection giving up never fails the shared lookup for the rest, reconcile calls `Manager.Switched` when a deploy switches the route, switches back, removes the old generation and ends the rollout (it drops the service's lookups, failed ones too), and reconcile's `Resolve` keeps to the serving generation until the switch (`worker.rollSwitched`); a listener that gives up on connections warns once a minute | Built (relay to a container, allow list, redirect and expiry, redis-cli/valkey-cli `--tls`, mongosh `tls=true` and clickhouse-client `--secure` through the gate verified in the VM; psql `sslmode=require` and `prefer`, mysql `--ssl-mode=REQUIRED` and mariadb `--ssl` pass, `sslmode=disable`, `--ssl-mode=DISABLED`, `--skip-ssl` and `prefer` to a Postgres with TLS off get the gate's error, MariaDB 10.11 refuses `--ssl`, `--skip-ssl` and a plain response with CLIENT_SSL, and 120 refused MySQL logins in a row do not block the gate's address, verified in the VM: `TestIntegrationDatabaseTLSInProtocol`) |
| `build` | Railpack/Nixpacks/Dockerfile builds: git/upload/inline/image sources, capped buildx builders (one per project), FIFO queue (`max_parallel_builds`), detached jobs with replayable output, push to 127.0.0.1:5755, local image and cache retention. Every variable reaches Railpack and Dockerfile builds as a BuildKit secret (Dockerfile builds also get the non-secret ones as build args); Nixpacks builds see only non-secret variables (it bakes every variable into the image), the build log says so. The panel's `EnvVar.secret` is a real classification (`@seylo/env-analyzer` `isSecretEntry`: `# @public`/`# @secret` comment, name, value, references to secrets; `EnvGraph.isSecret`) | Built (Docker builds verified in the VM) |
| `registry` | 127.0.0.1:5755 relay over RegistryTunnel (`TCPRelay`), `Tunnel` handler (registry and service-port targets; a `RegistryTarget.scope` makes it an HTTP-aware gate: only the node's pull/push repositories, never DELETE of content, the catalog or foreign blob mounts), the registry container on the panel's node (`Server`, GC) | Built (push/pull through the relay, and scoped push/pull/refusals with the real Docker and registry, verified in the VM) |
| `compose` | `Parse` for ParseCompose: compose-go normalized project JSON + unsupported-feature warnings; never reads node files | Built |
| `logs` | Per-service log store on disk (text segments, size and age retention), capture from Docker across generations with a restart cursor, follow, search, build logs | Built (capture, follow and restarts verified in the VM) |
| `metrics` | Node usage from /proc, per-service Docker stats (memory = usage - inactive_file), the latest periodic sample for GetMetrics (no history on the node since 0.2.0-rc.2; the panel keeps the live window and rollups), live watch (`WatchOptions`: light node samples from /proc/stat, /proc/meminfo and /proc/net/dev with no Docker, `Host.SampleLight`; a lease that ends the watch by itself; the /sys device check per interface is remembered while the interface exists) | Built (verified in the VM; light watches and leases unit tested in a synctest bubble, not yet in the VM) |
| `console`, `shell` | Attach to the main process with history replay; PTY shells, database clients (via `dbtools`) and one-shot Exec through docker exec, with a marker-based process sweep; `ConsoleInfo` and the first `ShellResponse.info` carry user and working directory; `console/dockerapi` is the small Docker client the observe area shares (kept apart from `docker.Engine` on purpose, see Not built yet) | Built (verified in the VM) |
| `fs` | Volume file access through `os.Root` (no `..` or symlink escape), atomic uploads, tar.gz/zip archive and extract. No write, chmod or extract leaves setuid/setgid (FsChmod and FsWrite keep the permission and sticky bits only; replacing or appending to a setuid file drops the bits first). New files and folders take their folder's owner, except that a root-owned (or unreadable) folder gives them to nobody (65534:65534), so the file manager never makes a root-owned entry; a replaced file keeps its owner. `VolumeRoots.Open` never creates folders: the agent's resolver makes a missing volume folder with `datadir.MakeServiceVolume` (service folders 0700) | Built (escape fuzzing run as root in the VM) |
| `cron` | On-node scheduler (`Local`): ServiceSpec.cron_jobs and SERVICE_KIND_CRON in one-off containers (service image, env, volumes, project network), 5-field schedules in IANA time zones, timeout, forbid/allow/replace, `RunNow`, CronRun results with the last 100 lines (secrets redacted) through the outbox; a job whose schedule it cannot read is reported once as a failed CronRun (`unreadable-<hash>`) instead of being skipped silently | Built (runs, failure, timeout, skip verified in the VM) |
| `backup` | Volume .tar.gz archives and dumps (pg_dump/pg_dumpall, mysqldump/mariadb-dump, mongodump, redis-cli/valkey-cli/keydb-cli --rdb; Dragonfly `SAVE RDB <run>` and ClickHouse `BACKUP ... TO File()` into the data volume, read and deleted by a helper that mounts the volumes) in helpers from the database's own image, streamed multipart to S3/R2/MinIO: with URLs the panel presigns for the run when the destination comes without keys (`SignedStore`, `signing_id`; the panel makes the multipart create/complete/abort steps and retention), else with the keys through minio-go and `keep_last` retention (older panels), restores (staging folder swap, pg_restore/psql/mysql/mongorestore, the RDB swap of the Redis-like engines, ClickHouse: rename the databases the zip holds to `<name>__seylo_pre_restore_<time>`, `RESTORE`, then drop the renamed copies; a failed `RESTORE` drops what it created and renames them back, names passed as `Identifier` query parameters), `SleepSuspend` with crash-safe markers (a volume restore stops every service that mounts the folder, compose members included; a stop-service volume backup stops every writer), BackupProgress. RDB restores move every append-only file aside as `<name>.before-restore-<time>` (the copies of earlier restores are deleted once a restore is in place, so a volume keeps one undo) and also write the RDB as `appendonly.aof` (an RDB preamble, without the 40-byte diskless EOF marker `redis-cli --rdb -` leaves): with `--appendonly yes` the server would start empty otherwise | Built (every engine, Postgres 18, pgvector 15 to 18, Valkey 8.1, 9.0 and 9.1, ClickHouse 26.3 and 26.8, MongoDB 7.0, 8.0 and 9.0, Redis with append-only, and volumes round-tripped through MinIO in the VM; truncated and incomplete ClickHouse zips fail and leave the databases as they were) |
| `tunnel` | Cloudflare tunnels (`CloudflareDocker`): cloudflared on the project network, quick trycloudflare.com tunnels (URL from the log, kept current) or token tunnels, supervised; `Relay` interface for the Tunnel RPC | Built (quick tunnel served a page end to end from the VM) |
| `cleanup` | Prune managed resources only (`Local`, rules in `Plan`): stopped job/old-generation/orphan containers, images past the newest 3 per service, volumes and services/<id> data of removed services (never within 24 h of a volume import into the folder: `ImportVolume` keeps `services/<id>/.incoming`, a move or clone copies before the service is placed; the desired state is read again right before each folder or volume goes, and imports into a folder wait while it is removed), orphan project networks; dry run with sizes; build cache only through the builder's `CachePruner`. `LocalScheduler` runs `NodeSettings.cleanup` by itself: a cron expression in the node's time zone and a disk line fed by the disk checks, each run a durable `CleanupRun`; an expression it cannot read is one failed `CleanupRun` per changed schedule | Built (unlabeled look-alikes survive, verified in the VM; the disk trigger on a filled tmpfs in the VM) |
| `hostshell` | Root login shells on the node itself for HostShell: a PTY from /dev/ptmx (`golang.org/x/sys/unix`), the agent user's login shell from /etc/passwd in a new session with a clean environment, `Manager` with the `Allowed` gate, at most 2, 15 minutes idle, `CloseAll` when the setting turns off, hang-up of the process group on close; Linux only | Built (PTY, cap, idle and close-all verified as root in the VM) |
| `dbtools` | On-demand database web UIs (pgweb, phpMyAdmin, mongo-express, Redis Commander for every Redis-like engine, and ClickHouse's own Play page behind `nginx:1.30.6-alpine`, which sets the admin's Basic header on every request, replaces the Authorization and X-ClickHouse-* headers and refuses credential URL parameters (`user`, `password`, `quota_key`, or any percent-encoded parameter name) with 403) signed in from the spec, stopped when idle. The helpers run on the project's network next to its other containers, so none is open: each has a login of its own that only the edge holds and sets as Authorization on every request it proxies (`edge.AuthorizedTool`, replacing the browser's): pgweb `PGWEB_AUTH_USER`/`PASS`, mongo-express Basic auth, Redis Commander `HTTP_USER`/`HTTP_PASSWORD` with its token secret in `NODE_CONFIG` (the edge signs its HS256 session tokens), the ClickHouse proxy a Basic check before it adds the admin's, all random per agent run; phpMyAdmin runs with HTTP auth (`PMA_USER_CONFIG_BASE64`) and gets the admin's login from the edge. A container of the project that reaches a helper gets 401 (verified in the VM); `ClientCommand` for pre-logged-in shells (psql, mysql/mariadb, mongosh, redis-cli, valkey-cli, keydb-cli, clickhouse-client); `ExposedTLS` (0.2.9; it was `ExposedUsers`, which created a separate exposed user) turns TLS on inside exposed Postgres (certificate files + `ALTER SYSTEM` ssl, and the old `# seylo-exposed-begin` pg_hba block goes, then `pg_reload_conf`) and MySQL (`SET PERSIST` certificate + `ALTER INSTANCE RELOAD TLS`) with the edge's ACME certificate for `tls_hostname` or a kept self-signed one, and creates no user (the self-signed fallback, `<state>/db-tls/<id>.{crt,key}`, since 0.2.12: CA:FALSE with digitalSignature and keyCertSign, serverAuth, the TLS host name as DNS name, and critical name constraints that permit only that host name and its subdomains (only the reserved `invalid` without a host name, CN `database`) and exclude every IP address. keyCertSign is what makes BoringSSL (Bun) and OpenSSL 1.1 call it self-signed and LibreSSL accept it as its own trust anchor; CA:TRUE would be refused by rustls as the server's own certificate (CaUsedAsEndEntity) even when trusted; the name constraints keep a trusted copy from vouching for a certificate made with its key (readable inside the database container) for another name or an IP, which BoringSSL, LibreSSL and rustls would otherwise accept from a trust anchor (they do not look at its basic constraints). Checked by hand against Bun 1.4, Node 24, OpenSSL 3.6/4.1 (also `-x509_strict` and Python 3.15's strict default), LibreSSL, rustls 0.23 and Go; Bun in `TestFallbackWithBun` (skipped without bun). A kept one is made again once when it is stale (`staleFallback`): from before 0.2.12 (a leaf with digitalSignature only, which Bun and OpenSSL 1.1 refused as "unable to verify the first certificate" and LibreSSL did not trust by its file either), not of the current kind, unparsable, or not naming the TLS host name it is now asked for (made before the host name was set); without a host name any current one stays. The new fingerprint makes `ExposedTLS` install it on the next pass and the portgate serve it on the next handshake; `fallbackMu` keeps one writer, key then certificate, each in one rename): the exposed port is the database's own login (MariaDB keeps its own certificate from 11.4; 10.11 has none and the panel never exposes it; Mongo, ClickHouse and the Redis-like engines need nothing here). It also retires `DatabaseSpec.retired_exposed_user` once per node (the panel sends it once no running service has that user's URL) (marker `<state>/db-retired/<service id>.<user>`): Postgres `ALTER ROLE ... NOLOGIN` and its sessions ended (never DROP ROLE, which needs DROP OWNED), MySQL/MariaDB `ALTER USER IF EXISTS ...@'%' ACCOUNT LOCK` and its sessions killed, Mongo `dropUser`, ClickHouse `DROP USER IF EXISTS`; never the admin user, values through env only | Built (all UIs, Postgres 18 included; TLS without a user and the retirement of an old exposed user that owns a table in Postgres/MySQL/MariaDB/Mongo/ClickHouse verified in the VM: `TestExposedTLSAndRetiredUsers`; an older agent's fallback made again and served by Postgres 17 and MySQL 8.4, `openssl s_client -starttls -verify_return_error` saying "self-signed certificate" and verifying with the kept file as the CA, then made again for a new TLS host name and verifying with `-verify_hostname`: `TestExposedTLSFallbackIsSelfSignedForOpenSSL`) |
| `box` | Box idle sleep and wake through reconcile `SetSleeping`/`Resolve`, activity from edge requests and code-server's heartbeat file | Built (unit tested; not run against a real reconcile yet) |
| `dbengine` | Per-engine facts backup, dbtools and portgate share: `Port` (ClickHouse: native 9000), `HTTPPort`, `RedisLike`, `RedisCLI`, `TLSAtGate`, `AgentCertificate` (0.2.12: the engines whose exposed port serves the agent's certificate, the `TLSAtGate` ones plus Postgres and MySQL; not MariaDB), `Capability` (`database.engines.v2`) and `ExposureCapability` (`database.exposure.v2`, 0.2.9; `SeparateExposedUser` is gone with the separate user) | Built |
| `jobrun` | Docker access of the jobs packages (moby client): one-off runs with streamed stdin/stdout/stderr, helpers by spec hash, on-demand helpers with idle reaping, Exec, cleanup inventory that re-checks `seylo.managed` before every removal; every container removal takes the container's anonymous volumes with it (images with a VOLUME line, such as database images, would leave one per backup, restore or cron run that nothing else removes); `jobrun/itest` is the VM test setup | Built (verified in the VM) |
| `wings` | Pelican Wings detection (`FileDetector`), re-attaching our networks to the fork's Traefik (`Attacher`), games-first CPU weight (`SliceCPU`) | Built (attach after recreate and cgroupfs weight verified in the VM; no real Wings yet) |
| `tailnet` | The panel on the owner's tailnet (since 0.2.1), standard library only: `Client` over tailscaled's LocalAPI socket (`/var/run/tailscale/tailscaled.sock`, config.yml `tailscale_socket`; status, prefs, an EditPrefs mask of WantRunning and CorpDNS only, login-interactive, Serve config with ETag/If-Match), `Ensure`/`Remove`/`Find` (pure edits of the Serve config JSON: one handler whose Proxy is exactly our unix target, every other field kept byte for byte, never AllowFunnel), `Manager` (the agent's `tailnet` component, see "Panel access and the tailnet"), `MinVersion` 1.104.4 | Built (unit tests against an httptest LocalAPI with recorded 1.104.x answers; not yet against a real tailnet) |
| `update` | Signed agent self-update with a systemd rollback guard, panel swap (snapshot, health check, restore), Docker update and the daily Docker version check (`DockerUpdater.Check`, `RunChecks`, since 0.2.5), reboot, release manifest builder (`releasetool`) | Built; see "Releases and updates" (the version check is unit tested with scripted apt/dnf answers; no real apt run yet) |

Naming note: the node health check package is `nodecheck` (not `doctor`)
because `health` is the per-service probe package.

Container DNS check (`docker.dns`, since 0.2.12;
`go/internal/nodecheck/dockerdns.go`): Docker gives containers DNS
servers they can use. A "dns" setting (daemon.json or `dockerd --dns`)
replaces the host's servers for every container. Two things give
containers `nameserver invalid IP` lines with `# Overrides: [nameservers]`:

- a reload on Docker 29.0 to 29.2 (`systemctl reload docker`, or a
  SIGHUP) with a setting that is fine: since 29.0 (moby#50600) its entries
  are `netip.Addr` values, the reload deep-copies the daemon's config with
  copystructure, which zeroes them, and a zero `netip.Addr` prints
  `invalid IP` (moby#52060, fixed in Docker 29.3.0; 28 and 29.3+ are not
  affected). Every container created after the reload gets one `invalid
  IP` per entry until `systemctl restart docker` reads the setting again,
  and keeps it until it is restarted itself. A node's builds all failed
  this way: `"dns": ["8.8.8.8", "1.1.1.1"]` and `"live-restore": true` in
  daemon.json, then a reload to turn live-restore on, two `invalid IP`
  lines in every new container, and a restart fixed it;
- entries that are not addresses: Docker 29 starts with an empty `""`
  entry in daemon.json (`dockerd --validate` accepts it too) and writes
  `nameserver invalid IP` for it (reproduced on Docker 29.5 in the test
  VM); Docker 28 refuses to start the container.

The build worker then has no server and BuildKit falls back to
`[::1]:53`, and apps' outside lookups through Docker's embedded DNS fail
the same way. Reads, most reliable first:

- a test container on the default bridge, `docker run --rm --name
  seylo-dnscheck-<8 hex> --pull never --network bridge --label
  seylo.dnscheck=true --label traefik.enable=false --entrypoint cat
  <image> /etc/resolv.conf`, from an image already on the node (the first
  of `moby/buildkit`, `traefik`, `alpine`, `busybox`; none is ever pulled),
  run with the builds' DOCKER_CONFIG like the buildx check, with every
  health check (hourly and on "Run checks now"), within 30 seconds.
  `--rm` removes a container only after it ran, so a run that fails
  removes its own with `docker rm -f` (a context of its own, the run's may
  have expired), and every run first removes `seylo.dnscheck` containers
  older than two minutes (any state: one cut off between create and
  start), never a younger one that may be another run's;
- our running containers' resolv.conf, read from
  `<DockerRootDir>/containers/<id>/resolv.conf` (nothing runs in them):
  the build workers and every `seylo.managed=true` container (apps,
  Traefik, the panel) except those on host, none or another container's
  network. A container keeps the servers it started with, also after a fix
  and through a Docker restart with live-restore on (Docker restores its
  resolv.conf and the embedded DNS's list as they were). One on a project
  network has `nameserver 127.0.0.11` and Docker's `# ExtServers: [...]`
  note (Docker 25 and later; checked in the VM) naming where the embedded
  DNS forwards: `host(<ip>)` entries are asked from the host and always
  count, the others count like nameserver lines, and without the note the
  container is not judged;
- for the cause: the host dockerd's command line for `--dns` and
  `--config-file`, from the pid in `/var/run/docker.pid`, else
  `systemctl show --property=MainPID docker.service`, else a `dockerd` in
  `/proc` that is in this process's PID and user namespaces (a dind
  container's or another user's rootless dockerd is skipped; one known to
  share both comes first, then the lowest pid), else `systemctl show
  --property=ExecStart docker.service`; and that daemon.json (default
  `/etc/docker/daemon.json`) for `"dns"` and `"ipv6"`. `GET /info` has no
  DNS field; its `ServerVersion` says whether the reload bug applies.

An entry counts when it is an IP address that is neither loopback nor
unspecified (no ports, no host names, no `""`). Fail: no usable server (the
real node's file, no nameserver line, loopback only, Docker refusing the
container, or the setting alone when no test container could run), or a
running container of ours without one (a build worker, or an app, Traefik
or the panel). Warn: usable servers next to unusable ones, only IPv6
servers while the bridge has no IPv6, a setting changed since Docker
started that breaks it at the next restart, a daemon.json that does not
parse, or nothing readable at all. The fail detail names the entries and
where they are and says builds cannot pull images and apps cannot look up
outside names; the hint says to put IP addresses in the file (`"dns":
["1.1.1.1", "8.8.4.4"]`) or remove the key (or fix the `--dns` flags with
`systemctl edit docker`), check it with `dockerd --validate --config-file
<file>` (or, when the setting read now is fine, that it already gives
those servers), restart Docker with `systemctl restart docker`, what that
restart stops (from Docker's live-restore: everything, Wings' game servers
included when Wings is detected, unless live-restore is turned on first
with a reload), that a container which keeps running through the restart
keeps its old servers until it is restarted itself (an app with Restart on
its page in the panel, a Wings game server from Wings' panel), and which
build workers to `docker restart` (keeps the cache) or
`DOCKER_CONFIG=<datadir>/builds/docker docker buildx rm`. For our
containers that kept the old servers it names them: build workers as
above, apps with the panel's Restart (in place, no deploy), others with
`docker restart`. The check never changes daemon.json or restarts Docker.

The reload case: on Docker 29.0 to 29.2, when the test container's
servers come from the setting and are all `invalid IP`, and the setting
read now has as many entries, all usable addresses, the detail says the
test container gets them although the file (or the `--dns` flags) gives
those servers, because that Docker loses its "dns" setting when it is
reloaded (moby#52060, fixed in 29.3.0). The hint says to restart Docker,
not reload it (`systemctl restart docker` reads the setting again), what
the restart stops, our containers created since that kept `invalid IP`
and how to restart them, and that Docker 29.3.0 or later makes reloads
safe; never to put IP addresses in the file. When only a container of
ours shows it (the test container is fine again), the detail adds where
`invalid IP` comes from and the hint, after the containers' restarts, says
Docker holds the setting again and needs no restart now, and to restart
Docker instead of reloading it from then on. When the counts
differ the detail does not say the setting is "as it was when Docker
started" but "as Docker holds it now" with the reload note; when only
some entries are `invalid IP` no reload explains it and the text stays.
Every hint that suggests `systemctl reload docker` to turn live-restore
on (this check's, the Docker live-restore check's, the Docker update's
warning and the installer's, which also runs that restart itself, see
"Docker preflight") adds, on Docker 29.0 to 29.2 with a "dns" setting in
daemon.json or on dockerd's command line, `systemctl restart docker`
right after it, since containers created between the two get `invalid
IP`; with live-restore on by then the restart keeps containers running.
Docker 28, 29.3 and later, and nodes without a "dns" setting keep the
plain reload advice.
The panel and the web app show its title, detail and hint like every other
check's. VM tests: `TestRealContainerDNS` (the test container on the VM's
Docker, dockerd found through its pid file, no `seylo.dnscheck` container
left; a build worker with the real node's resolv.conf, and a
`seylo.managed` container on its own network whose ExtServers note says
`[invalid IP invalid IP]`, each failing by name until `docker restart`
gives it fresh servers) and build's `TestFailedLookupPointsAtContainerDNS`
(real BuildKit lookup output gets the log line); a broken "dns" on the
VM's own Docker and a live-restore restart are not tested there, since
both need a Docker restart, nor the reload case (it needs Docker 29.0 to
29.2 and a reload of the VM's Docker).

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
| `make check-gen` | Fails if committed generated code is stale, the Drizzle schema changed without a migration, or SECURITY.md or README.md no longer show brand.json's `minisignPublicKey` (CI) |
| `make build` | Static `bin/seylo` (`CGO_ENABLED=0`), then `bun run build` (web, then panel) |
| `make test` | `go test -race` for `go/` and `tools/brandgen`, `bun test` in every workspace, `make test-installer`, `make test-release` |
| `make test-installer` | `installer/test/run.sh`: install.sh in `--root` mode against a fake signed release (curl, docker, systemctl shims; minisign and OpenSSL 3 verifiers, dash), plus `scripts/release-preflight.sh`; skips without minisign |
| `make test-release` | `installer/test/release-sign.sh` and `installer/test/release-publish.sh`: `scripts/release-sign.sh` and `scripts/release-publish.sh` against fake draft releases (gh shim) and a fake ghcr.io; skip without minisign or jq |
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
| `openapi.json`, `service-export.schema.json` | the op contracts, the export format (`ops/serviceTransfer.ts`) |

Migrations: `apps/panel/drizzle/panel` starts with `0000_init.sql`, frozen
since the first release (0.1.0): installs out there have it applied, so it
never changes again. Every schema change after it is a new, add-only
migration (`0001_features` for 0.2, shipped in 0.2.0-rc.1, so frozen too;
`0002_updates` for rc.2: update runs keep their manifest, update steps
their reconnect retry; `0003_perf_indexes` for 0.2.0; `0004_join_token_can_build`
for 0.2.1: `join_tokens.can_build`, default false, so tokens made before
the update and the direct-insert test helpers keep making nodes that do
not build; for 0.2.5 `0007_domain_origin`, `0008_user_avatars`
(`users.avatar` and `user_avatars`), `0009_node_location`
(`nodes.location_source` and `nodes.location_looked_up_at`, both null on
existing rows), `0010_docker_update` (`nodes.docker_update`, the newest
Docker version check) and `0011_assistant_chat` (`users.ai_auto_mode`,
default false, and `approvals.source_label`, default ''); for 0.2.6
`0012_service_order` (`project_prefs.service_order`, a person's order of a
project's services, services.reorder) and `0013_project_images`
(`project_images`, projects.setImage); for 0.2.7 `0014_push_devices`
(`push_devices`, a person's browser push subscriptions, sealed, removed
with their session, and `push_prefs`, the alert events each person
pushes); for 0.2.8 `0015_domain_acme_hold` (`domains.acme_released_at`,
set on existing domains whose DNS was not missing or pointing elsewhere,
so the update holds back none of their certificates); for 0.2.10
`0016_service_transfers` (`service_exports` and `service_imports`,
service export and import) and `0017_transfer_volumes`
(`service_exports.volumes`, `node_id` without a foreign key, `stop_service`
and `source_stopped`, so a download that stopped its service starts it
again after a panel restart)), which the panel applies at start, also
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
  round-robined across streams. When Bun drops a frame because the agent
  socket buffers past its backpressure limit (16 MiB; `send` returns 0),
  the panel's `FrameWriter` stops writing and the session closes the
  connection with 1011 ("the agent stopped reading"): calls in flight fail
  as offline and the agent reconnects and resyncs, instead of CALLs,
  WINDOWs, CLOSEs or RESULTs vanishing on an open socket.
- Every RPC has a `capability` option; call a method only when the peer
  advertised its capability.
- Durable reports (crashes, final deploy/build results, cron runs, backups,
  alerts) go through the agent's on-disk outbox and `PanelService.Report*`,
  deduped by outbox id. Progress, state deltas and metrics are best-effort
  EVENT frames. The panel stores only the durable kinds (deployProgress,
  buildProgress, cronRun, backupResult, nodeAlert, updateResult, cleanupRun; others get
  INVALID_ARGUMENT), at most 1 MiB per report, about 10 per second per node
  (RESOURCE_EXHAUSTED past a burst of 600). Before anything stores or fans
  out a report its fields are capped (`agent-hub/report-budget.ts`): strings
  4096 chars, lists 200 entries of 2000 chars (`lastLines` keeps the
  newest), unknown fields dropped; crash lines 100 x 2000 chars, container
  ids 128 chars. `agent_reports` stores a smaller copy (strings 1024 chars,
  lists 20 entries), since nothing reads it back. Each node has daily
  report budgets in three lanes, counted from what panel.db already holds
  after a restart: crash reports, alerts, deploy and build results and
  every other durable event (75,000 rows, 32 MiB stored); cron results
  (75,000 rows, 32 MiB); backup, cleanup and update results (10,000 rows,
  8 MiB). Past a lane's budget a report of that lane is acked (the agent
  drops it) but neither stored nor fanned out, and one
  `node_health_check_failed` alert per node, lane and day says so; crash
  loops and alert floods never drop cron or backup results. A node may report only on services it runs (a placement, or a
  deployment in flight to or away from it; `agent-hub/service-scope.ts`):
  crash reports, durable events, deploy/health/cron events, state deltas,
  snapshots and metrics about other services are dropped, and an update
  result finishes only a step of that node. Best-effort events reuse the
  node's scope for a second (a service missing from it is looked up again
  after 100 ms); durable reports and snapshots use a fresh one. The scope
  and the registry tunnel's (`registryScope`) read deployments and builds
  in flight through partial indexes (`deployments_in_flight_idx`,
  `builds_in_flight_idx`, migration 0003), since deployments are never
  deleted; their conditions are the literal `deploymentInFlight` /
  `buildInFlight` (a bound `inArray` list never matches a partial index). A metrics
  event keeps one entry per service, and a live series at most 600 points.
  Every string of the ClientHello, its NodeFacts included, and
  `nodeFacts` events are capped (strings 256 chars, 256 capabilities of
  128; `agent_version` 64 chars, since it is stored in
  `nodes.agent_version` and shown) and `nodes.facts` is written, and the node
  published, at most every 2 s per node and only when they changed. The
  ServiceStatus of every snapshot entry and `serviceUpdated` delta is
  capped before the state store keeps it (`capServiceStatus` in
  `agent-hub/field-caps.ts`: strings 2048 chars, lists 128 entries;
  instance, port and route ids, names, digests and issuers 256 chars; an
  open port's `certificatePem` 4096 and `certificateError` 2048), and
  `healthChanged` like a durable report, so a node pins a few hundred KiB
  per placed service at most. Limits per connection
  (`agentLimits` in `agent-hub/session.ts`): ClientHello within 10 s,
  agent-opened stream windows clamped to 1 MiB, WINDOW grants past
  2^31-1 are a protocol error, 64 agent-opened streams and 256 calls in
  flight (RESOURCE_EXHAUSTED beyond), stream-0 EVENT frames through a
  token bucket (burst 2000, 200 per second; past it frames are dropped
  before they are decoded, and a dropped state delta makes the panel fetch
  a snapshot), GetDesiredState 10 per node then one per 10 s
  (RESOURCE_EXHAUSTED; the agent only asks after a fresh start, and the
  compiled state is reused for the same revision for 5 s), 32 MiB unread on agent streams (a running count). The
  sender's DATA frame sizes change neither the panel's work nor its memory:
  a stream keeps unread bytes in one doubling buffer, not one object per
  frame, and `DelimitedDecoder` collects a split message in one buffer
  that doubles up to the announced length (16 MiB at most), so a pending
  message costs about twice what arrived of it at most. One
  GetStateSnapshot per node at a time. panel.db retention (hourly,
  `modules/nodes/retention.ts`): agent reports and crash reports 30 days
  (newest 200 crashes per service always kept), and per node at most the
  newest agent reports of each report lane up to its budget (75,000 and
  32 MiB; 10,000 and 8 MiB for backup, cleanup and update results) and
  32 MiB of crash reports (`report_totals`, rows and bytes per node and
  kind kept by triggers since migration 0003, says which node is over a
  cap; only those nodes' rows are read), webhook deliveries 30 days
  (rejected ones 1 day), notification deliveries 30 days, alerts 180 days
  after they were resolved, or after they were raised when nothing resolved
  them (deploy, build, backup, cleanup and update results are events, not
  incidents), deploy log lines of failed/cancelled/superseded deployments
  after 30 days (newest 20 per service and the live one keep theirs); a
  service keeps its two newest source uploads.
- Proto changes are add-only within v1 (`proto/README.md`).
- `GitSource.username` (added in 0.2): the HTTPS user name the agent's
  credential helper answers with the token (validated: no spaces or line
  breaks). Empty means `x-access-token`. The panel sends the git
  provider's (`oauth2` for GitLab, the token's owner for Gitea,
  `x-token-auth` or the account for Bitbucket) and a git credential's
  user name. Older agents ignore it, so Bitbucket clones need a 0.2 agent.
- `GitSource.allow_plain_http` (added in 0.2): agents clone and fetch
  git sources with `protocol.http.allow=never` (so an https:// server
  cannot redirect the clone to http:// either) and refuse http://
  addresses with INVALID_ARGUMENT, unless the panel sets this field. The
  panel sets it only for a source an owner or admin (`git.manage`)
  explicitly allowed to use plain HTTP (an internal git server without
  TLS), never with a token or SSH key (those still need https:// or
  ssh://). Not built in the panel yet: until it is, http:// git sources
  fail on 0.2 agents (older agents still clone them without credentials).
- `GitSource.allow_internal_host` (added in 0.2): every connection a 0.2
  agent makes for a git source (build clones, submodules, partial-clone
  fetches of FetchGitFile, redirects) goes through a proxy the agent runs
  on 127.0.0.1 for that one fetch: https through git's `http.proxy` (the
  agent clears the `*_PROXY` variables for git), ssh through a
  `ProxyCommand` that runs the agent binary as the hidden `git-dial`
  command with the source's own host:port spelled out (never ssh's `%h`).
  The proxy dials with `go/internal/netguard`, which checks the address
  the socket actually connects to (after DNS) and refuses loopback,
  private, link-local, CGNAT, unique-local, multicast, unspecified and
  reserved addresses, also as IPv4-mapped, IPv4-compatible, NAT64 or 6to4
  forms (`netguard` rules; `go/internal/netguard/testdata/addresses.json` is
  the table the panel's classifier is tested against too), and the node's
  own interface addresses, public ones included (`net.InterfaceAddrs`,
  cached 5 s; public addresses are refused when they cannot be read): a
  connection to them stays on the node, past a firewall that hides a
  service from the internet. A git server on the node, reached by its
  public name, therefore needs this field like one on a private address;
  the panel counts the nodes' addresses as internal, so an admin's save of
  such a source sets it (Git addresses below). Agents report those
  addresses as `NodeFacts.interface_addresses` (added in 0.2: the public
  addresses on the node's interfaces, sorted, at most 64 of each family;
  empty from older agents). With this field set, internal addresses are allowed for the
  source's own host and port only (not for a redirect or submodule to
  another host); cloud metadata addresses never. The panel sets it for a
  generic git source exactly when its host is in `git_internal_hosts` for
  the project; for a git provider connection when the panel sees its host
  as internal or cannot resolve it (the address is set by
  `gitProviders.manage`), or when the host is in `git_internal_hosts` for
  the project; for a GitHub App source only when `github.com` is in
  `git_internal_hosts` for the project. A refused connection fails the fetch with
  "the node refused to connect to <host:port>: ..."; for the source's own
  host the message names how an admin allows it (the project's Settings >
  Internal git hosts, or `git.allowInternalHost`). ssh is used only with
  the source's SSH key (`protocol.ssh.allow=never` otherwise), and ssh://
  hosts must be plain names or IP addresses. Since the ssh tunnel always
  goes to the source's host, an ssh submodule on another host fails its
  host key check. The agent's own `HTTPS_PROXY`, `HTTP_PROXY` and
  `NO_PROXY` (what git used before) still apply: the fetch's proxy sends
  https tunnels (CONNECT host:port, by name, with the proxy URL's user and
  password) and plain http requests on to that proxy, unless `NO_PROXY`
  or a loopback target says otherwise; ssh connects directly, as before.
  Only `http://` and `https://` proxies (no port: 1080 and 443, like
  curl); the proxy itself may be on an internal address (the node's
  operator set it), never a metadata one. The node cannot see where the
  proxy connects, so then the address check is on the target before the
  request goes out: an IP address exactly, a name by what it resolves to
  on the node (all its addresses). A name the node cannot resolve (not
  found, a failing server, or no answer in 10 s) is refused before it goes
  to the proxy, unless this field covers that host and port, or the node's
  root set `git_proxy_resolves: true` in its config.yml (nodes whose DNS
  knows no outside names and rely on the proxy to resolve; read at agent
  start, the panel cannot set it): then it goes on to the proxy unchecked,
  for any host (a redirect or submodule too), and the proxy's own rules
  decide, as they do for rebinding between the node's lookup and the
  proxy's. The refusal ("the node cannot resolve <name>, so it cannot check
  where the agent's HTTP proxy would connect") names the key with the
  node's config.yml path, and for the source's own host the admin's
  allowance too. A 0.2 agent behind a panel that never sends the field
  clones from public addresses only.
- `WatchMetricsRequest.light` and `lease` (added after 0.2.4, no new
  capability: WatchMetrics is `metrics.read.v1`): `light` asks for node
  samples with only CPU, memory and the network counters (no disks, load
  or services; `service_ids` is ignored), `lease` ends the watch by itself
  with OK that long after it started (at least 10 s; 0 = until
  cancelled). The panel sends both for the dashboard's Live graphs
  (`modules/metrics/node-live.ts`, below). Older agents ignore them and
  send full node samples (the same fields) until the panel cancels, which
  every renewal does, so they keep working.
- `go/internal/conn/testdata/frames.json` is the Go <-> TypeScript golden
  fixture for the frame codec; both test suites read it.
  `go/internal/rpc/testdata/envelopes.json` does the same for the hello
  signature bytes, Call/Result/Open/Close and size-delimited stream
  messages (`TestGoldenEnvelopes`, `packages/proto/src/envelope.test.ts`).
- Panel pin: `sha256:<64 hex>` of the panel certificate's SPKI
  (`conn.FormatPin`; `ParsePin` also takes `sha256/<base64>`). The join
  command passes it as `--pin`; config.yml stores it as `panel_pin`.
  `--trust-on-first-use` records the first certificate's pin instead.
- `seylo join` (`agent.Join`) on a node that has a config.yml (`--force`
  once it joined) keeps every key it does not set: `no_host_shell`,
  `no_tailnet`, `tailscale_socket`, `git_proxy_resolves`, `node_name`,
  `can_build`, the `acme_ca*` keys and
  keys this agent does not know, with their comments. It replaces only the connection
  (`panel_url`, `panel_pin`, `trust_on_first_use`, `insecure_transport`,
  `fallback`, since 0.2.8 `staged` and `staged_move`), the identity the token gives (`node_id` cleared,
  `join_token`) and the old panel's identity (`panel_id`, `panel_key`,
  `panel_proves` cleared); `node_name` changes with `--name`, `can_build`
  with `--can-build` / `--can-build=false` (the installer's `--can-build`
  / `--no-can-build`). Since 0.2.1 `can_build` decides nothing on the
  panel (NodeFacts only reports it): the join token does. Its `canBuild`
  (`nodes.createJoinToken`, default true, written into the audit row even
  when the caller leaves it out; true on the installer's panel-node token)
  is copied to the new node's row, a re-join of a known node keeps the
  row's value (master key rotation re-joins included), and an owner or
  admin changes it with `nodes.setCanBuild` (`nodes.manage`). Tokens made
  before migration 0004 have `can_build` false. It is a
  choice, because a build node gets the source, git credentials and build
  env of whatever it builds, from any project (the service's own node
  first, else the least busy builder; automatic picks skip a node whose
  agent reports no docker buildx, `NodeFacts.buildx.installed` false;
  unset, from agents before 0.2.1, counts as installed), and pushes the
  images other nodes run; a deployment records it as `builtOn`. An
  explicit `buildNodeId` without buildx is refused by
  `builds.updateSettings` (BAD_REQUEST, field `buildNodeId`; the node the
  service already has is not checked again) and fails the deploy with
  CONFLICT "<node> has no docker buildx. Install docker-buildx-plugin on
  it."; `builds.settings` nodes carry `hasBuildx`, and `nodes` view's
  `canBuildWarning` puts "docker buildx is missing" first, shown whether
  Can build is on or off. The agent's buildx check and facts follow
  `agent.BuildsOn`: `can_build` in config.yml or
  `NodeSettings.max_parallel_builds` above 0 (which the panel sends only
  to a node with Can build on); `seylo health` reads the stored
  `state/desired.pb` for the same rule. `agent.SaveConfig` (the agent's own writes) keeps
  unknown keys and comments the same way. `TestJoinDecidesEveryConfigKey`
  makes every new FileConfig key pick a side.
- Agent connection policy: reconnect with exponential backoff 1 s to 60 s
  with jitter (half to full delay); 5 minutes after a rejection that needs
  a person (bad token, unknown node, bad signature, disabled, too old), a
  pin mismatch or another panel (see "Panel identity"); ALREADY_CONNECTED
  retries normally. AGENT_TOO_OLD also
  makes the agent install the latest signed release itself
  (`update.AgentUpdater.UpdateToLatest`: `<release base>/latest/download/
  manifest.json(.minisig)`, at least `min_agent_version`, at most once an
  hour per version, and a release the update guard rolled back waits as
  "Releases and updates" says), since the panel cannot send UpdateAgent
  to an agent it refuses. A WebSocket ping every
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
- Panel identity (`agent/panel_identity.go`): at its first accepted
  handshake (the join, or the first connect of an agent from before this)
  the agent records `panel_id` (ServerHello), `panel_key` (base64 of
  HelloAccepted.edge_ticket_public_key, the panel's Ed25519 identity key)
  and, when HelloAccepted carried a valid `panel_signature`,
  `panel_proves: true` in config.yml; `seylo join` clears the three. On every
  connect, at any address (moves and fallbacks included): a ServerHello
  naming another `panel_id` gets no ClientHello (nothing is signed for
  it); a HelloAccepted naming another identity key, or with a
  `panel_signature` that does not verify, or with none once
  `panel_proves` is set, closes the connection before any call is served
  or any `panel_url` is followed. Each counts as a failed connect to that
  address (5 minutes, the standing fallback still applies) and, during a
  move, a failed move with its PANEL_MOVE_FAILED alert. `panel_signature`
  is Ed25519 with the identity key over `<slug>-panel-accept-v1` 0x00
  panel_id 0x00 node_id 0x00 session_id 0x00 nonce 0x00 client signature
  0x00 panel_url 0x00 panel_pin (`rpc.PanelAcceptSignedBytes`, test vector
  in `go/internal/rpc/accept_test.go`, key from seed 0..31). The panel
  sends it on every HelloAccepted (`agent-hub/signature.ts` `signAccept`,
  the same vector in `apps/panel/test/fix-panel-accept-signature.test.ts`),
  signed with the edge ticket key. HelloRejected carries a
  `panel_signature` too, over `<slug>-panel-reject-v1` 0x00 panel_id 0x00
  nonce 0x00 client signature (empty without a ClientHello) 0x00 reason
  (decimal) 0x00 min_agent_version (`rpc.PanelRejectSignedBytes`,
  `signReject`, vectors in the same two tests; the message is not
  signed). A rejection arrives before the identity checks, so the agent
  takes it as the panel's answer (5 minutes, AGENT_TOO_OLD self-update)
  only over a pinned connection, when it verifies with the recorded key,
  or when there is nothing to check it against (no identity recorded yet;
  a panel that never signed, unless a standing fallback is there to try).
  Any other rejection (unsigned once `panel_proves` is set, or signed with
  another key) counts as a failed connect: normal backoff, the standing
  fallback, no self-update. It does not bind the TLS connection, so
  a relay of a whole session to the real panel is not detected; the pinned
  standing fallback is what keeps a node of a taken-over domain with its
  panel. The panel's identity never changes on an existing data dir:
  `ensurePanelId` and `ensureEdgeTicketKey` only create what is missing,
  and a sealed key the master key cannot open stops the panel instead of
  making a new one. Anything that drops `panelId` or `edgeTicketKey` from
  the settings (a new data dir, a restore of another panel's panel.db, a
  master key rotation that regenerates the edge ticket key, together with
  the agents' TLS key and so the pin) makes every node refuse the panel
  until it is joined again (`seylo join --force`).
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
- Pointing a joined node at another address by hand (`seylo set-panel
  <panel-url> [--pin sha256:<hex>] [--insecure]`, since 0.2.12,
  `agent/set_panel.go`, `cli/setpanel.go`): for a node that joined over
  the panel's domain and went offline when its network began decrypting
  HTTPS, without a join token (a `join --force` needs one and forgets the
  recorded panel identity). Root only (`run it as root`). It refuses a
  node without `node_id` (join again) and plain `http://` to another host
  without `--insecure` (join's rule; `--pin` needs `https://`); the same
  address and pin as `panel_url` changes nothing. Before writing anything it dials the address (the pin, else the
  system roots), resumes as the node with `agent.key` (a ClientHello
  without facts: the CLI has only their machine part, and the panel's
  `decideHello` leaves the stored facts and public addresses alone for a
  hello without them) and checks the
  recorded identity like every connect (`checkPanelID`,
  `verifyPanelIdentity`, and HelloAccepted.node_id); an accepted session is
  closed at once (the panel sees the node online for a moment). A
  HelloRejected counts only when it verifies with `panel_key` (or the node
  has nothing to check it against: no key, or a panel that never signed;
  `unsignedRejection`, the pin is no proof here since the owner typed it):
  ALREADY_CONNECTED (the agent is connected through the old address),
  AGENT_TOO_OLD and NODE_DISABLED still change the address, any other
  reason (UNKNOWN_NODE: removed) is refused with the panel's message.
  Another panel, a wrong pin (`ErrPinMismatch`) or no connection leaves
  config.yml as it was ("config.yml was not changed"). Then it copies
  config.yml to `config.yml.bak` (0600), writes it the way a move does
  (`movedConfig`: new `panel_url`/`panel_pin`, the old address as the
  fallback for one cycle, `insecure_transport` only for an `--insecure`
  plain URL, `trust_on_first_use` dropped; `node_id`, `panel_id`,
  `panel_key`, `panel_proves`, `staged` and every other key stay), restarts
  `seylo.service` and prints the restarted agent's `Panel:` line (and
  `Error:`) once it connected or was refused, or after 30 s, with how to
  go back. At a pinned IP the agent then tries the domain the panel names
  and keeps the pinned address when its certificate is refused
  (`untrustedMoveRetryAfter`, under `pinnedCommand`). Add node prints the
  command (`setPanelCommand`, under `pinnedCommand`), and the dial error
  for an untrusted issuer names it (`conn.certificateHint`).
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
  until the first join, `ConnInfo.NodeID` always has it), `Identity` (the
  agent's Ed25519 key the handshake signs with; the edge signs origin
  proofs with it; nil in tests that do not set it), `Desired`
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
  `seylo.managed=true`. The one exception is the Container DNS check's
  test container (`seylo-dnscheck-<hex>`, `seylo.dnscheck=true`, not
  managed): `docker run --rm` for under a second, and the check itself
  removes one a cut-off run left behind.
- Every container gets `traefik.enable=false` and `--cgroup-parent=seylo.slice`
  and Docker restart policy `no`.
- Names: containers `seylo-<service>-<generation>[-<replica>]`, networks
  `seylo-p-<project>` and `seylo-edge`, route files `seylo-<service>.yml`,
  service volumes `seylo-v-<owner service>-<volume>` (bind-backed by
  `<datadir>/services/<owner>/volumes/<volume>`). These are on-node
  contracts: changing one orphans existing resources.
- Service instances (reconcile's) carry `seylo.service` and no
  `seylo.role`, plus `seylo.spec-hash` (`reconcile.SpecHash`: a matching
  hash is adopted as is) and, on panel containers only, `seylo.user`.
  Containers any other component runs (cron runs,
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
  `deploy.mode = RECREATE`. It runs as the panel user
  (`docker.PanelUser`, uid and gid 61000, which no login user has;
  `--user` and the label `seylo.user=61000:61000`) whatever the spec says,
  so the spec never sets a user. Before a panel container is created,
  `preparePanelDir` gives `<dataDir>/panel` and everything in it to that
  user through an `os.Root` (links are changed themselves, never
  followed) and sets the folder to 0700 and `master.key` to 0600. When
  `/etc/passwd` or `/etc/group` has an entry with id 61000 (an account
  made after the install, or there before an upgrade moved the folder
  from uid 1000), each panel container start names it in the agent's log
  and as a SYSTEM line in the panel's own log, and the node health check
  `panel.files` warns (it also warns when the folder belongs to another
  uid or is open to other users). The check runs on the panel's node only:
  the one whose last accepted desired state (`state/desired.pb`) has the
  protected panel service, or, before the agent has a desired state, the
  one with a protected panel container. Elsewhere the folder is a leftover
  (an uninstall without `--purge`, a panel that moved) and it passes. A panel
  container without `seylo.user` (from an agent or installer before
  0.2.0-rc.2: the image's uid 1000, often the default login user) serves
  no spec and is replaced once at its generation; the old one is stopped
  and renamed `<name>-prev` rather than removed, and when the new one
  fails it starts again with the folder given back to its old owner.
- Unhealthy running instances leave the route while another replica of
  the serving generation is healthy; a lone unhealthy replica stays
  routed (the service is DEGRADED). Reconcile writes SYSTEM lines into
  the service log (deploy started, healthy and serving, failed, rolled
  back, exited with code N).
- `services/` and every `services/<id>/` (and `files/`) are 0700
  (`datadir.PrivateDirMode`, `MakeServiceDir`/`MakeServiceVolume`; every
  code path that creates them goes through those: reconcile, backups and
  restores, volume transfer, and the file manager when it is the first to
  touch a service's volume), under a data dir that is 0711: file mounts
  are secrets and volumes hold app data. dockerd sets up volumes and bind
  mounts as root, so containers need no rights on them; file mounts keep
  their own modes (0644 by default) and volume folders 0755. The agent
  sets these modes on every start (`SecureServiceDirs`, for folders older
  agents made 0755), and the `disk.permissions` health check warns when
  one is open to group or others.
- `services/<id>/runtime.json` is reconcile's memory across agent restarts
  (crash-policy halt, the crash streak and its latest crash, failed
  generation, sleeping, containers re-attached to another project's
  network, a rollout in flight); it and file mounts are written with
  `state.WriteFileAtomic` (fsync of the file and the folder).
- File mounts live in `services/<id>/files/<spec hash>/<sha(path)>-<name>`,
  bound read-only: one folder per spec hash, so every container binds the
  content it was created with (Docker resolves bind sources again on each
  start; a deploy that changed a file and failed cannot hand it to the old
  generation when that one starts again). Folders of hashes no container
  of the service uses go once a generation serves and the older ones are
  removed. Files directly in `files/` (agents before 0.2.0-rc.2) are left
  alone: containers created then bind them; they go with the service.
- A rollout is recorded (`rolling`: generation, hash, the containers it
  found, the ones recreate mode stops) before it stops or creates
  anything, and cleared once the new generation passed its health check
  and route check, or once a failed rollout's rollback finished. The
  rollback runs on a context of its own (30 s), so an agent that stops
  during the health check (update, `seylo restart`, SIGTERM) still removes
  the unverified containers and starts the stopped old ones before it
  exits; the next start deploys again. A record still set when a pass
  starts (a crash, or Docker refused the rollback) is finished first: the
  containers the rollout created are removed and the old ones it stopped
  start again, so an unverified generation is never adopted as serving,
  never replaces the old one and is never reported SUCCEEDED.
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
  binaries live in `<datadir>/tools`. A builder's container
  (`buildx_buildkit_<builder>0`) runs on Docker's default bridge, so it
  gets the DNS servers Docker gives every container. A build that failed
  with a name lookup error in its output (BuildKit's "lookup <name> on
  <server>:53", "dial tcp: lookup", "no such host", and the resolver
  messages of RUN steps: "Temporary failure in name resolution",
  "Temporary failure resolving", "Could not resolve host", "getaddrinfo
  EAI_AGAIN"; the last 64 KiB of output are read) gets one more log line
  after "The build failed - the lines above say why" (`build.DNSHint`),
  pointing at the node's Container DNS check (Health tab, or `seylo
  health`). The failure message itself stays the same.
- Networking: the own Traefik `seylo-traefik` (`traefik:v3.7.15`,
  file provider only, restart unless-stopped, `seylo.role=traefik`) reads
  `<datadir>/traefik/dynamic` and keeps `acme.json` in
  `<datadir>/traefik/acme`; entry points `web` :80, `websecure` :443,
  `seylo-lb` :5757 (TLS, other nodes' load-balanced traffic, local replicas
  only; with `NodeSettings.lb_tls` mutual TLS: LB routers use the TLS options
  `seylo-lb` from `seylo-lb.tls.yml` (anchor router for the shared
  `server_name` and the node's own `node_server_name` SNIs; client CAs: with
  `lb_tls.peers` the one-off issuers of the listed nodes' certificates, so
  only a certificate the panel issued to a current node opens it; from older
  panels, or while a listed peer is `legacy`, any certificate of the LB CA),
  and a balancing node gives each copy on another node a Traefik service and
  serversTransport of its own (`seylo-<id>-node-<node id>`, under a
  `weighted` main service: one share per local replica, one per node; the
  sticky cookie `seylo_<id>` picks the node's copy and `seylo_<id>_r` the
  local replica) that verifies the peer against the LB CA by the name
  `peers` lists for it and presents this node's certificate and, while it
  lives, the previous one (Go's TLS client sends the one whose issuer the
  peer asks for); copies on nodes `peers` does not list are not dialed;
  without a complete `lb_tls` no route file has a router on `seylo-lb`, so
  the entry point, published on every interface, answers 404 to everyone
  instead of taking any client. The panel issues each node's certificate
  on connect, for 30 days, signed by a one-off issuer (a CA with path length
  0 the LB CA signs; its key is thrown away) and valid for `lb.seylo.internal`
  and `<node id>.lb.seylo.internal`; the hourly prune job renews it for
  connected nodes with under 20 days left, and one from before 0.2 (no
  issuer of its own) or issued for longer is replaced at once
  (`modules/nodes/lb-tls.ts` `issueNodeCertificate`). Every node's settings
  list every node with a live certificate (`peers`); removing a node, a
  renewal, a confirmation and a certificate's expiry resend the connected
  nodes' settings (`refreshLbPeers`). A renewed node's previous certificate
  stays accepted until the node accepted a full SyncDesired carrying the new
  one (`agents.desired.onSynced`) plus 2 minutes, and it presents the
  previous one until it expires. `seylo panel rotate-key
  --new-panel-identity` makes a new LB CA. A node it cannot
  issue one for, for example because the LB CA key does not open with this
  master.key, gets one `node_health_check_failed` alert naming the reason,
  resolved once it has a certificate), resolver `le` (HTTP-01; `SEYLO_ACME_CA=staging|<url>` overrides the
  directory; for a test CA, config.yml `acme_ca_certificates` (a PEM file,
  mounted as `LEGO_CA_CERTIFICATES`) and `acme_ca_server_name`, or the
  `SEYLO_ACME_CA_CERTIFICATES` / `SEYLO_ACME_CA_SERVER_NAME` env). The ACME
  contact is the first owner's email (`NodeSettings.acme_email`). A change of
  the image, the contact or any other part of the container's spec recreates
  the container, logged at INFO as `Traefik recreated` with the reason.
  Creating the owner resends the settings of every connected node (others
  get them with the full sync when they connect), so the recreate for the
  new contact happens during setup, before anything is routed. A node with
  no desired state yet (a fresh join, revision 0) makes its first Traefik
  only once the first desired state arrives, or after 15 s without one, so
  it is made once, with the contact, and not replaced seconds after the
  join (since 0.2.1). Next to the Wings fork the files go to its
  `<proxy.data_dir>/dynamic` instead. The edge listener binds
  `<seylo-edge gateway>:5756`; Traefik rewrites to its paths under
  `/_seylo/` (`/page/maintenance/<id>`, `/page/status/<id>`, `/ticket`,
  `/handoff`, `/probe`). Every route with hosts also sends
  `/.well-known/<slug>-origin/` (`proxy.OriginPath`) to the edge, in every
  mode (running, stopped, maintenance), on web without the HTTPS redirect
  and on websecure with the route's TLS (Traefik's default certificate,
  `tls: {}`, for a route with HTTPS off, since 0.2.12: behind Cloudflare's
  Always Use HTTPS with SSL/TLS Full the check reaches 443 whatever the
  route serves), at priority 1999998000 (above
  every router of the hosts, owned ones included; Traefik's ACME challenge
  router never matches the path), without the route's middlewares (an
  allowlist or basic auth would hide the node from the check); routes of a
  service on the same hosts share them (the TLS of the first route with
  HTTPS on), the tool host and the LB file get none. An ACME route with
  `Route.acme_challenge_on_https` (held or not; the agent sets it on every
  tool host) also sends `/.well-known/acme-challenge/`
  (`proxy.AcmeChallengePath`) on websecure to Traefik's own challenge
  handler `acme-http@internal` (`proxy.AcmeChallengeService`, there
  whenever a resolver has the HTTP challenge on, as the agent's Traefik and
  the Wings fork's `le` both do), with `tls: {}`, no middlewares, at
  priority 1999997000 (above every router of the hosts but the origin
  ones), since 0.2.12: Let's Encrypt follows a redirect from http to https
  without checking the certificate, so behind Cloudflare's proxy with a
  redirect to https that takes every path (a Redirect Rule or Page Rule;
  Always Use HTTPS itself leaves `/.well-known/acme-challenge/` alone, seen
  on a live domain 2026-11-12) and SSL/TLS Full its request reaches 443,
  where before only the app (or Traefik's 404) answered and neither the
  first certificate nor a renewal came (Traefik's own challenge router is
  on web only). The handler answers only the tokens of its own orders in
  progress and 404 for the rest, never falling through, so while the field
  is set an app on the host cannot answer challenges over https itself (a
  central responder other servers redirect their challenges to): the panel
  leaves the field off for a domain whose last DNS check saw it point
  straight at the node, where the CA reaches port 80 and the app keeps the
  path on 443. Routes on the same hosts share the router of the first with
  the field; the LB file and the database certificate router get none. The edge answers `GET <OriginPath><challenge>` (16 to 128
  base64url characters, anything else 404, before the tool header is
  looked at) with the node key's Ed25519 signature over
  `<slug>-origin-v1` 0x00 host 0x00 challenge (host from the Host header,
  lower case, without port, brackets or a trailing dot), base64url without
  padding and a newline, as `text/plain`, `no-store`, nosniff. Every page the edge serves (custom maintenance and
  down pages as is, its default pages) carries
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline' https:; img-src https: data:; font-src https: data:; frame-ancestors 'none'`
  and `X-Content-Type-Options: nosniff`; Traefik's errors middleware passes
  them on for the 502/504 down page (verified in the VM). Next to the Wings fork the LB entry point is a
  second Traefik of ours, `seylo-traefik-lb` (LB entry point only, file
  provider on `<datadir>/traefik/lb-dynamic`, where the router writes each
  service's LB routers in its own `seylo-<id>.yml`); reconcile attaches it
  to project networks like the fork's Traefik. The mode is picked at agent
  start; a node that switches to the fork's proxy (it came after our own
  Traefik) has its managed `seylo-traefik` removed before the LB Traefik
  starts (it held 80, 443 and 5757 and served stale route files), and the
  fork's Traefik is started when it is not running. Tool session cookies are
  signed with `<datadir>/network/edge-session.key` (kept across agent
  restarts) and name the ticket's subject and user (`edge/session.go`; the
  older subject-only format is refused, one more sign-in). The edge asks
  the panel `PanelService.CheckEdgeAccess`
  (`panel.edge-access.v1`) about each user on each tool in use at most
  once a minute, open WebSockets included: `allowed: false` ends that
  user's sessions on that tool opened before the answer and closes their
  connections; a new ticket opens it again. While the panel gives no
  answer (UNIMPLEMENTED, offline) a session lasts an hour past the panel's
  last "yes" or its ticket; 12 hours caps every session. The panel
  answers it in `databases/edge-ticket.ts` `edgeAccessAllowed`: the
  subject must be `box:<id>` or `db-ui:<id>` of a service that runs on the
  asking node, the user must exist and not be disabled, and must still pass
  the permission of `boxes.open` / `databases.openWebUi` on that service
  (`mayOpenEdgeTool`, the op contracts' own permission); a Box or a
  database is checked to be one. 300 checks per node, then 5 a second
  (RESOURCE_EXHAUSTED). A ticket's `uid` is the user's id for a browser
  session and `key:<api key id>` for an API key (`edgeToolLink`), so a
  session opened with a key is checked as that key: its action list,
  projects and read-only flag, and it ends when the key is revoked or
  expires. Route certificate failures come from the Traefik container's
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
  self-signed one in `<state>/db-tls/<id>.{crt,key}`), the same files
  `dbtools.ExposedTLS` installs in exposed Postgres and MySQL. Since
  0.2.12 `Ports` reports that certificate for every port that serves the
  agent's (`Listener.AgentCertificate`, `dbengine.AgentCertificate`; not
  MariaDB, which serves its own): `OpenPort.certificate_issuer` and
  `_expires_at`, and for a self-issued one (its own issuer, signed with
  its own key: the fallback) `certificate_self_signed`,
  `certificate_pem` (public) and, with a `tls_hostname`,
  `certificate_error`, the edge's last ACME failure for that host from
  Traefik's log (`Config.CertificateFailure` = `proxy.CertFailures.Failure`,
  the same message a route's CERTIFICATE_FAILED carries). Tool hosts are `seylo-box-<id>.<wildcard>` and
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
  "invalidate", ops: [...], match? })` for the queries it affected
  (`match`, for example `{ range: ["1h"] }`, limits it to cached queries
  whose input holds one of those values). Topics: `panel`,
  `project:<id>`, `service:<id>`, `node:<id>`. The web app
  (`lib/live-invalidate.ts`) refetches an op at most once a second however
  many events name it, and nothing while its tab is hidden: what waited
  runs once when the tab is shown. `node-live:<id>` (`nodes.view`, like
  `node:<id>`) carries data, not invalidations: the node's `nodeLive`
  samples every 2 s, which cost agent work only while some tab follows it
  (`live.onTopicActive(listener)` on the hub hears a topic's first follower
  arrive and its last one leave, by unsubscribe, a closed socket or a
  dropped grant; `live.subscribers(topic)`).
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
- Admin-only scoped actions (`permission.project|service(action, resource,
  { adminOnly: true })`, since 0.2.10 `services.export` and
  `services.import`): checked on the resource like any scoped action, so an
  admin's key limited to some projects holds them there only, but members
  never hold them whatever a grant lists (`access.ts` `isAdminOnly`, also in
  `canSomewhere` and ticket checks), they are in `actionCatalog` with
  `adminOnly: true` and never in `grantableActions`.
- `services.create` makes a service; what the new service gets beyond that
  is its own permission in the project, whichever op makes it
  (`services/create-rights.ts` `assertCreateRights`, FORBIDDEN with
  `details.action`): an env the caller wrote or picked needs `env.edit`
  (dockerHub.create `env`, a template's app env, compose members'
  `environment:`), file mounts `files.write` (templates), and running it
  `services.deploy` (services.create and dockerHub/templates/compose.create
  with `deployNow`, databases.create and boxes.create, which always start,
  and a template with a database). compose.update needs `env.edit` on the
  stack when it changes a member's env and `services.deploy` when it
  creates or changes a member. services.clone and services.start of a
  never-deployed service follow the same rule, so `services.create` alone
  makes services that someone who may deploy starts.
- Grants (`grants` table): one row per member per project or service, with
  a list of actions (`*` = all grantable ones). A project grant covers the
  project's services, so it takes project and service actions; a service
  grant takes service actions only; global actions are never granted.
  Anyone with `grants.manage` on a resource can share it, but only with
  actions they hold there. Invites carry the same grant list and turn into
  grants on accept.
- Credentials: browser sessions or `Authorization: Bearer <token>`. A
  browser session has two halves, both stored hashed (`sessions.token_hash`,
  `sessions.key_hash`; `src/auth/sessions.ts`), and works only with both: an
  opaque token in an HttpOnly, SameSite=Lax, Path=/ cookie without Domain,
  named `__Host-<slug>_session` (and Secure) on HTTPS, `<slug>_session` on
  plain HTTP (`sessionCookieName` in `@seylo/ops`; set and read by the same
  rule, `secureSession` in `src/http/https.ts`); and a session key the
  sign-in answer hands out in the `x-<slug>-session-key` response header
  (`sessionKeyHeader`). The web app keeps the key in its origin's
  localStorage (`<slug>.sessionKey`, `apps/web/src/lib/session-key.ts`) and
  sends it in that header on every call; the live socket takes it as the
  `key` query parameter, the MCP consent form as a field. Cookies have no
  port, so on a plain-HTTP IP:port panel the browser also sends the cookie
  to every other port of the address (a member's first-run app); the key
  is per scheme, host and port, so such a copy signs nobody in. Over HTTPS
  only the `__Host-` cookie is read, so a cookie a sibling subdomain sets for
  the parent domain is ignored, and a request carrying the read cookie name
  twice is refused (UNAUTHENTICATED `reason: duplicateSession`; the sign-in
  page says to clear the site's cookies). 30-day sliding on use: requests
  through the op pipeline slide it (at most once a minute), the live
  socket's own checks do not (`authenticate(..., { touch: false })`), and
  the web app holds live invalidations while its tab is hidden, so an open
  but unused tab lets the session expire. Sessions without
  a key (made before keys existed) sign nobody in. Sign-out answers an
  empty key header (the web app forgets its key). A
  bearer token is an `api_keys` row: kind `api` (`<slug>_key_...`) or
  `mcp` (`<slug>_mcp_...`, from apiKeys.create or the MCP OAuth flow). A
  key acts as its owner, narrowed by its `actions` list (`*` = all of the
  owner's), its optional `projectIds` (then it holds no global actions)
  and `readOnly` (queries only). MCP tokens are read-only by default. A
  key narrowed by projects or actions (`isNarrowedKey` in
  `src/auth/access.ts`) never runs account-wide ops
  (`permission.account()`: the `ai.*` chats, `apiKeys.list`,
  `auth.security`, `auth.preferences`, `auth.updatePreferences`,
  `grants.mine`; FORBIDDEN `reason: narrowedKey`, and MCP tool lists leave
  them out), reads `approvals.list`/`get` only for its own requests and
  approvals of ops its actions cover aimed at its projects, and
  `audit.list`/`get` only with `audit.view` in its action list and only
  its projects' entries. Read-only alone does not narrow.
  Bearer wins over the cookie. Only sessions create keys, and account
  security ops (password, 2FA, passkeys, GitHub link, sessions, profile,
  email, avatar) refuse keys (`requireSession` in `src/auth/sign-in.ts`). A session lives
  at most 90 days from sign-in and its token and key rotate on password and
  2FA changes. Ops that add a way in (`auth.passkeyRegisterBegin`,
  `auth.githubLinkStart`, `auth.totpEnroll`, `apiKeys.create`,
  `cliLogin.approve`, a first password in `auth.changePassword`) also need
  a fresh session: signed in or confirmed with `auth.reauth` (password, an
  authenticator or recovery code, or a passkey via
  `auth.reauthPasskeyBegin`) or with the linked GitHub login
  (`auth.reauthGithubStart` and `auth.reauthGithubPoll`, the sign-in
  device flow with the sign-in scopes; only a GitHub user id equal to the
  account's linked one counts, and the token is kept as after a GitHub
  sign-in) in the last 15 minutes (`requireFreshSignIn`
  in `src/auth/fresh.ts`, `sessions.reauth_at`). So does changing the
  email one signs in with: `auth.changeEmail` (asked before the address is
  even checked, so a session left open learns nothing about other
  accounts; a taken address is CONFLICT `field: email`; it raises a
  `security_change` alert and emails the old address when the panel has an
  SMTP channel, `oldAddressNotified`), and `users.update` on one's own account with a new email
  (`requireFreshIfSession`, so People is no way around it). Otherwise FORBIDDEN with
  `details.reason: "reauth"`, which the web turns into a re-auth dialog
  and a retry. Wrong answers (another GitHub login too, `details.field:
  "github"`) count toward the per-address lock. Nothing in the web app
  calls these ops in the background: the dialog opens only for a change
  the person made. The MCP
  OAuth consent (`/oauth/authorize`) sends a stale session to the web
  app's `/reauth?redirect=<back>` page first and refuses a stale Allow.
  Ops that hand someone else lasting access need the same fresh session
  when a browser session runs them, while API keys pass
  (`requireFreshIfSession`; every key was made under a fresh sign-in):
  `invites.create` (every role: a member invite carries its grants),
  `grants.setOnProject` and `grants.setOnService` when the new action list
  gives anything the person's grant there did not (a new grant, an action,
  or a wildcard that also covers later actions: `grants/rows.ts`
  `grantAdds`), `users.updateRole` to a higher role (admin or owner),
  `nodes.createJoinToken`, `gitProviders.create` and `gitProviders.update`
  with a new token or user name (a token with write access to
  repositories and webhooks). Removing or narrowing a grant and demotions
  are not gated.
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
- Release channel: `updates.setChannel` takes `updates.manage` but only the
  owner's calls (session or key) change it (FORBIDDEN otherwise, audited
  either way); it is `mcp: false`. `updates.status.canChangeChannel` says
  whether the caller may.
- Model callers (transport `mcp` or `ai`, or any `mcp` token on any
  transport) only reach ops with `mcp: true`; everything else is FORBIDDEN.
- Approval: a destructive op from a model fails with `APPROVAL_REQUIRED`
  (403) unless the call carries
  `approvalId`, which only the approvals module sets when it replays a call
  a person approved (the approvals module checks that the approval matches the op and input).
  The one exception: `mcp` tokens (on any transport) while the MCP setting
  "Ask before destructive actions" is off (`mcp.update`
  `askBeforeDestructive: false`, settings key `mcpAskBeforeDestructive`,
  on when missing) run it right away, still audited and still refused for
  read-only tokens. The assistant (transport `ai`, a session) skips it
  only in auto mode, below; otherwise it queues every change itself.
  The other way: `OpCall.autoMode`, which only the assistant's loop
  sets (transport `ai` only, never from input) for a person who turned
  auto mode on (`ai.setAutoMode`, browser sessions only, stored on
  `users.ai_auto_mode`, off for new people): the call runs as that person
  after the same permission check, audited with `autoMode: true`. The
  loop reads the setting at each tool call, so turning it off stops the
  next change; with it off, every non-query call becomes an approval.
- Approval sources: an approval names where it came from
  (`Approval.source`): `assistant` with the chat's id, its title only for
  the person whose chat it is (`mine` when it still exists, so the chip
  opens it), or `mcp` with the token's id and name. `requestApproval`
  stores the name it had (`source_label`) for after the chat or token is
  gone, so MCP's `tools.ts` passes nothing new.
- Second factor: sign-in ops return a `LoginResult`; with 2FA there is no
  session yet, only a 5-minute ticket (`auth_challenges`) that
  `auth.verifySecondFactor` exchanges for one. The challenge says whether
  the account has an unused recovery code (`hasRecoveryCodes`), so the
  sign-in screen offers one only then. Passkey sign-in (user
  verification required) skips it. Five wrong passwords or codes in a row
  from one client address lock that email (account or not, so the answer
  never tells which emails exist) or account for that address for 30 s,
  doubling up to 15 minutes; 15 quiet minutes forgive the streak, and
  `users.enable` clears every address's streak (`src/auth/lockout.ts`,
  in memory). Addresses are grouped for locks and the anonymous rate-limit
  bucket by `addressKey` (`src/http/ip-ranges.ts`): IPv4 exact, IPv6 by its
  /64. A brake per typed email counts wrong passwords from every address:
  past 50 within the same forgiveness window the email gets one password
  check every 2.5 s and one at a time, whatever the number of addresses
  (the rest answer RATE_LIMITED with `retryAfter`, nothing sleeps in the
  panel), and the account gets one `security_change` alert per streak.
  Address groups that gave the right password for that email in the last
  30 days skip the brake, so a campaign does not keep the owner out
  (`users.enable` clears the brake too). A second brake per account counts
  wrong second-factor codes from every address (`auth.verifySecondFactor`,
  `auth.reauth`, `auth.totpDisable`, `auth.regenerateRecoveryCodes`): from
  the 10th within the forgiveness window, authenticator codes for the
  account are checked at most once every 2.5 s, doubling with every further
  10 wrong codes up to once a minute (the rest answer RATE_LIMITED with
  `retryAfter` and spend no ticket attempt), with one `security_change`
  alert ("many wrong authenticator codes") per streak. A right code does
  not end the streak. Address groups where the account finished a sign-in
  (both factors, or a passkey) in the last 30 days skip it; the right
  password alone does not count, since a code guesser has it. Recovery
  codes are not braked (50 bits each), so the owner always has a way in
  from a new address; their failures still count (`codeThrottle` in
  `src/auth/lockout.ts`, `modules/auth/code-check.ts`; `users.enable`
  clears it). At most 4 password verifications
  (argon2id, about 64 MiB each) run at once, 32 wait, and the rest answer
  RATE_LIMITED (`src/security/password.ts` `verifyLimits`). Recovery codes are stored as HMACs (`secrets.sign(code,
  "recovery-code")`), not bare SHA-256: they carry only 50 bits.
- Audit: the pipeline records the permission's target and its name before
  the op runs (so deletes keep it); refused attempts keep the target id but
  no name. Public sign-in ops call `ctx.auditAs(user)` so the entry belongs
  to the person who signed in (or whose password was tried).
  Failed anonymous calls are stored up to 200 an hour (`anonymousErrorRows`
  in `src/ops/audit.ts`, in memory); past that only one log line says so.
  The audit log keeps entries for `settings.general.auditRetentionDays`
  (30 to 3650 days, default 365, null = forever; Settings > General >
  Activity log; MCP tokens and the assistant may not change it), pruned daily by the `audit.prune` job
  (`modules/audit/retention.ts`); successful entries of `auth.*`,
  `apiKeys.*`, `users.*`, `invites.*`, `grants.*`, `cliLogin.*`,
  `hostShell.*`, `mcp.*`, `setup.*` and `nodes.createJoinToken` are kept
  whatever it says (`keptAuditOps`).
- Security log lines: besides the audit table, the pipeline writes one pino
  warning per failed sign-in (UNAUTHENTICATED from a public op, "sign-in
  failed"), FORBIDDEN ("op refused", re-auth refusals carry `reason:
  reauth`) and RATE_LIMITED ("op rate limited", locks carry `reason:
  locked`, the per-email and per-account code brakes `accountBrake`), with `opId`, `ip`, `actor`
  (the person when known), `transport` and `code`, never input. A rejected
  agent hello logs `remoteIp` with its reason and node id.
- Setup link: the installer writes a `<slug>_setup_...` token to
  `<dataDir>/setup-token` (one line, 0600) before the panel's first start
  and prints `<url>/setup?t=<token>`; an http:// link ends with one calm
  line, dim on a terminal that takes colors (TERM not dumb, NO_COLOR
  unset): "Tip: the panel uses plain HTTP until it has a domain. Add one
  in the setup wizard to switch to HTTPS." (`go/internal/cli/panel.go`
  `plainHTTPTip`, also under `seylo panel setup-link`; changed in 0.2.1
  from a three-line warning that scared people during installation).
  While no owner exists the panel
  imports it on start (valid one hour) or writes a fresh one there;
  `bun scripts/setup-link.ts [baseUrl]` in apps/panel prints a new link.
  Creating the owner burns the token and deletes the file.
- Links the panel hands out: invites are `<origin>/invite?t=<token>`
  (panel domain when set, else `OpCall.origin`, else a path the web app
  completes with its own origin).
- Avatars (`modules/avatars`, `src/auth/avatar.ts`; contracts in
  `ops/avatars.ts`, the style catalog and URL builders in
  `packages/ops/src/avatars.ts`): `users.avatar` is
  `{ kind: "preset", style, seed }` or `{ kind: "upload", style, seed,
  hash, contentType }` (the face stays under an upload), the upload's
  bytes are in `user_avatars` (gone with the account). Every way to create
  an account sets a random face in `defaultAvatarStyle` (setup with a
  password or GitHub, an accepted invite, `scripts/create-owner.ts`:
  `randomPresetAvatar`), and the module's `start` gives one to every row
  without (accounts from before 0008_user_avatars). Outputs carry the
  optional `avatarUrl` (`Viewer`, `User`, grants' people, audit actors,
  approval requesters; `avatarField`, `avatarUrlsOf`). Faces are drawn by
  the panel with the pinned `@dicebear/core` and `@dicebear/collection`
  (never api.dicebear.com) at `GET /api/avatars/<style>/<seed>.svg` (style
  from `avatarStyles` else 404, seed `avatarSeedPattern` else 400, cached
  in memory, a year immutable, compressed); uploads at
  `GET /api/avatars/user/<id>?v=<hash>`, answered only with the current
  hash (the URL is as private as the lists that show it; `<img>` cannot
  send the session key). Uploads are PNG, JPEG or WebP whose first bytes
  say so, at most `avatarMaxBytes` (1 MiB) after the web app cut the middle
  square and scaled it to 256 px (`lib/avatar-image.ts`); never SVG; served
  with nosniff and a sandboxing CSP; the data URL is sensitive (not in the
  audit log). Only styles whose artwork is CC0 1.0 or CC BY 4.0 are
  offered (a test checks each against its package's own license); NOTICE
  and the picker's credit line name the artwork, creator and license.

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
  `sealPurposes`. Tokens are stored as SHA-256 hashes only. After a leak,
  `sudo seylo panel rotate-key --new-panel-identity|--keep-panel-identity`
  on the panel's node (`go/internal/cli/rotatekey.go`) runs
  `scripts/rotate-master-key.ts`: it refuses without root, on a node
  without the panel (no `panel/master.key`/`panel.db` or no panel
  container), without exactly one flag, or when the panel's image is a
  release before 0.2.0-rc.2 (its `org.opencontainers.image.version`
  label; that script rejects `--from-cli`, so it says to update the panel
  first; `dev` or no label runs); then stops the agent, stops the
  panel container, runs `bun apps/panel/dist/rotate-master-key.js <flag>
  --from-cli` from the panel's own image id (`docker run --rm --name
  seylo-rotate-key --network none`, data dir mounted, `SEYLO_DATA_DIR`
  set), starts the agent (whose reconcile starts the stopped panel), waits
  for `/api/health` on the panel's `SEYLO_HOST_PORT` and prints the
  script's output. Once the agent is stopped every error path starts it
  again; the script runs in its own process group without the command's
  context, so Ctrl-C (or SIGHUP) only skips the steps not started yet; a
  script cut off with `master.key.new` left is run once more. The script
  (also runnable by hand with the panel stopped) seals every sealed value
  of panel.db again under a new `master.key` in one transaction (sealed
  columns and sealed strings inside JSON such as settings, each purpose
  found by trying them all; a value no purpose opens aborts with nothing
  changed and the new key files removed), deletes recovery codes (HMACs
  under the old key) and lists their owners. It holds panel.db's write
  lock (`BEGIN IMMEDIATE`) from before the new key files exist until the
  commit. New key files wait as `master.key.new` and `agent-tls.key.new`
  until the commit; then `agent-tls.crt` goes, `agent-tls.key.new`
  replaces `agent-tls.key` and `master.key.new` replaces `master.key`
  last. The re-join plan is made inside the transaction, and a join URL
  that cannot be worked out (a stored address that is no valid host) only
  turns the other nodes' commands into `'<url>'`/`'<pin>'` placeholders
  with a line pointing to Nodes > Add node: once the keys are replaced
  nothing reports the rotation as failed. A later run, and the panel's
  start (`finishInterruptedRotation` in main.ts, which waits up to 60s for
  the write lock, so a rotation still running is never taken for a
  leftover), finish the rotation when `master.key.new` is left and any
  sealed value opens with it (or nothing is sealed); otherwise the run
  never committed (or an rc.1 run failed and left the file), and both
  remove the leftovers: the panel starts on the old key and logs a
  warning, a run rotates from the old key again. The
  flag is required because the edge ticket key is also the panel's
  identity to its nodes (they pin it on the first connect and refuse a
  panel with another one): `--new-panel-identity` (panel.db leaked, as in
  a copy of the data dir) drops the edge ticket key and the LB CA and node
  certificates so the next start makes new ones (they are not in the
  re-seal count), replaces the agents' TLS key (it is in the same copy;
  its certificate is made again on the next start, so the pin changes),
  keeps `panelId`, and prints every enabled node with its exact command:
  `sudo seylo join '<url>' --token '<token>' --pin '<new pin>' --force`
  with the Add node dialog's URL (`modules/nodes/join-target.ts`, the
  host and TLS ports from the stored `panelHostPort`/`panelAgentTlsPort`
  settings), and for the panel's own node
  `sudo seylo join http://127.0.0.1:<host port> --token '<token>'
  --can-build --force` (`--can-build` when the node may build); the token
  is a new one from Nodes > Add node per node, and until then the node
  refuses the panel. `--keep-panel-identity` (only `master.key` leaked,
  panel.db never did) seals the edge ticket key and the LB CA again like
  every other value and leaves `agent-tls.key`, so nodes keep working.
  The panel build writes the script as `apps/panel/dist/rotate-master-key.js`.
- Logging: pino JSON with camelCase keys (`opId`, `nodeId`); take the
  logger from deps. Never log secrets, tokens or env values.
- Config comes from `<SLUG>_*` environment variables (`src/config.ts`);
  nothing else reads `process.env`.

Web:

- Every visible string through `t("section.key")`. Each section is one
  file, `src/i18n/en/<section>.ts` (default export); add keys to the
  screen's own section and create a new section file for a new screen.
- Styling only through tokens (`packages/ui/src/styles/theme.css`) and the
  utilities mapped from them; theme presets override variables. Every
  preset has a light and a dark half: `<html data-theme="<preset>">` picks
  the preset and the `dark` class on `<html>` the half (Tailwind's `dark:`
  variant is that class). The default (`seylo`) is `:root` and
  `:root.dark`; every other preset has its corners under
  `[data-theme="<id>"]`, its light colors under `:not(.dark)` and its dark
  colors under `.dark`, each setting every color the default's dark half
  sets (`theme.test.ts`). All theme selectors are wrapped in `:where()` so
  they weigh `:root`: the accent and the owner's CSS win by coming later.
  Accent-colored tokens (`--ring`, `--chart-1`, `--link`, `--link-hover`,
  `--accent`, `--accent-foreground`, `--highlight`, `--shadow-primary`,
  `--primary-hover`) are mixed from `--primary`, so a new screen uses them
  and never a literal accent color. `cn`
  (`packages/ui/src/lib/utils.ts`) knows the theme's shadows
  (`shadow-card`, `-control`, `-primary`, `-segment`, `-popover`,
  `-sidebar`), so a later shadow class replaces them; a new shadow token
  goes there too, or plain tailwind-merge keeps both and the stylesheet's
  order picks one.
- Server data only through `useOp` / `useOpMutation`; no hand-written
  fetches.
- An op the panel answers with NOT_IMPLEMENTED renders "Not built yet" in
  place (`components/query-error.tsx`), never an empty screen.

#### Compression

Neither Bun.serve nor Elysia compresses, so the panel does
(`http/compress.ts`): the web build writes `.br` (quality 11) and `.gz`
copies of every compressible file of 1 KiB or more except source maps
(`apps/web/build/precompress.ts`, a Vite plugin), and `http/static.ts`
sends the copy the request's Accept-Encoding takes (highest q, brotli on a
tie; `Vary: Accept-Encoding`). `index.html`, op results (`ops-http.ts`)
and MCP replies of 1 KiB or more are compressed as they go out (brotli 4,
else gzip 6). Downloads, streams and WebSockets are left alone. BREACH
does not apply: an op call signs in only with the session key header or a
bearer token, which a cross-site page cannot send.

#### Theme and branding injection

The panel rewrites `index.html` on every request
(`apps/panel/src/modules/settings/boot.ts`, wired in `http/static.ts`), so
the first paint already has the panel's theme, name and favicon. Names and
types come from `@seylo/ops` (`settings.PanelBoot`, `settings.bootDom`,
`settings.themePresets`, `settings.resolveColorScheme`, `accentCss`);
never type the ids by hand.

- Presets (since 0.2.5): `seylo` (Default), `classic`, `midnight`,
  `graphite`, `clay`, `harbor`, `orchid`, `steel`, `marigold`, `meadow`,
  each with both halves; the color mode (`light`, `dark`, `system`) picks
  the half for all of them. Older data: `seylo-night` (the default's dark
  half) reads as `seylo` with its mode (`settings.themePresetAliases`,
  still accepted by `settings.updateAppearance` for older clients), and a
  row saved before 0.2.5 with the light-only `classic` or the dark-only
  `midnight` reads with that mode (`settings.legacyPresetModes`;
  `readAppearance` in `modules/settings/keys.ts`). Rows saved since carry
  `themeVersion: 2` and mean what they say.
- `<html>` gets `data-theme="<preset>"` (always, `seylo` too),
  `data-color-mode="light|dark|system"`, and the `dark` class for `dark`.
  For `system` the server writes no class: an inline script adds it from
  `prefers-color-scheme` before the body paints, so a dark device never
  sees a light frame.
- `<title>` becomes the panel name; `<link rel="icon">` points at
  `/branding/favicon?v=<hash>` when one is uploaded.
- Last in `<head>`, after the charset meta and the app stylesheet, in this
  order: `<script type="application/json" id="panel-boot">` with the
  `PanelBoot` JSON, the theme script, `<style id="panel-accent">` (when an
  accent is set: `--primary`, the text on it in white or near black,
  whichever reads, and link and selected-item shades checked for contrast
  in both halves; `accentCss` in `@seylo/ops`, the same string in the panel
  and the web app) and `<style id="panel-custom-css">` (owner's custom
  CSS, last so it wins).
  `<` inside them is escaped so nothing can close the element.
- The web app reads the JSON once at start (`JSON.parse` of
  `document.getElementById(settings.bootDom.dataId).textContent`), and
  falls back to the public `settings.boot` op when the element is missing
  (Vite dev server). It listens to `prefers-color-scheme` changes and
  toggles the `dark` class with `resolveColorScheme` (`lib/theme.ts`
  `paintTheme`; `useDarkMode()` for components such as the logo). After an
  appearance or branding save it refetches `settings.boot` and rewrites the
  two `<style>` elements (kept last in `<head>`, accent before custom CSS),
  the `data-theme` / `data-color-mode` attributes, the class, the title and
  the icon link in place: no reload. Compare `revision` to skip work.
- Branding files are served at `/branding/<logoLight|logoDark|favicon>`
  (public, immutable with `?v=`, SVG sandboxed by CSP). Logos in the boot
  data are those paths or null (use the product mark,
  `components/brand-mark.tsx` `ProductMark`; the favicon is then
  `/favicon.svg`). Settings > Appearance shows those defaults in the empty
  tiles, marked "Default".

#### Schedules, alerts, email and the live socket

- Recurring work: `deps.schedules.ensure({ key, jobType, payload?, cron? |
  intervalSeconds?, jitterSeconds?, missedRun?: "runOnce" | "skip", runNow? })`
  (`jobs/schedules.ts`), usually in a module's `start()`. Cron is five
  fields (or `@daily` and friends) in UTC. Each due schedule enqueues one job
  with dedupe key `schedule:<key>`, so a slow run is never doubled; calling
  `ensure` again with the same timing keeps `nextRunAt`. `remove(key)`,
  `removePrefix(prefix)`, `keys(prefix)`, `get(key)`. Every run is a job
  row; jobs that finished more than 7 days ago are deleted at start, then
  once an hour by the runner's tick and by the hourly retention sweep
  (`jobs/queue.ts` `pruneFinishedJobs`, also called from
  `nodes/retention.ts` `pruneTables`), so a panel that runs for months
  holds about a week of them.
- Alerts: `deps.alerts.raise({ event, key, title, message?, serviceId?,
  projectId?, nodeId?, link?, severity? })` (`modules/alerts/sink.ts`). One
  row per `key` ("<incident kind>:<subject>:<start>"); mutes and the
  notification rules decide who is told; delivery is a retried job per
  channel. `deps.alerts.resolve(keyPrefix, recovered?)` closes the incident
  and can record the good news (feed only); it and `isOpen(keyPrefix)`
  match keys as a range on the unique `event_key` index. Agent events (deploy/build
  results, health, backups, node alerts, updates, crashes via
  `agents.onCrash`, node offline after a 60 s grace) become alerts in
  `modules/alerts/events.ts`.
- Email: `deps.notify.sendEmail({ to, subject, text, html? })` returns
  `"sent" | "noChannel" | "failed"` through the panel's SMTP channel.
- Running ops for someone: `deps.ops.execute(call)` is the pipeline;
  `runOpAs(deps, { op, input, userId, transport, approvalId? })`
  (`modules/approvals/run-as.ts`) runs one as a person. Models (MCP, AI)
  never set `approvalId`; only `approvals.approve` does. `autoMode` is set
  by the assistant's loop alone, for a person whose auto mode is on.
- Live sockets are re-checked every 15 s, on open and on each subscribe
  (without sliding the session) and closed
  (code 4401) when their session ended (a socket needs the session key in
  its `key` query parameter); `deps.live.disconnect({ sessionId }
  | { userId })` closes them at once. The re-check also drops topics the
  fresh access no longer allows (an `error` FORBIDDEN per topic);
  `deps.live.recheck({ userId })` does it at once (grants and role changes).
  Since 0.2.1 each live endpoint (the panel port and the tailnet socket
  each build one) wires itself with `live.addDisconnector(fn)` and
  `live.addRechecker(fn)`, which return a remover; `disconnect` and
  `recheck` call every one, so a sign-out closes the person's sockets on
  both listeners (`setDisconnector`/`setRechecker`, which kept only the
  last, are gone). Topics and `publish` are shared by both. `ai:<id>` is for the conversation's
  owner only (owners and admins never read other people's chats, live or
  through `ai.conversations`/`ai.conversation`); `deployment:<id>` needs `services.view` on its service.
  A reply streams there as `ai.AiStreamEvent`s: every `delta` carries
  `at` (the part's text length before it), running tool calls come as
  `part` events, and a reply that starts or starts again (ai.send,
  ai.retry, after its approvals) sends an `invalidate` of
  `ai.conversation` first; `ai.conversation` returns a streaming reply's
  parts as far as they got (`liveParts` in `modules/ai/loop.ts`), so a
  late subscriber or a second tab catches up without doubling text.
  Messages bypass the op pipeline, so the endpoint limits them itself
  (`src/live/endpoint.ts`), before parsing or any database work: a token
  bucket per person over all their sockets (`liveMessageRule`, 300 then 30
  a second); a socket past it is closed with 1008 (the web app reconnects
  with backoff, it is not a sign-out). One socket follows at most 200 topics
  (`maxTopicsPerSocket`); a subscribe past that answers an `error`
  BAD_REQUEST for the topic.
- Text frames on every panel socket (live, terminals, the host shell,
  agents) are checked before Elysia JSON.parses them
  (`src/http/ws-guard.ts`, the `websocket` option of both listeners in
  `main.ts`): Bun takes frames up to 16 MiB, which agents need for binary
  frames, so a text frame over 16 KiB closes the socket with 1009, and each
  socket gets 256 KiB of text, then 64 KiB a second; frames past that are
  dropped unread. Browsers send only small JSON text (subscribe, resize),
  terminal input is binary and agents send binary frames only.
- MCP: `POST /mcp` (Streamable HTTP, stateless JSON replies, protocol
  2025-03-26 to 2025-11-25), MCP tokens only (`api_keys.kind = "mcp"`).
  OAuth: `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource[/mcp]`, `POST /oauth/register`
  (public clients, https / loopback http / app-scheme redirects),
  `GET|POST /oauth/authorize` (server-rendered, `modules/mcp/pages.ts`:
  the GET checks the request and serves a bridge page that reads no
  session; its one script, allowed by its CSP hash, posts the request back
  with the session key from the web app's localStorage, or goes to
  `/login?redirect=<back>` without one; that post answers the consent page
  for a signed-in, fresh session (else 303 to `/login` or `/reauth`). The
  consent page names the app by the host its answer goes to ("Connect an
  app at <host>?"), marks the name the client registered as not verified
  (anyone can register any name), shows the scope it asked for, and
  preselects read only unless the MCP setting "New AI tools start
  read-only" is off (`mcp.update` `readOnlyByDefault: false`, settings key
  `mcpReadOnlyByDefault`, on when missing), then read and change; never
  what the scope asked for. An Allow without a choice is read only either
  way; the Allow form carries the key back),
  `POST /oauth/token` (code + S256 PKCE,
  rotating refresh tokens, access tokens 24 h, a grant lives 90 days),
  `POST /oauth/revoke`. A token sees only the tools it could use;
  destructive calls become approvals while "Ask before destructive
  actions" is on. `mcp.info` also answers a snippet per AI tool and
  one-click install links (`modules/mcp/hosts.ts`, each tool's documented
  format, the server named after the brand slug).

#### Panel service, CLI login, uptime targets and more

- The panel as a service (`modules/nodes/panel-service.ts`): with `SEYLO_IMAGE`
  set (the installer passes it, with `SEYLO_HOST_PORT`), the panel node's first
  connect creates project `panelproject0000` and service `panel00000000000`
  (protected, generation 1, a live deployment of that image). `panelContributor`
  runs last (`DesiredContributor.order`, higher runs later) and fixes its env
  (`PORT`, `HOST_PORT`, `SECURE_COOKIES=false`, never the image), the published
  port (FORWARD; since 0.2.1 with `bind_address` 127.0.0.1 while IP access is
  closed, see "Panel access and the tailnet"), alias `panel`, RECREATE and no
  volumes; with a panel domain it adds the route. The `tailscale` module's
  contributor sets `NodeSettings.tailnet.panel` on the panel node only, and
  only while Serve is wanted and the server is on the tailnet it was turned
  on for, so an install that never used it sends what 0.2.0 sent. Proxy trust and HTTPS (`src/http/proxy-trust.ts`, `https.ts`,
  `domain-redirect.ts`): X-Forwarded-For/-Proto/-Host count only from the
  addresses of `SEYLO_TRUSTED_PROXIES` (default `<slug>-traefik`, resolved
  through Docker DNS every 30 s, and since 0.2.1 also before a request is
  handled when a new address on one of the panel's own networks connects,
  at most once per address per 30 s, waiting up to 1 s: Traefik joins the
  panel's network only when the domain is set and gets a new address when
  recreated, and an agent session opened through it untrusted would keep
  `http://<domain>` as its address), never from the published IP:port (the
  cross-site check `isSameOrigin(request, trusted)` too: an untrusted
  client's X-Forwarded-Host is ignored and the Host header compared).
  `clientIp` (`src/http/client-ip.ts`) normalises addresses and, behind
  Cloudflare, takes the visitor from `CF-Connecting-IP` only when the address
  the trusted proxy vouches for (the last X-Forwarded-For entry) is in
  Cloudflare's published ranges (`src/http/cloudflare.ts`, a list in code);
  otherwise that header is ignored. The session cookie is the Secure
  `__Host-` one on every HTTPS request (trusted X-Forwarded-Proto, so behind
  Traefik and a Cloudflare proxy in Full mode too, or Host equal to the
  panel domain) whatever `SECURE_COOKIES` says, and a plain one on IP:port
  (see Credentials); HTTPS responses carry
  `strict-transport-security: max-age=31536000`, except on the tailnet
  listener (since 0.2.1: the agent moves Serve between https:// and
  http:// when the tailnet's HTTPS certificates change, and a remembered
  HSTS would lock browsers out of the http:// name; WireGuard encrypts
  that path anyway); every response carries
  `x-frame-options: DENY`, nosniff and `referrer-policy: same-origin`. The
  web app's pages carry `appContentSecurityPolicy`
  (`modules/settings/boot.ts`): scripts only from the panel's own files and
  the inline theme script by its hash (never `'unsafe-inline'` or
  `'unsafe-eval'` for scripts; the boot JSON is a data block), inline and
  https styles and fonts, images from self, data:, blob: and https,
  `connect-src 'self'`, workers from self and blob:, `object-src 'none'`,
  `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`. A new
  inline script needs its hash there. Once `panelDomainStatus` is active, page loads on
  any other host (not loopback, not /api) answer 302 to `https://<domain>`. After a successful UpdatePanel the new panel records the
  `panel { image, digest }` of the manifest its update run keeps
  (`update_runs.manifest`; a run from before rc.2 uses the stored check
  while it names that version) at generation + 1 before the flusher
  starts, so a check or a channel switch during the panel step does not
  matter. Deploy, stop and setPlacements answer CONFLICT `reason: panel`.
- CLI browser login (`cliLogin.*`): `start` (public) -> user code, device code,
  `/cli/approve?code=` URL (absolute with `OpCall.origin`); a fresh browser session
  approves with a scope and lifetime (`approve`, default 7 days) or denies;
  `poll` creates the API key ("CLI on <name>") on the first poll after approval
  and returns it once. Requests live 10 minutes (`cli_login_requests`, swept on
  `start`); only the device code's hash and the chosen scope are stored.
  Besides the per-address strict limit, `start` has a strict bucket per
  (computer name, address group): names are guessable, so a name alone would
  let anyone block someone else's computer.
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
  (`blockedReason`: the same ranges as the agent's `netguard`, in the same
  order, IPv4-mapped, NAT64 and 6to4 forms judged by the IPv4 address they
  carry, IPv4-compatible `::/96`, site-local `fec0::/10`, the documentation
  ranges and `2001:db8::/32`, local-use NAT64 `64:ff9b:1::/48` and
  `100::/64`; both suites test against
  `go/internal/netguard/testdata/addresses.json`) are refused on save (BAD_REQUEST `reason:
  internalTarget`) and before every probe, unless every such address is a
  node's address as an admin set it (`nodes.public_address`; the addresses
  an agent reports, `public_ipv4`/`public_ipv6`, never count, since a
  compromised agent could name a private one), or
  `settings.general.uptimeAllowInternalTargets` is on
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
  and the deploy's panel-side ls-remote use the same address check (with
  the git rules of "Git addresses" below, not the uptime setting) and do
  not follow redirects.
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
  repository; the body hashes live in panel.db `webhook_bodies`, so a
  panel restart forgets none, pruned to 3 days and the newest 10,000), a delivery id already handled for the hook's service is a
  duplicate (scoped to the service: GitLab before 17.4 sends sibling hooks
  of one push the same event UUID), rejected deliveries go to the
  service's delivery list with their own row id (20 an hour at most).
  Checked deliveries are limited per hook (120, then one a second), far
  above a busy repository, against a loop with a leaked GitLab token;
  unchecked ones do not use the budget. Past the limit a delivery is
  never refused (providers do not retry, and GitLab turns a hook off
  after 4 failures in a row, a 429 included): it is answered 200
  `{ ok: true, deferred: true }`, not handled (no API lookup), logged as
  ignored, and the next branch poll reads the head whatever the hook's
  cadence (`markPollDue`, in memory), so a push in it deploys about a
  minute late; a merge request event in it is lost. A push never builds a sha from the payload alone:
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
- The connected GitHub account (0.2.2, `modules/github/account.ts`,
  Settings > GitHub "Private repositories without the App"): one per
  panel, a `git_credentials` row for github.com with origin `device` (the
  device flow, `github.deviceStart`/`devicePoll`, repo scope) or
  `github_token` (`github.tokenConnect`: a pasted personal access token,
  fine-grained with Contents: Read and Metadata: Read, or classic with the
  repo scope). A pasted token is checked before it is saved: GitHub must
  accept it (`GET /user`), a classic one must list `repo` in
  `X-OAuth-Scopes`, a fine-grained one (no such header) must reach a
  repository (`/user/repos`) and read its commits (409 for an empty one
  counts); refusals are BAD_REQUEST with `details.field` `token` and
  `reason` `rejected`, `scope`, `noRepos` or `contents`. The token is
  sealed with master.key (purpose `git.credential`) and never returned;
  the input is `sensitive`, so the audit log never holds it. Connecting
  again (either way) replaces the row in place, so its id stays. When the
  new token is another GitHub login's (`storeAccount` in `ops.ts`), the old
  login's repository webhooks are removed first with its token, while the
  panel still has it (another login's token gets 404 for a repository it
  does not administer, so it could never remove them), and their rows wait
  with the reason for `repairRepoHooks` to create them again with the new
  token. Each hook row keeps the login that created it
  (`github_repo_webhooks.created_login`); `github.removeRepoHook` and
  `deviceDisconnect` remove a hook only with that login's token (a 404 to
  it means gone) and log one that stays on GitHub with why. Whose
  token a service uses: the panel-wide connected account, named on the
  GitHub source as `accountId` (git_credentials.id) with `installationId:
  null`; `github.connectRepo`, `github.repos` and `github.branches` take
  `installationId` or `accountId` (exactly one, else BAD_REQUEST), and an
  `accountId` must be the connected account's (NOT_FOUND otherwise). A
  stored source whose account row is gone uses the account connected now
  (`accountForSource`), else deploys fail CONFLICT `reason`
  `noGithubAccount`. `github.installations` names the account
  (`account: { id, login }`) to everyone who sees the installations;
  `github.status.account` (method, scopes, `tokenKind`) is for
  `github.manage` only. Repositories: `GET /user/repos` with
  `affiliation=owner,collaborator,organization_member&sort=pushed`, every
  page of 100 (at most 10) read once a minute at most and again when the
  token changes, then filtered and paged by 30 like an installation's.
  The account reads any public repository, so `github.branches` and
  `connectRepo` through it take only its own: private, one it may push to
  or administer (`permissions` of `GET /repos/{repo}`), or one of its list;
  someone else's public repository is NOT_FOUND (branches) or BAD_REQUEST
  (connectRepo), `details.reason` `notOwned`, and the New app dialog makes
  it a plain git URL, never a source that follows that person's pushes. A
  rate-limited token (403 or 429 with `x-ratelimit-remaining: 0`,
  `retry-after` or "rate limit" in the message, `GithubApiError.rateLimited`)
  is UNAVAILABLE `reason` `rateLimited` in `repos`, `branches` and
  `connectRepo`, never "no such repository"; `connectRepo` answers a
  GitHub that did not answer UNAVAILABLE too.
  Organizations that restrict OAuth app access hide their private
  repositories from a device login until an owner approves the panel's
  OAuth app (github.com/organizations/<org>/settings/oauth_application_policy);
  the App installed on the organization needs no approval (the settings
  page says so). Sharing with members works like an installation's
  (`source-guard.ts` kind `githubAccount`, action `github.manage`, shared
  per repository; any source read through the account counts, as there is
  only one). Clones: the build request carries the account's token and its
  login as the git user for that clone only, like other git credentials;
  nothing is stored on the node. Push-to-deploy: `connectRepo` creates a
  repository webhook with the token (`github_repo_webhooks`, one per
  service, secret per hook sealed with purpose `git.webhook`, events push
  and pull_request) at `POST /api/hooks/github-repo/<hook id>` on the
  panel domain, when there is one and the token may (a classic token or
  device login needs `repo`, `admin:repo_hook` or `write:repo_hook`; a
  fine-grained token is tried and needs Webhooks: Read and write, and the
  account must administer the repository). Otherwise the row keeps the
  reason (`github.repoWebhook`, shown on the Source tab) and the GitHub
  poll schedule reads the branch every minute; with a working hook it
  reads it every 5 minutes as a safety net, like App sources with a
  webhook URL. The poll schedule creates missing or moved hooks again
  once an hour per service (`repairRepoHooks`); `updateSpec` drops the hook
  (row now, GitHub's in the `github.removeRepoHook` job) when the source
  leaves that repository, deleting the service drops it, and
  `github.deviceDisconnect` removes every hook the account made from
  GitHub first (its token is about to go), then the row. Deliveries are
  checked against the hook's own secret (X-Hub-Signature-256) before
  anything is parsed, need X-GitHub-Delivery, are deduped per service,
  replays of a signed body are refused per hook, at most 120 checked
  deliveries then 1 a second per hook are handled (the rest are left to
  polling), and a delivery deploys or previews the hook's own service only.
  Not built: compose stacks through the account (`compose.ComposeSource`
  stays App only).
- Watch paths (`@seylo/ops` `watch-paths.ts`, `services.setWatchPaths`,
  `spec.watchPaths`): ordered globs (`*` not across `/`, `**` across
  folders and `**/` also none, `?`, `!` excludes; anchored at the root; a
  trailing `/` means everything below); for each changed file the last
  matching pattern decides, with only `!` patterns everything else
  counts; a push deploys when one file counts. Matching never backtracks
  and costs the same per character whatever the pattern (`globMatches`
  runs the glob's automaton over the path once with all live states in a
  bit set: one pass, a few operations per character and 32 glob steps;
  repeats such as `**/**/` collapse); a path without the glob's literal
  head or tail (`apps/web/` of `apps/web/**`, `.md` of `**/*.md`), or
  without the longest literal run in between (`__tests__/` of
  `**/__tests__/**`, at most 32 characters of it, searched with
  `indexOf` and charged half a unit per character), is refused before
  the automaton runs. Patterns are tried from the last one back, so the
  first match decides a file. A whole decision is bounded:
  `matchWatchPaths` stops after `watchPathsWorkBudget` (64M units,
  `globCost`: about 110 to 150 ms at worst; 20,000 files of 200
  characters against 50 ordinary patterns, nine of them exclusions like
  `!**/__tests__/**`, use about 42M) and the push deploys ("too many
  changed files to match"); a changed path longer than 4096 characters
  is not matched and makes the list incomplete (which deploys); a
  `{ changedFiles }` body
  keeps at most 20,000 entries (more counts as truncated, like the
  commits path). `webhooks/gate.ts`
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
- Sources and credentials (`modules/services/source-guard.ts`): git URLs
  never carry a secret: the `GitUrl` schema (`@seylo/ops` schemas.ts, every
  git and compose source and `git.branches`) refuses a user name or token
  in an https:// URL and a password in an ssh:// URL (`ssh://git@host`
  stays) with BAD_REQUEST pointing at git credentials, before the input
  reaches a spec or the audit log; the stored spec schema still loads
  sources saved before (`services/spec.ts` `StoredGitUrl`) and every
  answer that shows one drops it (`services/git-url.ts`: `toDetail`,
  `compose.get`, compose read errors). A Box's `repository`
  (`boxes.create`) is an `HttpsGitUrl`: https:// only, no user name or
  token (Boxes have no git credential; private repositories are cloned
  from the Box's terminal); `boxes.get` and clones drop one saved before,
  and only the Box's own `BOX_REPOSITORY` keeps it. Input errors inside a union name
  the field of the variant the caller picked (`ops/validate.ts`). A git
  credential only goes to its own host and a registry login to its own
  registry (checked on save and again before the token leaves the panel at
  deploy time); attaching a credential, registry login or GitHub App
  installation (or git provider connection) to a project needs
  `git.manage`/`registries.manage`/`github.manage`/`gitProviders.manage`
  unless a service of that project already uses it for the same target:
  the same git URL (`normalizeGitUrl`: case, trailing `/` and `.git`
  aside), image repository (`imageRepository`: any tag or digest) or
  repository (`source-guard.ts` `sharedTargets`), so sharing a token that
  reaches every repository of the owner shares one repository.
  `github.repos` and `gitProviders.repos` list only those repositories to
  non-managers; `github.branches`, `gitProviders.branches`,
  `git.branches`, `connectRepo` and saving a source refuse others
  (FORBIDDEN) before the provider is called. Image
  sources (also compose members and templates) may not name loopback hosts
  or port 5755 (the registry relay). Non-managers listing credentials,
  registries, channels or the GitHub device account get names and hosts
  only (a registry's user name is null); webhook URLs show scheme and host
  only. The shared pickers are empty for an account that cannot use them
  anywhere (`Access.canSomewhere`): git credentials, git provider
  connections, registry logins and the GitHub App with its installations
  (`github.status` answers `app: null`, `github.installations` an empty
  list, no install link and `hidden: true`, so the Source tab shows a
  GitHub-connected service's repository and branch read-only instead of
  "Connect GitHub first"; `github.manage` sees them too) need
  `services.create` or `services.update` on some project or service
  (`gitProviders.list` answers `hidden: true` then, and the Source tab shows
  a provider source's repository, branch and webhook state read-only,
  without "Create webhook again"),
  notification channels and
  backup destination choices `services.view` (or the edit action) somewhere;
  a key counts only its own actions and projects. The node field of every
  create form (`NodePicker`, the Docker Hub dialog's architecture) reads
  `nodes.choices`: nodes that are not disabled with id, name, online or
  offline, wildcard domain and arch only, for `services.create` somewhere
  or `nodes.view`, else an empty list; `nodes.list` (addresses, usage,
  settings) stays `nodes.view`, which members never hold. `apiKeys.list all` and
  `approvals.approve` need a browser session (deny works with keys).
- Git addresses (`modules/git/targets.ts` `assertGitTarget`): a generic git
  source (service, compose stack, clone) must resolve to public addresses
  (`uptime/targets.ts` `checkTarget`, no "allow internal targets", and a
  node's own address on a private network is internal here, unlike for
  uptime checks: `ownNodes: false`). A host whose every address is one of
  the panel's nodes' (or whose name is a node's admin-set public host name)
  is internal too, public addresses included (`nodesInternal`, reason
  `node`, "an address of one of this panel's nodes"), since nodes refuse
  their own addresses for git unless the host is allowed. Which of the
  nodes' addresses count (`NodeAddressScope` in `uptime/targets.ts`):
  "trusted" ones are each node's admin-set `public_address` and the public
  address the panel saw it connect from (the `nodeConnectAddresses`
  setting, written at every handshake; behind the panel's Traefik the
  forwarded one); "reported" adds what agents say about themselves
  (`public_ipv4`, `public_ipv6`, which the facts fill first, and
  `NodeFacts.interface_addresses`). An agent can report any address, so
  reported ones count only where an admin stands behind the outcome: a
  `git.manage` caller's save (which records the host, so a git server on a
  node's second address builds), a provider connection's allowance
  (`providerGitVerdict`), `git.allowInternalHost` and the upgrade seed. A
  member's save, a member's `git.branches` and the check before a build or
  FetchGitFile count the trusted ones only, so a lying agent cannot refuse
  members a public host such as github.com there; a member's source on an
  address only an agent reported fails at that node instead, which refuses
  its own addresses, with the hint to ask an admin. `public_address` is set
  by hand in Node settings (the installer leaves it empty), and the panel's
  own node connects over the Docker network (a private address, so no
  connect address), so on a default single-node install no trusted address
  is known: there a member's source on the node's public name saves and
  fails at the node with that hint, rather than at the save. A lying agent can still
  make an admin's save of a public host record it (and so send
  `allow_internal_host` for it to the project's nodes), a known trade-off:
  it takes a compromised node and DNS control at another node to use. A
  name that also resolves to another public address stays public (the node
  skips its own address and dials the other). Checked
  on save and again right before a build or FetchGitFile goes to a node
  (DNS may answer differently by then). An internal host (private,
  loopback, link-local, reserved, or a name the panel cannot resolve) works
  in a project once someone with `git.manage` saved a source with it
  there: that records (project, host) in `git_internal_hosts`, and the
  project's members may then use it too. Cloud metadata addresses never.
  On the first start of 0.2 the hosts of git sources already stored are
  recorded once (`gitInternalHostsSeededV2`), so existing LAN git servers
  and git servers on a node keep building: only hosts the panel resolves to
  internal addresses or the nodes' own then, or internal IP addresses. A
  panel whose V2 seed ran before nodes refused their own addresses
  (0.2.0-rc.1) records the hosts of its sources on the nodes' addresses
  once more (`gitInternalHostsSeededNodes`), nothing else, and logs them.
  Both seeds count the reported addresses too, but run before the nodes'
  0.2.0-rc.2 agents connect, so nodes whose stored facts have no
  `interfaceAddresses` (older agents, or facts an older panel stored
  without the field) are kept with the hosts the seed saw as public
  (`gitInternalHostsPending`): when such a node connects with an agent that
  reports them (0.2.0-rc.2 or newer, or a dev build), those hosts are
  checked again once (`recheckSeededGitHosts`) and the ones now on the
  nodes' addresses are recorded for the projects whose source from before
  the seed is still on that host, never for sources saved since; a node
  that reports no interface addresses is done without lookups, and the
  setting goes once no node or host is left. A public host is not recorded (a member's own
  name stays public-only after a rebind), and neither is a name the panel
  cannot resolve (not found, timeout, failing server: whoever controls the
  name could point it inside later); each of those is logged once with
  the `git.allowInternalHost` hint. The lookups run in the background;
  `assertGitTarget` and `git.branches` wait for them, and the setting is
  written once all are done. A panel that ran the first features-1 seed
  (`gitInternalHostsSeeded`, which recorded every host) first deletes the
  `git_internal_hosts` rows with `approved_by` null, once, logs how many,
  and drops that setting. The panel's check is not the last word, since the node
  resolves the name again: the agent checks the address of every
  connection it makes and accepts internal ones only for a host the panel
  marks with `GitSource.allow_internal_host` (exactly the hosts in
  `git_internal_hosts` for the project, plus git provider connections on
  an internal host), so
  DNS rebinding and split-horizon DNS do not reach the node's network
  either. Saving a source records a host only when the panel sees it as
  internal; for a LAN git server whose name resolves publicly at the
  panel (split horizon), a `git.manage` caller records it with
  `git.allowInternalHost {projectId, url}` (any host of a git URL, never a
  metadata address; the node's refusal message names the op).
  `git.listInternalHosts {projectId}` lists a project's hosts (who allowed
  each, `approvedBy` null for the seed's rows or a removed account, and
  `usedBy`, its sources that clone from the host: generic git and stack
  git sources by URL, GitHub sources as `github.com`, provider sources by
  their connection's host) and
  `git.removeInternalHost {projectId, host}` takes one off (NOT_FOUND when
  it is not there); both `git.manage`. A host is recorded as `urlHost` of
  the URL, lower case, with whatever a URL's host holds (`git_srv.lan`, an
  scp-style host as written, the percent-escapes of an ssh:// host);
  `InternalGitHost` (no whitespace, up to 4500 characters, which the
  longest host of a 500-character git URL fits) names any of them, and a
  URL whose host it cannot name (an empty one) is not a git URL, so every
  recorded host lists and can be taken off. A refusal an admin can lift
  (BAD_REQUEST `internalTarget` or `unresolvable` from saving a source or
  `git.branches`, never a metadata address) carries `details.host`, the
  host as it would be recorded. Only callers without `git.manage` get one:
  an admin's save records the host and an admin's `git.branches` reads it,
  and `gitProviders.connectRepo` never judges the host
  (`providerGitVerdict` decides at build time). Under such a refusal on
  the git source form the web app tells members that only an owner or
  admin can allow the host (`internalTarget`), or to check the address and
  that an owner or admin can allow a name only their network knows
  (`unresolvable`); the provider form has no such refusal. A failed
  deployment whose error is the node's or the panel's refusal for the
  source's host (git or provider) offers admins "Allow this host for
  <project>" (a confirm step, then `git.allowInternalHost`); project
  Settings > Internal git hosts lists them for admins with Remove and an
  "Allow a host" field. `git.branches` (checking access to a generic git
  URL) reads the
  repository from the panel under the same rule: public addresses, a host
  in `git_internal_hosts` for the project, or any internal host for a
  `git.manage` caller; never metadata, and the uptime "allow internal
  targets" setting plays no part. A name the panel cannot resolve is read
  by name for a `git.manage` caller (one they can save a source with) and
  refused for everyone else. FetchGitFile (compose files from git) runs only on the
  stack's own node (the one it is or will be placed on), never on another
  online node. Plain `http://` git is refused when saved (services,
  compose stacks, provider connections and Box repositories take
  `https://`, `ssh://` or `git@` only), so the panel never sets
  `GitSource.allow_plain_http`. Moving a service to another project
  (`services.moveProject`) checks its git host for the new project
  (`gitHostForMove`): an internal host, or one allowed in the old project,
  is recorded there when the caller has git.manage, and is an `access`
  blocker in `services.moveProjectImpact` (FORBIDDEN on the move) for
  anyone else, since its builds there would be refused.
- Env references (`modules/env/ops.ts` `checkEnvReferences`): a `${{svc.VAR}}`
  the caller may not read (env.view on the target, databases.credentials for
  database credentials; addresses are fine) is refused with FORBIDDEN
  `reference` on every path that writes a .env: `env.set`, compose
  preview/create/update (each member's `environment:`, the stack's own
  members count as the writer's) and `templates.create` (the template's own
  services count). A push to a stack's repo has no person to check, so it
  may not add references outside the stack other than addresses
  (`compose/references.ts` `assertPushReferences`).
- A pasted compose file holds its members' `environment:` values, so
  `compose.get` returns it (`source.yaml`) only to callers with env.view on
  the stack and every member; anyone else gets an empty yaml with
  `fileHidden: true`, the same rule env.get applies to the values.
- Audit events that are not ops: `writeAuditEvent` (`ops/audit.ts`) records
  `mcp.authorizeClient` (the person, with `decision` and `access`) and
  `hostShell.close` (the person, `nodeId`, `nodeName`, `openedAt`,
  `durationSeconds`, `reason`, with the duration in `durationMs`; the open is
  the `hostShell.open` op entry). Open host shells are rows in
  `host_shell_sessions` (their `last_seen_at` moves with the 30 s check), so
  the next panel start writes the close of those a restart or crash ended,
  with reason `the panel restarted`, `lastSeenAt` and the duration up to it. Anonymous
  client registration only goes to the panel log; `/oauth/register` is
  rate limited per address (strict class; an IPv6 /64 counts as one), clients nobody authorized are
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
  the panel stores it once), and `cron_failed` shows that line. Cron reads
  are `services.view` (`cron.list`, `cron.runs`), except a run's output
  (`cron.run`), which is a log and needs `logs.view` like `logs.search`; a
  grant or key that still lists the old one-op action `services.logs`
  keeps an inert entry. Alert sizes use the web app's units (binary steps,
  "3 GB").
- Bodies read before authentication are capped while streaming: op JSON
  bodies at 1 MiB (`defaultOpBodyBytes`), or the op's own `maxBodyBytes` (at
  most 4 MiB, `maxOpBodyBytes`; `files.write` 4 MiB, `compose.preview`,
  `compose.create`, `compose.update`, `maintenance.set` and
  `maintenance.setGlobal` 2 MiB), read by `readBodyText` in
  `@seylo/ops/elysia`; all body reads in flight share a budget of 64 MiB of
  buffered bytes (`bodyBudget`), past which a read is refused with 503
  UNAVAILABLE and `retry-after: 5`. The GitHub webhook counts unverified
  deliveries per sending address: each takes a token before its body is
  read or hashed and gives it back once the signature verifies on a body
  not seen before (and on a 503 busy), so only bodies being read, refused
  ones (bad signature, too large, replay) and repeats (the same delivery
  id and body again, pings) count, 60 then one a second (429). GitHub
  sends every delivery from a few addresses and does not retry, so its
  new signed deliveries never use the bucket up. Senders inside GitHub's
  hook ranges (the `hooks` list of api.github.com/meta, hardcoded in
  `modules/github/hook-addresses.ts`) take no token at all: every GitHub
  user's webhooks come from there, so a webhook with the wrong secret
  pointed at the panel must not get the App's deliveries refused unread;
  they are always read and verified (5 MiB cap, shared body budget), and
  a refused one's row names the GitHub hook that sent it. The route takes
  5 MiB (after answering 404 without an App), git
  provider webhooks at 5 MiB (after answering 404 for an unknown hook id),
  deploy trigger URL bodies at 5 MiB and the public OAuth endpoints
  (`/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`)
  at 64 KiB (`oauthBodyBytes`), all through `readBodyText`. The
  webhook needs `X-GitHub-Delivery`, records at most 20 rejected deliveries
  an hour, and answers `duplicate` for a signed body already handled under
  another delivery id within 3 days (in memory). The App's hook is created
  active (pointing at the IP:port address before a domain exists) and
  `syncWebhookConfig` moves it to the panel domain with the panel's secret
  when the domain changes. Deploy trigger URLs allow 10 calls then one per
  6 s per trigger; a call while a deploy from a trigger URL (`trigger:
  webhook`) has not started joins it (a newer `?commit=` replaces its
  commit, and its log says so). Any other queued deployment (a node move
  copying volumes, a project move's switch, a rollback, a manual or
  template deploy) ships what it was made for, so the call queues its own
  deploy behind it, like push deploys (`queuePushDeploy`).
- Registry GC: every successful deploy enqueues `deployments.registryGc`; a daily
  `deployments.registryGcSweep` retries services whose old images are still in
  the registry.
- Template logos: a built-in template may ship its app's logo as
  `templates/<slug>/logo.svg`, else `logo.webp` or `logo.png`
  (`catalog.ts` `logoFiles`, the first one found); `logoUrl` is then
  `/api/templates/<slug>/<that file>` (public, `nosniff`, sandbox CSP, one
  day of cache), and null for templates without one and every custom
  template (the web shows the letter tile, as it does when an image fails
  to load). The route serves only the file the template ships. The logos
  are vendored from dashboard-icons (Apache-2.0) at a pinned commit, never
  hotlinked: `templates/NOTICE` lists each file, its source and the
  trademark note, `templates/LICENSE.dashboard-icons` is the license. The
  popular images row bundles its own copies in
  `apps/web/src/components/docker-hub/logos/`. SVGs stay under 50 KB and
  rasters under 30 KB, with nothing active or remote in an SVG
  (`template-logos.test.ts`).
- First-run IP:port also opens when an app without ports gets its first port
  (`services.update`, no domain yet) and for compose members whose file
  publishes a TCP port. Exposures record `openedBy` "ai"/"mcp" from
  `OpContext.transport`.
- Load balancing: `services.setPlacements { entryNodeId }` names the node that
  balances over the others (the rest serve their own replicas); null keeps every
  node balancing its own domains' traffic. A copy on another node is reached at
  `https://<node address>:5757`, where the address is its public IPv4, else
  public IPv6, else `facts.privateIpv4` (nodes on one private network). The
  balancing node (and a node with two or more replicas of its own) splits
  each route into GET/HEAD/OPTIONS (router `...-retry`) and the other methods,
  each with a Traefik `retry` middleware last in the chain
  (`seylo-<id>-resend-idem` / `seylo-<id>-resend`, up to 4 tries, the first
  included). Every try goes through the balancer again, so it lands on the
  next copy: a copy that could not be reached (nothing was sent) is retried
  for every method, a 502-504 only for GET/HEAD/OPTIONS (up to 1 MiB of body
  is buffered). A POST that reached a copy on another node is never replayed,
  so one sent to a copy that just died there fails. With sticky sessions the
  cookie would pick the same copy on every try, so GET/HEAD/OPTIONS go
  through a Traefik `failover` service (`seylo-<id>[-pNNN]-retry`) instead
  that resends a 502-504 once to the balancing node's own copies, and the
  other methods keep the connection-error retry. Upstream transports bound
  the connect time: 2s to a container on the node, 3s to another node
  (Traefik's default is 30s, which held requests to a copy that just died
  until its crash restart). A node with no copy of the service right now
  answers 503 on its LB entry point (a service with no servers), not 404.
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
  else the panel node's private IPv4 (`nodes/join-target.ts` `panelUrl`). The
  command pipes the install host (`https://<installUrl>`) into sh, which
  serves install.sh only after checking it against the latest stable
  release's signed manifest; a release asset is never piped into sh,
  since anyone who can replace release assets without the signing key
  would get root on the nodes joined with it. A released panel adds
  `--version '<version>'` (`nodes/join-command.ts`), so the installer
  takes the agent from that release's signed manifest and the node gets
  the panel's version; builds without a release (dev, snapshots, `git
  describe`) leave it out and install the latest stable release.
  `publicIpv4`/`publicIpv6` hold the facts' own public addresses first and
  the public address the agent connected from only when the facts have
  none. A resume or re-join without facts (`seylo set-panel`'s check;
  every agent connect sends them) leaves `facts`, `publicIpv4` and
  `publicIpv6` as they are, since 0.2.12 (before, it wiped the facts and
  replaced the addresses until the agent connected again); a new node
  without facts gets the connect address. That connect address is also kept on its own, per node, in the
  `nodeConnectAddresses` setting (`agent-hub/handshake.ts`, every
  handshake; dropped when the node connects from a private address or is
  removed), since an agent cannot make it up (git addresses count it as a
  trusted node address).
- Node locations (`nodes/location.ts`): a node whose `location` is empty,
  never saved (`location_source` null) and never answered for
  (`location_looked_up_at` null) is looked up once by its public IP: the
  first of `publicIpv4`, `publicIpv6` and an IP-literal `publicAddress`
  that `blockedReason` calls public (private, reserved and host names never
  leave the panel). The panel asks `config.geoUrl` (`SEYLO_GEO_URL`,
  default `https://api.<site host>/geo`, derived like the telemetry URL)
  `?ip=<address>` with a 5 s timeout, in the background, when a node
  connects (`onConnection`), at panel start for every such node (also ones
  that joined before), after `nodes.updateSettings` changes
  `publicAddress`, and after the setup link seeds the panel node's address.
  The join never waits for it and nothing in it fails the join. A 200 with
  a JSON object (at most 4 KB) is stored as "City, Country" or the country
  alone (`locationLabel`, at most 80 characters, nothing without a country)
  with `location_source` "detected"; that answer or a 400 sets
  `location_looked_up_at`, so the node is never asked about again; any
  other status or body, a timeout or a network error records nothing, and
  the node is asked again only after the panel restarts (one try per node
  per process). The write is conditional on the
  location still being empty and unsaved, so an owner's value always
  wins. `nodes.updateSettings` with `location` present (any value, the
  detected one unchanged, or null/empty) sets `location_source` "manual",
  and a manual location is never filled in again. Nothing is asked while
  `config.telemetryOffBy` is set (`SEYLO_TELEMETRY=off`, `DO_NOT_TRACK=1`)
  or after the installer's `--no-telemetry` (`offAtInstall`, until the
  owner changes telemetry): the lookup sends the node's address to the
  site API like reports do. The stored switch alone does not stop it,
  since panels from before 0.2.4 have reports off by default. The
  `Node` output carries `locationSource` ("detected" | "manual", absent
  while null); the web app marks a detected location in the Location field
  (Detected chip, "Geolocation by DB-IP" linking to db-ip.com, as DB-IP's
  CC BY 4.0 license asks) until the form is saved, and the node list shows
  it with a tooltip and DB-IP's credit under the list. Panel tests never
  reach the network: `test/helpers.ts` sets `setGeoFetch` to a refusing
  fetch.
- Deployments keep the env they started with (`deployments.env_sealed`,
  sealed JSON): an app's desired spec uses its target deployment's env, so a
  saved but undeployed env change, or a failed deploy, never reaches the
  running version. Databases and Boxes (no deployment) get the current env.
- PORT (0.2.2, `env/desired.ts` `withPortEnv`): an app built from a
  repository (a `github`, `provider` or `git` source; not a compose member,
  not a cron service) with a port gets `PORT=<its first port>` in the env
  its deploy starts with, which the desired-state compile hands its
  containers, unless that env already has `PORT` (the service's own `.env`
  or the project's shared variables win). Railpack and Nixpacks start
  commands and most frameworks listen on `$PORT`, so the app listens where
  domains and health checks look. It is part of the deployment's env
  snapshot (like every env change, it applies on the next deploy), so a
  panel update never recreates a running app for it. Images, inline
  Dockerfiles and uploads get none. Only services created from 0.2.2 on get
  it (`spec.portEnv`, which `insertService` sets; a clone or preview keeps
  its source's): rows an older panel wrote read false, so an app deployed
  before keeps the env it had, whatever its image's own `ENV PORT` points
  at. The New app dialog's Set up later sends no port (it shows no Port
  field), so an empty app opens no first-run IP:port access.
- Agent versions: the hello and `NodeFacts.agent_version` carry the bare
  version ("0.1.1"); `parseVersion` also accepts the older
  "0.1.0 (commit ..., built ...)". An update run's agent step finishes by
  version when the node already runs it, at once when UpdateAgent answers
  ALREADY_EXISTS, gets UpdateAgent again while the node answers busy
  (ABORTED, see Updates), and is skipped with the agent's message when an
  automatic update waits (FAILED_PRECONDITION with details `backoff`; on a
  catch-up step also `retry` held or waiting, see Updates).

### Not built yet

Every item is a clear error or a placeholder, never a silent no-op. Go
stubs: `grep -rn 'stub.NotImplemented' go/internal`.

| What | Where it shows |
|---|---|
| `seylo panel start` and `seylo panel logs` on a node whose panel is not a managed service | NOT_IMPLEMENTED from `agent.PanelControl` only when nothing set it (`wire_node.go` sets it) |
| Panel TLS for agents is built: the installer (`--agent-tls-port`, default 3443, 0 = off) and `seylo panel bootstrap` set `SEYLO_AGENT_TLS_PORT`, publish it and open it in ufw/firewalld; the panel serves the agent endpoint there with a self-signed key from the data dir (`agent-tls.key`/`.crt`, made once) and join commands for a panel without a domain use `https://<address>:<port>` with `--pin sha256:<SPKI>`. Agents (and the installer) refuse a plain `http://`/`ws://` join to another host unless `--insecure` (config `insecure_transport`), which the join command carries only when the panel has no TLS port (`insecureTransport: true`, the card warns). Nodes that joined over the TLS port (or a domain) move to the panel domain by themselves once it is live (Protocol section). Not built: moving a node that joined over plain HTTP, to the TLS port or to the domain: a plain-HTTP session cannot prove the address it names comes from the panel, so the agent ignores it (logged once per start) | Nodes joined over plain HTTP keep working on their address and log a warning on every connect; join them again with the https:// command from the Add node card (`seylo join --force`) |
| An admin opt-in for plain-HTTP git servers: `GitSource.allow_plain_http` exists, but the panel stores no `http://` git source, so it never sets it | Saving an `http://` git URL is BAD_REQUEST; 0.2 agents refuse `http://` without the flag |
| Signed backups against real providers: presigned PUT/UploadPart/GET/DELETE and the panel's own multipart and list/delete steps match minio-go's signer (vectors in `apps/panel/test/fixtures/s3-presign-vectors.json`) and Bun's, and ran against fake buckets; not yet against AWS S3, R2 or MinIO through a real panel and agent. The multipart steps and retention need the panel to reach the bucket (as the connection test already does) | Unit and fake-bucket tests |
| `UpdateDocker` (Docker updates from the panel) ran against scripted apt/dnf output only. Panel self-update, node updates through an update run (panel step first, then one agent step per node) and the broken-image rollback ran in `make e2e` (RESULTS.md checks 1, 2, 22), and so did the update from the 0.1.1 release (built from its tag) to this build with real rows (check 38), against a local release mirror with a test key, not a real GitHub release | Unit tests only for Docker updates |
| Database TLS: Mongo, the Redis-like engines and ClickHouse's native port get TLS from the agent's portgate (VM-tested with redis-cli/valkey-cli `--tls`, mongosh `tls=true` against MongoDB 7.0 and 9.0, and clickhouse-client `--secure` against real containers; plain clients get nothing), but not through a real panel yet; MariaDB keeps its own generated certificate; the ACME certificate for `tls_hostname` ran with Pebble, not Let's Encrypt. The self-signed fallback (0.2.12) was checked with OpenSSL 3 `s_client` against Postgres and MySQL in the VM, and with Bun's BoringSSL (`TestFallbackWithBun`: "self-signed certificate" instead of "unable to verify the first certificate", trusted by its file, no certificate made with its key for another name or an IP) against a local Go server; Node 24, OpenSSL 3.6/4.1 strict, Python 3.15, LibreSSL, rustls 0.23 and node-postgres' connection-string options (`uselibpqcompat=true&sslmode=verify-ca&sslrootcert=`) were checked by hand against a local server, not in a test, and no real node-postgres or Rust app ran against an exposed database. ClickHouse's HTTP port (8123) is never exposed: only the native port is, and the HTTP interface is internal (`INTERNAL_HTTP_URL`) | MariaDB clients see a self-signed certificate; HTTP clients of ClickHouse reach it from the same node only |
| Exposed databases with their own user (0.2.9): before, they had a separate TLS-only user (e2e checks 10 and 37 ran that through the real panel for Postgres, Valkey and ClickHouse). Now the port is the database's own login and the portgate keeps Postgres, MySQL and MariaDB TLS only (VM-tested with real psql, mysql and mariadb clients); e2e checks 10 and 37 were changed for it (own user, the gate's message for `sslmode=disable`, an old `external` role losing LOGIN) but did not run in 0.2.9. Retiring the old exposed user is VM-tested per engine, not through a real panel upgrade. A user the owner created by hand named like the old exposed user (`external`) in a database from before 0.2.9 is locked too. The panel holds the retirement while any service's live or target deployment env carries the old user's password (services that used `EXPOSED_URL` before the update), a stopped one too (it can start again with that env), so a service nobody redeploys keeps the old user working; clients outside the panel lose it at once. A held retirement is sent once released: when a deployment goes live or a service is deleted, in any project, else within a minute. MariaDB 10.11 cannot be exposed (no TLS), and an exposure from before 0.2.9 reads as closed with its port row left until it is turned off by the API. MySQL/MariaDB/Mongo/Redis exposure is VM-tested on the agent side only | Unit and VM package tests, browser tests |
| The engines added in 0.2 ran through the agent's VM package tests (create, client, web UI, exposure, backup and restore through MinIO; every offered version), the panel's unit tests and Playwright; Valkey 9.1, ClickHouse 26.8 and Postgres 18 with pgvector also ran through `make e2e` (check 37: created by the panel, an app reaching them by references, the database shells, TLS exposure, backups to MinIO and restores). KeyDB and Dragonfly did not run through a real panel | Unit, VM package, browser and e2e tests |
| Engine changes in place (`databases.setVersion`, 0.2.9; any image since 0.2.11): a Postgres database cannot switch to or from pgvector (the pgvector images are Debian, the plain ones Alpine: a different collation library under the same data; another repository is refused outright), and a rollback never goes to an earlier deployment's image. Since 0.2.11 everything else the rules refused before is a risk the caller accepts (`acceptRisk`, "I understand" on the Version card), and that can go wrong: an older version or release than what runs may not open the data files a newer one wrote (MongoDB 8.0 refuses 9.0 data whose featureCompatibilityVersion is 9.0 and exits with code 62); a Postgres major does not open another major's files (no pg_upgrade) and will not start; a skipped MongoDB, MariaDB or MySQL line, or a line outside the catalog, is not tested by Seylo, and MongoDB gets no featureCompatibilityVersion step then, so a MongoDB that does not support the data's compatibility version refuses it; a floating tag (latest, 8.2) can pull another release on any later deploy, and neither it nor a digest shows which release runs, so the rules cannot judge the next change; another Postgres base system (another C library) can sort text in another order under the same indexes, which then need REINDEX, and that one starts healthy, so nothing catches it; a Postgres image that looks for its data in another folder of the volume starts healthy on an empty database (VM-tested: an 18 database, volume at `/var/lib/postgresql`, set to 17 starts empty in the anonymous volume of 17's `VOLUME /var/lib/postgresql/data`, gone with the container; a database made from a 17 image whose tag names no release kept its data there and lost it on the next recreate), so the panel sets `PGDATA` (`modules/databases/pgdata.ts`): before a Postgres move to another line (or from or to a tag without a release) on a volume at `/var/lib/postgresql` it pins `PGDATA` in the database's own variables to the folder of the cluster that runs (`/var/lib/postgresql/<major>/docker`, else as the running container says), and `databases.create` sets `PGDATA=/var/lib/postgresql/docker` for an image whose tag names no release; then 17 refuses the 18 files and 18 the 17 ones (VM-tested, `TestITPostgresOtherMajorKeepsData`), and a volume at `/var/lib/postgresql/data` needs no pin (18 refuses a volume at that old folder, VM-tested). What protects the data: the recreate rollback (a new version that does not become healthy within the deploy's 300 s health timeout brings the old container back on the same volume, VM-tested for a MongoDB 9.0 database set to the 8.0 image and the Postgres moves above), and the backup step (a successful backup from the last 24 hours, or `confirmNoBackup`) for every change but a newer patch of the line that runs. MongoDB stays readable by the old version after a catalog upgrade (its featureCompatibilityVersion is not raised by the upgrade), but MySQL and MariaDB may already have upgraded their files, and the old version can refuse them: hence the backup step. Every in-place step the rules allow ran in the VM on the catalog's images, as reconcile recreate deploys on the same data volume with the panel's environment and commands (`go/internal/reconcile/database_version_it_test.go`; MongoDB and MariaDB 10.11 to 11.4 since 0.2.9, the rest since 0.2.11), and kept the data: MongoDB 7.0 to 8.0 to 9.0, MariaDB 10.11 to 11.4 to 11.8 (system tables upgraded on each start), MySQL 8.0 to 8.4 (the server log says the upgrade completed; a table, its view and procedure, and the root and app logins over TCP work on 8.4; an account made with mysql_native_password, which the panel's check finds on 8.0 with root or the app user as the admin, cannot sign in to 8.4 until it runs with `--mysql-native-password=ON`, straight from 8.0 or by a redeploy, and then can: `databases.setVersion` refuses the upgrade while such accounts exist unless `keepNativePassword`), Redis 7.4 to 8.2 and Valkey 8.1 to 9.0 to 9.1 and 8.1 straight to 9.1 (the panel's `--appendonly yes` command: an RDB base file and an incremental AOF file are both read, TTLs kept), ClickHouse 26.3 to 26.8 (a MergeTree table in two parts that 26.8 merges, and a user made with SQL), and a Postgres 17 patch from the catalog's 17.6-alpine to 17.11-alpine, a newer Alpine (amcheck finds the text index whole). Of the risks (0.2.11, `TestITMongoAnyImage`): MongoDB 8.0 to `mongo:8.2.12`, a line outside the catalog, kept the data with no compatibility step (8.2 opens data whose featureCompatibilityVersion is 8.0), and a 9.0 database set to the 8.0 image failed its deploy, and the 9.0 container came back with the data. e2e check 43 covers MongoDB 7.0 to 8.0 through a real panel (written, not yet run); the other steps did not run through a real panel, and other images are tested in the panel's rules only | Postgres: create a new database and restore a dump into it. A failed MySQL/MariaDB upgrade: restore the backup into a new database |
| Dragonfly has no append-only file: it runs with `--dbfilename dump --df_snapshot_format=false --snapshot_cron "*/5 * * * *"`, so a crash loses up to five minutes of writes (a stop saves first). Only Dragonfly 2.0 is offered | Behaviour as described |
| KeyDB publishes no multi-arch version tag and has had no release since 6.3.4 (2023): it is pinned by the digest of its `latest` index, which is `x86_64_v6.3.4` + `arm64_v6.3.4`. It gets no security fixes: the 2025 Redis Lua scripting advisories (CVE-2025-49844 use-after-free RCE, CVE-2025-46817, CVE-2025-46818, CVE-2025-46819; fixed in Redis 6.2.20 and Valkey) are unpatched in it, and its one `default` user may run scripts. The New database form, `databases.engines` (`notice`) and the op descriptions say so and point to Valkey; `databases.setExposure` refuses KeyDB without `allowedCidrs` (`exposure.needsAllowedCidrs`, reason `allowlistRequired`). Lua stays on (renaming EVAL would break clients such as BullMQ) | One KeyDB version, unmaintained, exposed only to listed addresses |
| ClickHouse restores replace the databases the backup holds (like `pg_dumpall --clean`), renamed aside until `RESTORE` succeeds: while it runs the disk holds both copies, and a database `RENAME DATABASE` cannot move (it needs the default Atomic engine) stops the restore before anything changed. If putting the copies back fails too (the server went down), they stay as `<name>__seylo_pre_restore_<time>` and the restore error says so. Users and grants are not restored over existing ones. ClickHouse and Dragonfly take a new admin password by restarting with the new environment (`passwordChange: "restart"`), not live | Behaviour as described |
| Boxes and backup `stop_service` against the real runtime: sleep/wake ran with a fake `SetSleeping`/`Resolve` | Unit tests only |
| Runtime gaps: resource changes roll a new container instead of `docker update`; the portgate's `Resolve` may still pick an unhealthy replica (routes skip it); a brand slug with a dash would nest `<slug>.slice` under the systemd cgroup driver (`seylo` has none). The systemd driver path ran in a VM with `native.cgroupdriver=systemd` (docker, reconcile, wings incl. games-first CPU through systemctl, proxy, agent, jobrun, metrics, nodecheck packages) | Behaviour as described |
| Observe Docker access goes through `console/dockerapi`, not `d.Docker`: kept on purpose. It needs raw multiplexed log frames with `until` (partial lines, the restart cursor), separate stdout/stderr for non-TTY exec, exec inspect for the process sweep, destroy events and one-shot stats, none of which `docker.Engine` exposes; moving it would mean five new Engine methods and re-verifying logs capture, console, shell and metrics for no user-visible change. It only reads, attaches and execs | Two Docker clients in the agent (both scoped to our containers) |
| Networking gaps: UDP public ports (portgate relays TCP; `portgate.ErrUDP`), the real next-to-Wings test (the Wings fork change is not made yet; the shared mode and its LB Traefik ran with a stand-in Traefik in the VM), ACME failures are read from the last 24 h of Traefik's log only. The `network.firewall` check names closed portgate ports but not 5757 on nodes with load-balanced services (it would need the other nodes' addresses in the agent). LB certificate revocation holds only on agents with `lb.tls.peers.v1`, only once they got their settings (a node cut off from the panel keeps its last list), and only for new connections (Traefik keeps a TLS connection it already accepted across reloads); while the panel lists a `legacy` peer (a node holding a certificate from before 0.2 that has not connected since, at most 30 days) every certificate of the LB CA is accepted; an older agent is reached by the shared name, which any node's certificate carries; a new LB CA comes only with `seylo panel rotate-key --new-panel-identity` | Logged errors / reopen links |
| GitHub: sign-in, linking and the repo-access device flow use the GitHub OAuth App client id in `brand.oauthClientId` (`SEYLO_GITHUB_CLIENT_ID` overrides it for sign-in and linking); they, the App manifest flow, installations, webhooks and polling, and the connected account (the token check, its repository list, repository webhooks and polling, 0.2.2) are tested only against a mocked GitHub (`test/playwright/run.sh` gives its panel a placeholder id, so the browser tests never call github.com); a public git repo build was not run | Tested against mocks; with a placeholder id sign-in and linking answer UNAVAILABLE (`githubAvailable: false`) and the device flow NOT_IMPLEMENTED |
| Moving compose stacks or their members (compose files from any git host are read through the agent's `FetchGitFile`), to another node or another project; cloning a whole stack (members clone one by one, as standalone apps) | CONFLICT `reason: compose` |
| Service export and import gaps: a database is stopped for its whole download (no staged copy on the panel's disk, no engine dump, no resumable download), compose stacks and their members and several services in one file, the CLI (`seylo export`, `seylo import`, `seylo export decrypt`; until then the API takes what `unzip -p` prints and `curl -T` sends), encrypting the uploaded archive and volume data, falling back to the branch head when the exported commit is gone, a part's own checksum (only the whole entry is hashed), undoing what an import wrote outside the service when it is discarded (shared variables added or overwritten, a credential made from the file). e2e check 42 (settings, env, cron job, a volume's file, a Postgres's rows and basic auth from B to C, a flipped byte and a wrong passphrase refused) passed on the VMs on 2026-11-11. The zip was checked with `unzip -t` and Python's `zipfile`, not with Finder, Archive Utility, `ditto` or Windows Explorer | Compose is CONFLICT `reason: compose`, a first deploy of a commit that is gone fails like any deploy, a database stays down while its file downloads (5 minutes without a read or 12 hours end it) |
| Clone and project move gaps: a service with open PR previews cannot change project (close them first); app volume data copied without stopping the source may be inconsistent (the dialog stops it by default); a compose member cloned standalone keeps references to the other members' compose aliases, which only resolve in the same project; literal host names are matched by service name, not by compose aliases; a project move's route switch through a real Traefik is unit-tested only (the VM tests check `Resolve` and Docker DNS, not an e2e curl through Traefik during the switch) | CONFLICT `reason: previews`; the dialog lists references |
| `BuildSource.image` (mirroring private images into the panel registry) is not used | Each node pulls private images itself with `ImageRef.auth` |
| The AI assistant against the real Anthropic API and real MCP hosts (tested with a scripted client and `app.handle`; the chat bubble and the Assistant page against the demo world's scripted replies only) | Works as tested |
| Real-agent checks not done yet: `FetchGitFile` through the panel (compose from a git host; tested against a local git http-backend), backups to a real cloud bucket (MinIO only), Mongo/Redis/MySQL databases, Boxes. Load balancing has no active health check of copies: a failed request is sent to the next copy per request (a copy that cannot be reached: every method; a 502-504: GET/HEAD/OPTIONS only, so a POST to a copy on another node that just died fails). With sticky sessions a client pinned to a copy on the balancing node that died gets errors until that copy is back (about 5s with the crash policy) | Covered by unit, fake-agent and VM package tests |
| CLI sign-in: `cliLogin.approve` keeps `readOnly` optional (the web page always sends it; an API client that leaves it out gets full access, as before; the lifetime defaults to 7 days like the page). `viewerAddress`, the audit details, the per-computer limit and the `security_change` alert on every approval are built | API clients choose their own scope |
| Removing or changing the panel domain while nodes dial it: `settings.updateGeneral { domain: null }` (or a new domain) drops the old domain's route at once. Nodes that joined over the agents' TLS port keep it as a standing pinned fallback and come back through it after 5 minutes (then move to a new domain by themselves); a node that joined over the domain (every node added once a domain is set: Add node prints the unpinned domain) or whose address before the move was an unpinned https:// address (another domain) has no fallback and cannot reach the panel until it rejoins (`seylo join --force`, with a new token) or, since 0.2.12, is pointed at the agents' port with `sudo seylo set-panel '<IP URL>' --pin '<pin>'` (no token). The panel cannot tell these apart, so since 0.2.1 the change is refused (CONFLICT `nodesOnDomain`, `details.nodeIds`) while enabled nodes dial `https://<domain>` (`settings.general.domainNodes`, from `nodeDialedUrls`), unless the call passes `acknowledgeNodesOffline: true`; Settings > General and Lock to Tailscale name the nodes and ask first, and Lock to Tailscale then leaves the agents' port open. Plain-HTTP nodes never move, so this does not reach them | Acknowledged nodes go offline after a domain removal or change; the node offline alert fires |
| The panel node's own agent dialing a public address (joined again with an Add node command instead of the installer's `http://127.0.0.1:<port>`): closing IP access would cut it off (Docker's loopback publish does not take a dial to the server's own public address), and with the panel node offline nothing reopens it from Settings or `seylo panel ip-access on` | Since 0.2.1 closing is refused (`panelNodeNotLoopback`, with the loopback join command) while it dials plain `http://` that is not loopback, and closing the agents' port while it dials anything but loopback or `https://<domain>`; `decidePanelIpAccess` keeps them open in that case too |
| The panel on a real tailnet (0.2.1): the agent's tailnet area ran against an httptest LocalAPI with recorded tailscaled 1.104.x answers, the panel's tailnet listener and ops in the panel's tests, the cards in Playwright. Not run yet: HTTPS Serve (the certificate, the first-load delay, the `__Host-` cookie, no HSTS on the ts.net name), a real login.tailscale.com sign-in link and tailnet name, key expiry and the Disable key expiry link, the grant snippet in the real policy editor, Serve with `--netfilter-mode=off`. Whether Docker older than 28 lets the local network reach ports published on 127.0.0.1 (route_localnet) is from Docker's docs, not tested | The owner's check on a real Tailscale account before the release; the card and the Docker Engine check warn below 28 |
| Not in 0.2.1: nodes over the tailnet (a Serve TCP forward of the agents' port, "Connect over Tailscale" in Add node), apps on the tailnet, passkeys on the ts.net name, signing in with the Tailscale identity, an installer `--tailscale` flag, a node-side veto on builds (`no_builds`) | Nodes connect over the domain or the agents' port; passkeys need the panel domain; join commands made on the tailnet URL use the domain or the agents' port |
| Lockouts the panel cannot see: a tailnet access rule that shuts out the owner's devices, or the owner's device removed from the tailnet, while the server stays Running | Only the SSH tunnel and `seylo panel ip-access on` / `seylo panel tailscale off` help; the docs warn against limiting SSH to `tailscale0` |
| Re-auth scope: demotions and grants that only take actions away are not gated, and API keys never are (admin keys may invite, widen grants, promote and create join tokens, since every key was made under a fresh sign-in). Passkey and GitHub re-auth ran in Playwright against a stubbed browser passkey prompt and mocked GitHub answers (the test panel has no domain or client id); the real passkey assertion is checked by the panel's own tests only | Behaviour as described |
| Disk alert threshold: the agent's DISK_LOW line is fixed at 85% (data dir and Docker root, every 10 minutes); the panel has no setting for it (the scheduled cleanup's own disk line is a setting) | Fixed threshold |
| Scheduled cleanup: agents before 0.2 ignore `NodeSettings.cleanup` (the Cleanup view says so by the agent version); runs missed while the agent was down are not caught up; the disk trigger's pacing (an hour, 6 hours) is fixed | Behaviour as described |
| Host shells: the shell runs as the agent's user in the agent's cgroup, so an agent restart or update ends it; processes started in their own session (`setsid`, many daemons) survive closing it, like an SSH logout; there is no session recording (the audit log has who, the node, when and how long); a panel restart ends every open one (the next start writes its close with reason `the panel restarted` and the duration up to the last 30 s check, so the real end can be up to 30 s later) | Behaviour as described |
| Screens: no screen to add or edit registry logins (`registries.create`, `registries.update`, `registries.delete`, `registries.test` through the API; the Source tab and the Docker Hub image dialog pick stored ones), none for a compose stack's `${VAR}` values (`env.set` on the stack). Git credentials have screens since 0.2.2 (Settings > Git providers, and Add credential on a git source) | API only |
| Docker Hub browsing: Docker Hub only (no GHCR, Quay or other registries' catalogs); inspect reads one platform's config (amd64 or arm64; other CPUs are listed only); search shows no publisher logos (letter tiles instead; only the popular images row has app logos, bundled with the web app) and pages stop at 20; private repositories are browsed only by people with `registries.manage`; the popular images row is a list in code (`components/docker-hub/popular.ts`). Nodes pull an image anonymously (their own address's limit) unless the form picked a Docker Hub login; that login is added with `registries.create` (no Settings screen yet, see Screens) | Behaviour as described |
| Git providers: the GitLab and Bitbucket clients are tested against recorded answers in `apps/panel/test/fixtures/git-providers/` written from the providers' documented responses, not captured from live accounts; no real gitlab.com, self-managed GitLab or Bitbucket Cloud run yet. Gitea ran for real (`scripts/dev/it-gitea.sh`, Gitea 1.24.6). Not built: compose stacks from a provider repository (`compose.ComposeSource` has GitHub and git URLs only), GitLab system hooks (one hook per service instead), Bitbucket Atlassian API tokens (workspace or repository access tokens and app passwords only), provider servers with self-signed certificates (the panel and git use the system roots), "Retry failed" for provider deliveries (GitHub only), watch paths for previews (every push to an open request deploys its preview), a watch paths editor on a stack's Source tab (`services.setWatchPaths` works for stacks), conditional requests in provider branch polling (GitHub's poller sends ETags; providers are read every 5 minutes at most while their webhook exists), "superseded" statuses for GitHub push deploys (GitHub pushes join a queued deploy too, but the panel posts no GitHub commit statuses) | GitLab/Bitbucket: fixture tests only; the rest as described |
| Panel backups: no built-in backup schedule for `panel.db`/`master.key` (update snapshots only). Moving the panel to another server is built since 0.2.8 (Panel move, under Releases and updates). A leaked copy is handled on the panel's node by `sudo seylo panel rotate-key --new-panel-identity` (new `master.key`, every secret sealed again, new edge ticket key, LB CA and agents' TLS key, so every node is joined again with the printed `seylo join --force` command and its new pin; recovery codes must be made again) or `--keep-panel-identity` when only `master.key` leaked, not by a screen | Docs say to copy `/var/lib/seylo/panel/` |
| LB mutual TLS across agent versions: an agent from before `NodeSettings.lb_tls` support ignores it, presents no client certificate, and nodes that enforce it refuse its forwarded traffic (GET/HEAD/OPTIONS fall back to the balancing node's own copies) until it updates. Agents from before `lb.tls.peers` keep working with upgraded ones: every certificate carries the shared name and chains to the LB CA through its issuer, upgraded nodes reach them by the shared name and accept their certificate when the panel lists them | During an update run only |

### Verification

Besides the unit tests, the Go packages that drive Docker have integration
tests that run in a Linux VM (`scripts/dev/vm-gotest.sh`), git providers
run against a real Gitea in that VM (`scripts/dev/it-gitea.sh`: the panel
test `gitea.integration.test.ts` and the agent's `TestITGiteaPrivateClone`), the web app has
Playwright suites (`test/playwright/run.sh`), and `make e2e` runs the real
installer on three fresh VMs and 43 end-to-end checks against test-signed
releases from a local mirror (`test/e2e-colima/README.md`; the evidence of
the latest run is in `test/e2e-colima/RESULTS.md`). Every op contract has a
handler.

The first-run port's automatic close (24 h after the domain is live) is
checked by moving the stored `closeAt` into the past and waiting for the
panel's own sweep. Check 31 (panel domain, runs last and undoes itself)
gives the panel an sslip.io name of A with a Pebble certificate: HTTPS, HSTS
only on HTTPS, a Secure HttpOnly `__Host-` session cookie with no Domain from
a sign-in over HTTPS that signs nobody in without its session key,
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
its tag, to this build with real rows (every migration since applies, as
many as the journal has; rows and keys survive; a cron job saved with 7
for Sunday reads 0 and runs). Check 39 covers 0.2.1's build default (a
join command made with "Build images on this node" unticked makes a node
that does not build whatever its `--can-build` says, a refused join makes
the installer exit 3, a default command makes a builder) and panel access
over the domain ("Serve on IP address" off from a domain session closes
http://<A>:<port> to the Mac, B and C while loopback, the domain and the
panel node's agent keep working; `seylo panel ip-access on`; a dead domain
reopens it and it closes again after the hour). Check 40 serves the panel on
a Headscale tailnet in HTTP mode (Serve to the panel's socket, Lock to
Tailscale from the tailnet, `tailscale down` reopening IP access, the
`seylo panel tailscale` and `ip-access` commands). Check 41 moves the
panel from A to B and back (0.2.8), check 42 exports a service with its
volume data and a Postgres and imports them on C (0.2.10), and check 43
changes a MongoDB database from 7.0 to 8.0 in place (0.2.9). Outside the
checklist, `test/e2e-colima/extra-installs.sh` installs on Debian 12 and on
Ubuntu with ufw, and `.github/workflows/install-smoke.yml` installs each published
release on GitHub's amd64 and arm64 runners (`test/install-smoke/smoke.sh`).

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
| `panel.edge-access.v1` | CheckEdgeAccess |
| `panel.backup-sign.v1` | SignBackupRequests |
| `tailnet.login.v1` (0.2.1) | TailscaleLogin, TailscaleSetDns |
| `panel.relocate.v1` (0.2.8) | StagePanelAddress, ClearPanelAddress, ImportPanelData, ExportRegistry, ImportRegistry, StartMovedPanel, AbortMovedPanel, CommitMovedPanel, RetirePanel, RemoveOldPanel |

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
| `database.exposure.v2` (0.2.9, `dbengine.ExposureCapability`, `wire_jobs.go`) | The exposed port uses the database's own user over TLS for every engine: the portgate refuses Postgres, MySQL and MariaDB clients that do not ask for TLS (`portgate.TLSCheck`), `dbtools.ExposedTLS` turns TLS on in Postgres and MySQL without a user, and the agent retires `DatabaseSpec.retired_exposed_user`. The panel sends exposure on for Postgres, MySQL and MariaDB only to agents that advertised it (`missingExposureCapability`), reads an exposure there as closed (`databases.get exposure.state` `waitingForNodeUpdate`, no exposed URL) and `databases.setExposure` refuses them elsewhere (CONFLICT `agentTooOld`): an older agent would relay them without the check, and with no user sent it skips the TLS job too. Mongo, ClickHouse and the Redis-like engines keep their exposure on older agents (TLS at the gate; no user sent, so an older agent's user job skips them) |
| `backup.signed.v1` | Backup destinations without keys (`BackupDestination.signing_id`): the agent asks `PanelService.SignBackupRequests` for each S3 step (`backup.SignedStore`). The panel sends backups and restores only to agents that advertised it |
| `panel.publish-bind.v1` (0.2.1, `reconcile.PanelPublishBindCapability`, `wire_runtime.go`) | The agent publishes the protected panel's ports on `PublicPort.bind_address` (empty = every address; only a loopback address, only on the protected panel service: `validateSpec` refuses anything else), adopts an installer-started panel container only when its actual bindings match the desired list (HostIP included; otherwise it rolls), and reports the bindings in `seylo panel status`. The panel closes IP access only on a panel node that is online and advertised it (`panelNodeState.capable`; else block `agentTooOld` and `decidePanelIpAccess` keeps it open); an older agent ignores the field and keeps every address |
| `tailnet.serve.v1` (0.2.1, `wire_tailnet.go`) | The agent reads the host's tailscaled and reports it in every NodeFacts as `tailscale` (unset = no tailscaled socket, an explicit report from this agent), and follows `NodeSettings.tailnet.panel`. Without it `tailscale.get` says `agentSupported: false` and `tailscale.setServe` refuses with `agentTooOld` |
| `routing.origin-proof.v1` (`edge.OriginCapability`, `wire_network.go`, only with the node key) | Every route file sends `GET /.well-known/<slug>-origin/<challenge>` on the route's hosts to the edge (`proxy` `addOrigin`), which answers with the node key's signature (`edge/origin.go`). The panel's origin check (`modules/domains/origin.ts`) asks only when a node of the service advertised it, and calls an answer without the proof "elsewhere" only when every node of the service did and reported the domain's route; otherwise "unknown" |
| `node.docker-check.v1` (0.2.5, `update.DockerCheckCapability`, `wire_node.go`) | The agent looks for a newer Docker Engine by itself and reports it in every NodeFacts as `docker_update` (see "Releases and updates", Docker version check). The panel keeps the newest report per node and shows it as the node's `docker` only for agents that advertised it; an older agent's node has no `docker`, so the Machine card and Update Docker stay as before |
| `volume.import-limits.v1` (0.2.10, `volumes.ImportLimitsCapability`, `wire_runtime.go`) | `ImportVolumeRequest.max_bytes`, `max_entries` and `sha256` hold: at most that many file bytes and archive headers, the whole stream hashes to `sha256`, and the data folder keeps `max_bytes` plus a floor (a tenth of the disk, 1 to 5 GiB) free (RESOURCE_EXHAUSTED `reason: noSpace`, `tooLarge`, `tooMany`; INVALID_ARGUMENT `reason: checksum`); with any limit set, a failure after writing started empties the volume and the agent answers at once instead of draining the stream. Imports into one volume run one after another (a second one waits for the first, its cleanup included). `ExportVolumeResponse.entries` counts what an export wrote. The panel sends an uploaded export file's volume data only to an agent that advertised it (an older one would ignore the limits); moves and clones send none and work on `volume.transfer.v1` as before |
| `lb.tls.peers.v1` | The LB entry point answers `LoadBalancerTls.node_server_name` as SNI and takes `peers` (client CAs = the listed issuers, each copy on another node verified by its listed name). The panel lists a node under its own name only once its agent advertised this and it confirmed a certificate for that name `confirmGraceMs` (2 min) ago; before that, the shared `server_name` (an older agent answers 421 to its own name: Traefik's SNI check) |

## Panel access and the tailnet

Added in 0.2.1: whether the panel answers on `http://<ip>:<panel port>`
and on the agents' TLS port, and the panel on the owner's tailnet through
the owner's own tailscaled. Ops: `settings.panelAccess`,
`settings.updatePanelAccess` (`packages/ops/src/ops/settings.ts`),
`tailscale.get|setServe|signIn|setDns` (`tailscale.ts`), none offered to
models. Panel: `modules/settings/{ip-access,panel-access,private-paths,
ip-access-file,domain,ops}.ts`, `agent-hub/dialed.ts`,
`modules/tailscale/`, `http/tailnet-host.ts`, `panel.ts` (the tailnet
app), `main.ts` (its socket). Agent: `go/internal/tailnet`,
`agent/wire_tailnet.go`, `reconcile/spec.go` (`panelPublish`),
`cli/panel_ipaccess.go`, `cli/panel_tailscale.go`.

### IP access

- Settings keys (nothing secret): `panelServeOnIp` ("Serve on IP
  address", absent = true), `panelAgentPortOpen` ("Agents' port", absent =
  true), `panelIpAccessOnFailure` (`reopen` | `stayClosed`, absent =
  `reopen`), `panelAccessChoice` (`{reason, by, at}`: who set the switches
  last and why; a change that only follows them, also one applied later,
  is recorded in their name), `panelIpAccessApplied` (`{closed,
  agentPortClosed, at, reason, by, generation, from, reopenedAt,
  holdUntil}`: what the panel node was last told; absent = open, as in
  0.2.0) and `nodeDialedUrls` (by node id `{url, at}`: the base URL each
  node's agent dialed, written when a session starts from
  `hub.dialedAddress`, so it is known while the node is offline; removed
  nodes drop out on the next write).
- `applyPanelIpAccess(deps, reason, options)` is the one place that
  decides and rolls; every input change calls it: the switches, the
  domain (`updateGeneral`, and the domain job on a change of its debounced
  state), the tailnet path (`modules/tailscale/status.ts`), the panel
  node connecting and a failed roll (`watchPanelIpAccess`:
  `agents.onConnection`, `agents.onEvent("deployProgress")`),
  `ip-access-on`, and the 1-minute job `settings.applyPanelIpAccess` (the
  debounce and re-close timers). The rule (`decidePanelIpAccess`): closed =
  !serveOnIp, the panel runs as its node's protected service, the node's
  agent advertised `panel.publish-bind.v1`, the panel node's own agent
  dials no plain `http://` that is not loopback, a private path works (or
  `stayClosed` and already closed), and no enabled node dials plain
  `http://`; agentPortClosed = closed, !agentPortOpen, an agents' TLS port
  exists, every enabled node but the panel node dials `https://<domain>`,
  and the panel node dials loopback or `https://<domain>`. It fails open.
  After an automatic reopen it closes again only once a path has worked an
  hour since (`recloseAfterMs`, from `reopenedAt`; `reclosesAt` in the
  view); after a failed roll nothing changes by itself for 15 minutes
  (`holdUntil`); an offline panel node agent flips nothing. Closing waits
  for any running update run, reopening only for one whose panel step is
  pending or running or that updates Docker on the panel node.
- A change: a new panel generation (`bumpPanelGeneration`, a live
  deployment of the same image), `markDirty` for the panel node,
  `panelIpAccessApplied` saved, for automatic changes an audit row (op id
  `settings.ipAccessChanged`, actor `system`, input `{closed,
  agentPortClosed, reason, by}`; a person's change is in their op's row), a
  `security_change` alert (key `ip-access:<at>:<closed>:<agentPortClosed>`,
  link `/settings/general`; the close alert warns about Docker older than
  28) and a live invalidate of `settings.panelAccess`, `settings.general`
  and `tailscale.get`. `panelContributor` sets `bindAddress: "127.0.0.1"`
  on the panel port while closed and on the TLS port while agentPortClosed.
  An empty `PublicPort.bind_address` encodes as absent, so an open panel's
  `SpecHash` is 0.2.0's and nothing rolls on the upgrade. `actual` is
  `unknown` until the running panel generation reaches the applied one.
- Failed roll (`recordFailedRoll`): the agent puts the old container back
  when the new one fails its health check (DEPLOY_STAGE_FAILED for that
  generation); the panel records the previous state as applied, turns the
  switch of a close that failed back on (`panelAccessChoice` by `system`),
  holds 15 minutes and bumps the generation to match what runs.
- The domain as a private path (`private-paths.ts` `domainPath`): working
  once a check found it active for the current domain and it did not fail
  the 2 checks since in a row, at least 4 minutes apart (`domainWorking`);
  a changed or removed domain stops working at once. Proven by
  `ctx.origin === "https://<domain>"`, which IP:port cannot produce (the
  scheme there is always http, `http/request-origin.ts`). While IP access
  is closed or meant to be, the domain job checks every 5 minutes, active
  or not. The registry (`registerPrivatePath`) holds the domain and the
  tailnet, in that order.
- `settings.updatePanelAccess`: turning anything off, or `stayClosed`,
  checks the caller (`notBrowserSession` for API keys, MCP, the assistant
  and any transport but HTTP, then `notOwner`), then `closeBlocks` (or
  `agentPortBlocks` for `agentPortOpen: false`), then `stayClosed` needs
  `savedRecovery: true` (BAD_REQUEST, field `savedRecovery`), then
  `requireFreshSignIn` (FORBIDDEN `reason: reauth`). A refusal is CONFLICT
  with `details.reason` the first block's code and `details.nodeIds`
  comma-joined. Turning things on needs `settings.manage` over HTTP from
  anyone but MCP and the assistant (FORBIDDEN) and is always allowed. A
  turn-off past the guards drops the anti-flap wait (`closeNow`); a turn-on
  or `stayClosed` drops a failed roll's hold (`resetHold`).
  `settings.panelAccess` lists every block for this caller in `blocked` and
  `agentPortBlocked`, plus `openReason`, `oldDocker` (the panel node's
  Docker when older than 28: route_localnet may let the local network
  reach 127.0.0.1 ports; the node's Docker Engine check warns too while the
  panel is published on loopback only), `lastChange` and `recovery`
  (`ssh -L 3000:127.0.0.1:<panel port> root@<server>`,
  `sudo seylo panel ip-access on`).
- Block codes (`settings.panelAccessBlockCodes`): `notOwner`,
  `notBrowserSession`, `noPrivatePath`, `notOnPrivatePath` (the request
  came over IP:port or a path that is down), `panelNodeOffline`,
  `panelNotManaged`, `agentTooOld`, `updateRunning`, `plainHttpNodes`
  (enabled nodes on plain `http://`, online or offline, and nodes not seen
  since the update, whose address is unknown), `nodesOnAgentPort`,
  `noAgentPort`, `panelNodeNotLoopback` (with the loopback join command).
- Other CONFLICT reasons: `settings.updateGeneral` `nodesOnDomain` (field
  `acknowledgeNodesOffline`, `nodeIds`) and `stayClosed` (field `domain`:
  IP access closed in `stayClosed` mode and the domain is the only working
  path); `nodes.createJoinToken` `agentPortClosed` (the agents' port is
  closed and no domain is active) and `ipAccessClosed` (no agents' port,
  no active domain, IP access closed); `tailscale.setServe` on: one of
  `serveBlockedReasons` (`notInstalled`, `notSignedIn` (NeedsLogin or
  Stopped), `needsApproval`, `tooOld`, `magicDnsOff`, `agentTooOld`,
  `offline`, `disabledOnServer`), off: `stayClosed` when the tailnet is the
  only working path into a closed panel in `stayClosed` mode, unless
  `reopenIpAccess` (which turns Serve on IP address back on);
  `tailscale.signIn` `needsApproval`, `stopped` and `signedIn`.
- `seylo panel ip-access on` (root, on the panel's node; refused when
  `panel/panel.db` is missing) writes `<data>/panel/ip-access-on` (0600,
  owned by the panel user) and restarts the panel container like
  setup-link. The panel reads it on start and on the 1-minute job
  (`applyIpAccessFile`): both switches on, `onFailure` back to `reopen`,
  an audit row (op id `settings.ipAccessOnFromServer`, actor "the server's
  command line"), the file removed, then `applyPanelIpAccess` (the second
  restart). The command says when the agent is down, not connected or busy
  with an update, since only the agent applies the second restart.
- Join targets (`nodes/join-target.ts`): an origin that is neither an IP
  literal nor the panel domain (a `*.ts.net` name) is ignored when choosing
  the join URL. The public URL (`modules/settings/public-url.ts`) is the
  domain, else `SEYLO_PUBLIC_URL`, else the tailnet URL while IP access is
  closed and the tailnet works, else IP:port.

### The tailnet

- Agent (`tailnet.Manager`, component `tailnet`, a 30 s tick plus a wake
  on a desired-state change): reads status and prefs over the LocalAPI
  socket (5 s timeout), fills `NodeFacts.tailscale` (`TailscaleInfo`, sent
  when it changed and every 5 minutes otherwise, so `checked_at` moves),
  and keeps the one Serve entry
  `https://<dnsName>/` (port 443, or `http://` on 80 without HTTPS
  certificates) -> `unix:<data>/panel/tailnet.sock` while
  `NodeSettings.tailnet.panel` (panel node only) asks for it and
  tailscaled is Running, at least `MinVersion` (1.104.4), MagicDNS is on,
  the protected panel service is in this node's desired state and the
  socket exists. The target is always the agent's own host path, never one
  from the panel. Another handler on that host:port, or AllowFunnel on it,
  is a conflict (state CONFLICT, the owner's entry stays); 412 retries on
  the next tick; a removed entry comes back. Every 60 s it asks
  `/api/health` through the socket (`panel_answers`). `TailscaleLogin`
  (`tailnet.login.v1`): on a server never signed in, EditPrefs with only
  WantRunning and CorpDNS false first, then login-interactive, then the
  AuthURL from status for up to 15 s; with a profile it never touches
  prefs. `TailscaleSetDns` changes CorpDNS only. It never runs `tailscale
  up`, `down` or `logout`, changes routes, exit nodes or the firewall,
  reads `/var/lib/tailscale` or logs the link; `troubleshoot` redacts
  `login.tailscale.com/a/...`, `/register/<id>` and `tskey-...`.
- `no_tailnet: true` in config.yml (`seylo panel tailscale off`, which
  also removes the entry itself and restarts the agent unit; `on` undoes
  it) is the local kill switch: no entry, both RPCs PERMISSION_DENIED,
  `disabled_on_server` in the facts. `tailscale_socket` moves the socket
  (absolute paths only). `seylo panel tailscale status` reads the LocalAPI
  directly, so it works with the agent and the panel down, and prints the
  sign-in link when tailscaled waits for one.
- Panel: settings keys `tailscaleServe` ("Serve the panel on my tailnet",
  absent = false), `tailscaleServeTailnet` (`{tailnet, dnsName}`, set while
  Serve is on: Serve is pinned to that tailnet) and `tailscaleSeen` (what
  the panel node reported last plus the path's debounce: `detected, state,
  dnsName, tailnet, https, serveState, url, panelAnswers, keyExpiry,
  reported, working, workingSince, stoppedAt, downSince, checkedAt`). The
  sign-in link is never stored: memory only, 10 minutes, owner only
  (`tailscale.get` `signInUrl`, marked sensitive output), never audited.
  Every NodeFacts of the panel node from an agent with `tailnet.serve.v1`
  is an explicit report (no `tailscale` = no socket). The tailnet path
  works when Serve is wanted, tailscaled is Running, the entry is ACTIVE
  and the panel answered through it; it stops working after 5 minutes of
  reports that do not work from an online agent (`tailnetDownMs`; a
  disconnect restarts the clock, an offline agent keeps the last state),
  and at once when Serve is turned off or the report comes from another
  tailnet than `tailscaleServeTailnet` (then the desired state drops
  `tailnet.panel`, the agent removes the entry and the listener answers
  403 to everything but `/api/health`). Proven by `ctx.via === "tailnet"`.
- Alerts (`modules/tailscale/alerts.ts`, keys on existing events, only
  while Serve is wanted, link `/settings/tailscale`): `security_change`
  `tailnet-serve-on:<ms>` (names the tailnet and the login) and
  `tailnet-moved:<ms>` (another tailnet); `node_health_check_failed`
  `tailnet-key-expiry:<expiry>` (14 days ahead), `tailnet-needs-login:`,
  `tailnet-needs-approval:`, `tailnet-stopped:` (says whether IP access
  reopened), resolved when the state clears; `health_recovered`
  `tailnet-recovered:`.
- `tailscale.setServe`, `signIn` and `setDns` need the owner, from a
  browser session (FORBIDDEN otherwise, and for any transport but HTTP),
  with `requireFreshSignIn`. Serve on adds a way in only; off removes the
  entry and runs `applyPanelIpAccess` (`reopenedUrl` when that reopened IP
  access). `setDns` takes only `acceptDns: false`.

### Tailnet listener trust

- The panel always listens on `<data dir>/tailnet.sock` (host
  `<data>/panel/tailnet.sock`): a stale socket is removed at start, the new
  one is chmod 0600 and owned by the panel user inside the 0700 data dir,
  so only root (tailscaled) and the panel connect; it is stopped on
  shutdown. Toggling Serve never restarts the panel.
- `tailnetApp` is `buildApp` again over a copy of the deps with
  `proxy: trustEveryPeer` and `listener: "tailnet"`, so the `requestIP`
  call sites stay as they are: forwarded headers count from every peer on
  the socket, never on TCP. That is safe because Serve's reverse proxy
  drops any `X-Forwarded-*` and `Tailscale-User-*` the client sent and sets
  its own (X-Forwarded-For the tailnet device, X-Forwarded-Host the Host
  the browser used, X-Forwarded-Proto `https` only in HTTPS mode, absent
  meaning http, Tailscale-User-Login the device's user, none for tagged
  devices), so a tailnet client chooses neither `ctx.origin` nor its audit
  address and an HTTP-mode client cannot claim https. The tailnet app has
  no agent endpoint and no domain redirect, and its HTTPS answers carry no
  HSTS (the agent moves Serve between https:// and http:// when the
  tailnet's certificates change).
- Host pinning (`tailnetHostGuard`, before anything else): a request with
  `Tailscale-Funnel-Request` gets 403, even `/api/health`; `/api/health`
  otherwise answers on any host (the agent's probe); on another tailnet
  than the one Serve was turned on for, 403; X-Forwarded-Host equal to the
  known dnsName is served with Host set to it (so origin checks, cookies
  and links see the browser's name); the short name or a tailnet address
  gets 308 to the full name; any other host 421; while no dnsName is known
  yet, 503.
- `http/ops-http.ts` sets `via: "tailnet"` and `viaLogin` (Serve's
  Tailscale-User-Login, cut to `maxViaLoginLength`) on calls from the
  tailnet app only (`pipeline.ts` `viaOf` keeps them for HTTP calls only).
  They go into the call's audit row and prove the tailnet path; they never
  sign anyone in. Passkeys stay bound to `panelDomain`.
- Both listeners share one LiveHub: live sockets on the tailnet socket are
  closed and re-checked like the others (`addDisconnector`,
  `addRechecker`, see the live socket).

## Releases and updates

Release assets (GitHub release `v<version>` of `<githubOrg>/<githubRepo>`,
built by the Release workflow: `make build-ts` in the read-only Build and
test job, `make release-draft` on that build, then `scripts/release-sign.sh`
in the Sign job; `make release` does all three locally). Releases are
published this way, signed with `brand.minisignPublicKey`, since 0.2.0.
`scripts/release-preflight.sh` refuses a release while that key is the
placeholder or the e2e test key, `MINISIGN_SECRET_KEY` does not sign for
it, or the GitHub repo is not pushable. A build that still carries the
placeholder key (a fork that has not set its own) has updates off:
`updates.check` stores "signing key is not configured", agents refuse
UpdateAgent with FAILED_PRECONDITION and the installer refuses to
download without `--allow-unsigned`. Assets:

- `<slug>_linux_amd64`, `<slug>_linux_arm64`: static agent binaries, and
  the laptop CLI as `<slug>_darwin_amd64`, `<slug>_darwin_arm64`,
  `<slug>_windows_amd64.exe`, `<slug>_windows_arm64.exe`, with
  `checksums.txt` (sha256 of the binaries, `install.sh` and
  `openapi.json`) and `checksums.txt.minisig`.
- `install.sh`: the rendered installer (`scripts/render-installer.sh`).
- `openapi.json`: the op API description (`scripts/gen-openapi.ts`); the
  docs sync their API reference from `releases/latest/download/openapi.json`.
- `<image>:<version>` and `:latest`: the multi-arch panel image
  (`deploy/panel.Dockerfile`, data in `<dataDir>/panel`, health check on
  `/api/health`). It has no `USER`: agents run it with `--user
  61000:61000` (`ARG PANEL_UID`, the same as `docker.PanelUID`), and
  started as root (an older agent, `docker run` by hand) its entrypoint
  (`deploy/panel-entrypoint.sh`) runs the command as the data folder's
  owner, never as root, giving a root-owned folder to uid 61000 first.
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
the swap are reported at once and returned as the RPC error. While a
deploy on the node is between changing its containers and verifying the
new generation (`reconcile.Runtime.Unverified`; an agent stop then rolls
it back and it runs again after the start), the update answers once the
download is checked and swaps, arms the guard and restarts only when no
deploy is left unverified, at most 5 minutes later
(`update.DefaultRolloutWait`); a failure from there on is only reported,
as a durable `UpdateResult`. The guard
also counts the rollback in `<dataDir>/update/agent-rollbacks.json`
(by version, kept across restarts; `update/rollbacks.go`): automatic
installs of that release (auto-update on connect, the AGENT_TOO_OLD
self-update) wait an hour after its first rollback and a day after each
later one, and the restored agent raises an `UPDATE_FAILED` node alert
saying until when. `UpdateAgent` from the panel does not wait, unless the
panel sets `automatic` (its automatic run, and a node catching up after it
was offline during a run): then the agent waits the same way, and also an
hour after an automatic update of the release failed before the swap, and
answers FAILED_PRECONDITION with details `backoff` (`rolledBack` or
`failed`) and `retryAfter` (RFC 3339), installing and reporting nothing
(`update.WaitError`). Agents before 0.2.0-rc.2 ignore the field. A
confirmed update, or an agent already at or past the release, drops its
record and resolves the alert once none is left. The panel keeps its own
record from the rolled-back `UpdateResult`s (setting `updateRollbacks`,
`modules/updates/rollbacks.ts`), so its automatic update runs do not
reinstall the release either; see "Updates".

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

Panel move (since 0.2.8, `panel.relocate.v1`, panel `modules/panelMove`,
agent `update/panel_move*.go`, `agent/panel_stage.go`): moves the panel
service to another joined node. Ops `panelMove.check` (query: block
codes, soft `nodesLeftBehind`), `panelMove.start` (owner, browser session
confirmed in the last 15 minutes), `panelMove.status` (query, anyone signed
in gets the state), `panelMove.cancel` (before the switch) and
`panelMove.removeOldCopy` (destructive); none is an MCP tool. Steps:
`pausing` (every change answers CONFLICT `panelMoving`, signing in and out and `panelMove.cancel` excepted, the job runner held, durable reports
from agents answer UNAVAILABLE), `registry` (ExportRegistry on the old
node streamed into ImportRegistry on the target; the two `size_bytes`
must match), `snapshot` (`Databases.snapshotTo`: a consistent copy of
`panel.db` and `metrics.db` plus `master.key` and `agent-tls.key`, with a
sha256 manifest), `shipping` (ImportPanelData, a tar.gz checked file by
file against the manifest), `starting` (StartMovedPanel: the agent pulls
the image, starts the panel on the copied data on standby and checks the
pin and `expected_version`; this panel holds every desired-state send to
the target from here, `DesiredStateSync.hold`, since a SyncDesired would
drop the panel spec just installed), `staging` (StagePanelAddress on every
other online node, disabled ones included: config.yml `staged` = the new
`https://` address and pin, `staged_move` = the move id, written before
the answer, after an HTTPS probe of `<url>/api/health` over the pinned
connection whose JSON must carry `"moveId"` = the move id, so an address
that reaches the old panel, same pin, fails), `committing`
(CommitMovedPanel on the target: the switch, see below) and `switching`
(RetirePanel on the old node: it answers, then stops the old panel and
keeps its spec stopped, and answers again once retired;
`update/panel-retire.json` makes `seylo panel start` refuse). The moved
panel answers `/api/agent/connect` with 503 and Retry-After 10 until the
commit, and the old panel does the same from `switching` on and closes
joins with 1011. An agent dials `staged` only after its primary failed at
the TCP/HTTP level for 10 s (a HelloRejected never counts; a 503 there is
a failed dial too), then alternates the two; the target dials its staged
loopback address only after CommitMovedPanel. On HelloAccepted from the
staged address `panel_url` and `panel_pin` become the staged values,
`insecure_transport` goes false and `staged`, `staged_move` and `fallback`
are cleared. The pin is the SPKI of `agent-tls.key`, which moves with the
data, so nodes need no re-join. The target, now the panel's node, dials
`https://127.0.0.1:<agents' port>` with the pin from then on (not the
installer's `http://127.0.0.1:<panel port>`); both count as loopback
(`dialsLoopback`), and the agents' port stays bound on 127.0.0.1 while
IP access is closed. CommitMovedPanel first checks the moved
panel works (reconcile RUNNING, the pin on the agents' TLS port, the
version on /api/health; the journal carries the pin): not answering right
now is UNAVAILABLE `commit` (retry), another key or version
FAILED_PRECONDITION `notStarted`. It then records the commit in the
target's move journal (Resume keeps a committed journal and rewrites a
missing marker, never undoes it) and writes `move-commit` (the move id,
temp file and rename, the panel user's, 0600) into the moved panel's data
folder; ImportPanelData never takes a `move-commit` file. The standby
panel polls it, then takes agents, and its first accepted agent session
commits the arrival (the job runner starts; alerts keep a 5 minute
grace); its /api/health answers `"switched": true` once the marker is
there. The commit is the point of no return: AbortMovedPanel answers
FAILED_PRECONDITION `committed` after it. The old panel retries a commit
with an unknown outcome (timeout, UNAVAILABLE, target offline) every few
seconds and never aborts by itself, read-only and still serving its nodes
(`waitingSince`). Meanwhile it looks at the moved panel itself
(`panelMove/probe.ts`: GET `https://<address>:<agents' port>/api/health`
over the pinned key): `"switched"`, or no `moveId` any more (arrived),
means the commit landed and the move goes forward; what it saw is in
`error` while it waits. After 10 minutes without an answer and with that
look done, `panelMove.cancel {force: true}` may abort (`canForceCancel`),
for a target that is gone for good; a forced cancel the target answers
`committed` (or whose look shows the switch) goes forward instead, and a
queued abort refused later with `committed` is logged and audited
(`panelMove.forcedCancelConflict`). A refusal `notStarted` aborts at once.
Any failure before the commit aborts: AbortMovedPanel on the target
(idempotent), ClearPanelAddress on staged nodes (a no-op for another
`move_id`), the hold released. A panel that restarts mid-move
(`recover.ts`) aborts a move that had not reached `committing`, resumes
the commit retries in `committing`, and stays retired from `switching`
on. The pause before the snapshot waits for mutations already past the
gate. The old
copy stays until `panelMove.removeOldCopy` (RemoveOldPanel: refused with
`panelHere` or `moveUnfinished`, reports `freed_bytes`). The move is
refused with IP access closed, Tailscale Serve on, an unfinished key
rotation, no agents' TLS port, a target or panel node that connects over
plain http:// from another host (`targetPlainHttp`,
`panelNodePlainHttp`; checked again before the registry and the data
stream open), or the last move's old copy not deleted while its node
still exists (`oldCopyLeft`; a later failure then shows in the done
status's `error`); the address may not be one of the panel node's own,
and `panelMove.check` with a typed address answers BAD_REQUEST field
`address` for one start would refuse. RetirePanel answers success again
for a copy already retired (same service, or the same move, no panel
container running). A node that is offline, on plain HTTP or too old blocks
it unless the caller passes `leftBehind: true` (it joins again with
`seylo join --force`).
`move_id` matches `^[a-z0-9][a-z0-9_-]{0,62}$`. Error reasons (status
details key `reason`): INVALID_ARGUMENT `badRequest`, `manifest`,
`badArchive`; FAILED_PRECONDITION `panelRunning`, `panelHere`, `noPanel`,
`moveUnfinished`, `notImported`, `pin`, `version`, `plainHttp` (every move
call that carries panel data or the switch, over a plain-HTTP session
from another host), `probe`, `notStarted`, `committed`;
RESOURCE_EXHAUSTED `noSpace` (free space below `max(size_bytes*3, sum of
manifest sizes) + 64 MiB`); ABORTED `busy` (update lock); UNAVAILABLE
`pull`, `start`, `health`, `pin`, `undo`, `config`; CANCELLED
`cancelled`. ImportPanelData, ImportRegistry and StartMovedPanel are
refused while a panel container runs on the node. e2e check 41 moves the
panel from A to B, fails a move to C on a held port (rolled back), then
moves it back to A, deleting each old copy.

Test builds of the panel (the e2e only): `bun build` with
`--define __TEST_RELEASE_API_URL__='"<mirror>/repos/<org>/<repo>/releases/latest"'`
and/or `--define __TEST_RELEASE_PUBLIC_KEY__='"<RW... key>"'` compiles in a
release mirror and a throwaway minisign key (`modules/updates/manifest.ts`
`testReleaseOverrides`). They are build-time constants on purpose: no
environment variable can point a shipped panel at another release source or
key. Such a panel logs a "TEST BUILD" warning on start. The pre-release
channel lists `<that URL without /latest>?per_page=100`, which the e2e
mirror does not serve (the e2e runs on the stable channel).

Docker update (`UpdateDocker`): reports `from`/`to` from apt or dnf/yum at
once, plus `warning` when Docker's live-restore is off (every service and
the panel stop while dockerd restarts), with how to turn it on from
`nodecheck.LiveRestoreSteps`, the Docker live-restore check's hint (since
0.2.12: on Docker 29.0 to 29.2 with a "dns" setting it adds `systemctl
restart docker` right after the reload, moby#52060); unless `dry_run` it upgrades the installed Docker packages in the
background and reports a durable `UpdateResult` (target DOCKER). Reboot
waits `delay` (default 5s) and refuses while an update runs (ABORTED).
Errors map to statuses: busy ABORTED, up to date ALREADY_EXISTS, bad
signature PERMISSION_DENIED, refused INVALID_ARGUMENT, no signing key or no
runtime FAILED_PRECONDITION, anything else UNAVAILABLE with the message.

Docker version check (since 0.2.5, `update/docker_check.go`, capability
`node.docker-check.v1`): the agent runs UpdateDocker's dry-run plan by
itself (apt refreshes its lists the same way; dnf/yum `list --upgrades`)
and upgrades nothing: 2 minutes after it starts, then a day after the
newest finding. A person's dry run, and a finished upgrade (installed =
candidate = the new version), are findings too, so they move the next
check a day on. Every finding goes to `NodeFacts.docker_update`
(`DockerUpdateInfo`: installed, candidate, package manager, checked_at,
updatable, reason); Docker that did not come from a package manager the
agent drives (static binaries, snap, none of apt/dnf/yum) is a finding
with `updatable` false and a reason, not an error. A failed check (apt
could not refresh, say) keeps the last finding and tries again after an
hour, doubling up to a day. The check takes the node's update lock as work
that gives way (`Lock.TryAcquireYielding`): it never starts while an
update, panel swap or reboot holds the lock (it tries again in 15
minutes), and any of those that comes in while it runs stops it (the
running apt command is cancelled) and goes ahead after waiting at most 10
s for the lock, instead of answering busy; the check then tries again in
15 minutes. The lock is released as soon as the package manager answered.
The panel stores the newest report per node in `nodes.docker_update`
(migration 0007; `modules/nodes/docker-check.ts`): from the agent's facts,
from `nodes.updateDocker` (what its dry run or upgrade answered, checked
now) and from a successful Docker `UpdateResult` (the new version
installed, nothing newer). Agent times are compared with agent times only
(`agentCheckedAt`, the newest `checked_at` or `finished_at` the agent
sent): a finding no newer than that is ignored, so the facts every connect
resends change nothing and a clock that is off never hides a newer
finding; `nodes.updateDocker`'s answers always count as the newest.
Only for agents that advertised the capability, `Node.docker` is `{
version, latest, updateAvailable, checkedAt, reason }`: version is
`NodeFacts.docker_version` (what runs, so an update made by hand counts),
`updateAvailable` true when the candidate is newer than both the package
and the running version, false when not and the report is under two days
old, null otherwise (a stale report, or `reason` set: the agent cannot
update Docker there). The Machine card shows a newer version amber with a
question mark (tooltip "Docker X is available. Update it from this node's
actions.", a button, so the keyboard reaches it), and Update Docker is off
with a title when `updateAvailable` is false ("Docker is up to date (V,
checked 2 h ago)") or `reason` is set; nodes without `docker` keep the old
behaviour. The confirm dialog still runs its own dry run.

Installer contract ("panel + node here"): `seylo panel bootstrap` writes
`<dataDir>/panel/setup-token` and `<dataDir>/panel/join-token` (one line
each, 0600, owned by the panel user 61000:61000, the folder 0700), creates
the `seylo-p-panelproject0000` network and
runs the first panel container as service `panel00000000000` in project
`panelproject0000` (generation 1, protected, published on the chosen port,
default 3000, `--user 61000:61000` with the `seylo.user` label), waits for
`/api/health`, writes config.yml with
`panel_url: http://127.0.0.1:<port>` and the join token, then prints
`http://<ip>:<port>/setup?t=<setup token>` (`<ip>`: the IPv4 route's
source, else the IPv6 route's in brackets, else a public interface
address; `<server-ip>` with a hint only when there is none). With
`--link-file <path>` (the installer passes it when `panel bootstrap --help`
lists it, so an older agent still prints) it writes the link and its notes
there instead (0600: the link on the first line, then the address note and
the plain-HTTP tip, one per line), and the installer shows them in the
block that ends its run. A new panel
install, and a re-run of the panel installer on a node that has a panel
folder, warn when an account on the server has uid or gid 61000
(`getent`); the agent warns on every node after that (see "Docker resources").
Join: `install.sh join --panel
<url> --token <t> [--version <v>] [--pin sha256:<hex>] [--can-build|--no-can-build]` runs
`seylo join --no-start`, then starts `seylo.service` and waits up to 60
seconds for the agent's first connect (`seylo status`). A panel it cannot
reach yet is reported with what to check and the exit status stays 0 (the
agent keeps trying, the token stays valid for its hour); a panel that
refused the node (a used or expired token, a wrong pin, a removed or
disabled node: status `rejected`) ends the wait at once with exit status 3,
since that join never connects; `AGENT_TOO_OLD` is waited for like an
unreachable panel (the agent updates itself). An installer from a
release defaults to that release (`--version` picks another and takes the
agent from that release's signed manifest), which is how the panel's join
command, piped from the install host, pins the agent to the panel's
version. Re-runs update the binary and units and keep the
node, but never to an older release than the node runs: when the installed
agent (`seylo version`), or on the panel's node the running panel (the
`org.opencontainers.image.version` label of its `seylo.service=panel00000000000`
containers), is newer than the release to install, the installer stops
before it changes anything unless `--downgrade` (`--binary` is not checked);
versions compare by semantic versioning, a pre-release before its release.
`uninstall [--purge]` removes the agent (and with `--purge` every
`seylo.managed` container, network, volume and the data dir).
Port check (before anything changes): a new panel install stops when
another program holds 80 or 443 (named from `ss -ltnp`) unless `--force`,
and when the panel port is taken; our own containers (a Traefik or panel
left by an earlier install) and Wings' Traefik on a Wings server pass, and
joins only warn.
Output: a one-line banner (product, release, what the run does), `==>` step
headers, and a closing block (new panel: the setup link on its own line,
how long it works, the next step; join: connected or not and what to check;
re-runs: status commands). Off a terminal (logs, pipes, CI) it is plain
ASCII with every sentence on one line; on a terminal success lines get a
check mark and the block box lines (ASCII ones on the Linux console,
`TERM=linux`) with text wrapped at 72 columns, and colors come on top unless
`TERM=dumb` or `NO_COLOR` is set. Line based, no spinners or cursor
movement. A run that fails after the panel started (so before its closing
block) prints the setup link on exit. `INSTALLER_TEST_COLOR=1` acts as a
terminal (installer/test/run.sh).

Docker install (since 0.2.1): a server without the `docker` command gets
Docker from get.docker.com without a question, with or without a terminal
(`--no-docker-install` stops instead). An installed Docker that does not
answer is started (`systemctl start docker`); when it still does not
answer, the installer stops before it changes anything and points to
`systemctl status docker` and `journalctl -u docker`, unless
`--install-docker` (or `--yes`, as before 0.2.1) asks for get.docker.com
over it, which replaces distribution packages such as docker.io,
containerd and runc. Join commands never carry `--install-docker`.

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
otherwise stop every service and the panel. On Docker 29.0 to 29.2 with a
"dns" setting (a `"dns"` key with entries in daemon.json, or `--dns` in
`systemctl show --property=ExecStart docker.service`) that reload empties
the setting for every new container (moby#52060, see "Container DNS
check"), so since 0.2.12 the installer runs `systemctl restart docker`
right after it, once Docker reports live-restore on (containers keep
running through it), and waits up to a minute for Docker to answer; when
live-restore does not show up it restarts nothing and warns that new
containers get `nameserver invalid IP` until Docker restarts. It leaves an
explicit `"live-restore": false`, swarm mode and Wings nodes alone (with a
warning, whose advice adds the restart after the reload in the same
case).

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
setup token and restarts the panel container so it imports it;
`seylo panel rotate-key` replaces `master.key` after a leak (TypeScript
conventions, secrets). `seylo panel status` (localapi `PanelStatus`)
prints the service line, then since 0.2.1 how Docker publishes the two
ports, read from the running container's bindings (`IP access: closed
(127.0.0.1:3000); agents' port: open (0.0.0.0:3443)`; states open,
closed, off, unknown when no panel container runs), then a `Tailnet:`
line from the tailnet area's last report when the server runs tailscaled
(`active (https://panel.tail1234.ts.net)`, `off (Tailscale needs a
sign-in)`, `conflict (...)`, or `off on this server (no_tailnet is set
in config.yml; seylo panel tailscale on undoes it)`). An agent before
0.2.1 reports neither line. `seylo panel ip-access on` and `seylo panel
tailscale status|off|on` are in "Panel access and the tailnet".

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
  version N-2 minor, raised by the `minAgent` of the release the panel runs:
  the stored check's only when it found the running version, else the one
  kept in `runningRelease`; a newer release the panel has only checked never
  raises it, `updates/release-state.ts` `runningMinAgent`) get
  `HelloRejected { AGENT_TOO_OLD, min_agent_version }`; dev builds always
  connect. ServerHello advertises `panel.report.v1`, `panel.desired.v1`,
  `panel.registry-tunnel.v1`, `panel.edge-access.v1` and
  `panel.backup-sign.v1` once the nodes module attached PanelService.
  HelloAccepted carries `panel_url = https://<panel domain>` and an empty
  `panel_pin` on every connect of a node that is not the panel node, once
  `panelDomainStatus` is `active` for the current domain (the hourly check
  reached `/api/health` there with the panel's public roots, so agents
  verify it with their system roots; `agent-hub/move-target.ts`); nothing
  before. Since 0.2.8 the check proves the answer is this panel's:
  `/api/health?proof=<nonce>` answers `"proof"`, an HMAC-SHA256 of the
  nonce (16-128 of `[A-Za-z0-9_-]`) under a key only this panel holds
  (`http/health-proof.ts`, `deps.healthProof`, made at start, never
  stored), and the check sends a fresh nonce and needs the match; before,
  any `{"status":"ok"}` passed, so a proxied record still pointing at
  another server went active. A domain proxied by Cloudflare (every A/AAAA answer in
  `http/cloudflare.ts`'s ranges, `domains/dns.ts` `classifyRecords`) skips
  the node-address comparison: the HTTPS probe through Cloudflare alone
  decides (`proxied: true` in `settings.general.domainStatus`), an active
  domain stays active when it turns proxied while the probe passes, and
  agents verify Cloudflare's certificate with their system roots (the
  panel identity signature does not bind TLS, so it holds through the
  proxy). `settings.checkDomain` (`settings.manage`, added in 0.2.1) runs
  the same check in the request through the job's single flight
  (`checkDomainNow`), once per 10 s per panel (RATE_LIMITED with
  `retryAfter`), and returns the fresh status with `checkedAt`; saving the
  domain enqueues a forced check that ignores the hourly skip of an active
  domain. When the domain check job sees the domain turn active, it closes
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
- `nodes.createJoinToken` `pinnedCommand` (since 0.2.8): when `command`
  joins over the panel domain (no pin) and the agents' TLS port is open,
  the same token over `https://<panel IP address>:<agents' port>` with
  `--pin` (`join-target.ts` `agentPinnedTarget`, `panelIpUrl`), for a
  server whose network decrypts HTTPS (TLS inspection re-signs the
  domain's certificate) or cannot reach the domain; null otherwise. With
  it, since 0.2.12, `setPanelCommand`: `sudo seylo set-panel '<that
  url>' --pin '<pin>'` (`join-command.ts` `setPanelCommand`, no token, not
  sensitive), which Add node shows under it as "Already joined? Point it
  here" for a node that joined over the domain and went offline that way
  (Protocol, "Pointing a joined node at another address by hand"). The
  panel has no node page with the agent's last connection error (an agent
  that cannot connect reports nothing), so no node page shows it. The
  agent's dial error names the refused certificate's issuer
  (`conn.certificateHint`: TLS inspection, with exempting the domain,
  joining with the IP and `--pin`, or since 0.2.12 `seylo set-panel` as
  the ways out, or Traefik's own certificate when the panel's server has
  none for the name), a pin mismatch too, and the installer shows that
  hint instead of the ports one. A join on a node
  already joined to the same `panel_url` joins again with the token (as
  `--force`) only when `seylo status` (read from its `Panel:` line and the
  start of its `Error:` line, never text a peer chose) proves the earlier
  join dead within 20 s of the restart: HELLO_REJECT_REASON_UNKNOWN_NODE
  (removed from the panel), the agent's errOtherPanel for that address, or
  a pin mismatch where the command's `--pin` names another key than
  `panel_pin`. A disabled node, the same or no pin, AGENT_TOO_OLD, a bad
  token, anything else, connected or unreachable keep the earlier join
  (exit 0, a warning with the next step). Certificate issuers reach
  `seylo status`, logs and alerts quoted, on one printable line, at most
  80 runes (`conn.IssuerName`, `conn.PrintableLine`). A node on a pinned
  `https://` address whose move to the domain fails on an untrusted issuer
  or a pin mismatch tries it again after 24 h (`untrustedMoveRetryAfter`)
  instead of 1 h, keeping its session meanwhile; an agent restart or
  another address tries at once.
- PanelService (`agent-hub/panel-service.ts`): ReportCrash stores
  `crash_reports`, ReportEvent stores a capped copy in `agent_reports` (30
  days), both with capped fields, deduped by (node, outbox id) and within
  the node's daily report budget, then fan out; GetDesiredState returns the
  current state unless the agent has that revision; RegistryTunnel relays
  to `Tunnel(RegistryTarget)` on the node with `nodes.is_panel_node` (the
  first node that joins); CheckEdgeAccess answers whether an edge tool
  session may stay open; SignBackupRequests serves the S3 steps of a
  backup or restore running on the node (`modules/backups/signing.ts`).

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
place, in registration order. `ctx.memo` lives for one compile (a full
state, or the specs one ApplyService pass compiles together before its
first send) and holds what many services share. The networking contributor
(`modules/domains/contributor.ts`) sets env, routing, dev access, public
ports, database/Box specs and the global maintenance page; services
without a sealed deployment env (databases, Boxes, parked clones) resolve
theirs from one env graph per project per compile (`ctx.memo`), not one
per service.

Live topics the nodes module publishes (`modules/nodes/live.ts`): `panel` invalidates
`nodes.list`, `nodes.choices`, `system.info`, `updates.status` on node
changes; `node:<id>` invalidates `nodes.get`, `nodes.healthReport`;
`service:<id>` invalidates
`services.get` (with `project:<id>` -> `services.list`) whenever a node
reports a change in the service's status. Metrics samples (about every 10 s
per node) follow `modules/metrics/live.ts`, since the stored series change
only when a minute is written: every sample sends `nodeUsage { nodeId,
usage }` on `node:<id>` (the `latest` of metrics.nodes and metrics.node,
which the web app writes into its cache, `lib/live-metrics.ts`; the
dashboard follows every node's topic for it) and invalidates
`metrics.node` `range: live` there, and `metrics.service` `live`/`1h` on
`service:<id>` at most once per 9 s per service. When a minute is written,
`panel` invalidates `metrics.nodes` and `metrics.summary` once for the
whole fleet (12 s after the first node's minute), and `node:<id>` /
`service:<id>` their own series, by range: `1h` every minute, `24h` every
5 minutes, `7d` and `30d` every hour. Screens that follow those topics poll
only while the socket is down.

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

Updates: `updates.*` read `manifest.json` + `manifest.json.minisig` of
the newest release on the release channel, verified with
`brand.minisignPublicKey`. The channel (setting `updateChannel`,
`updates.setChannel`, owner only, audited, checks at once) is `stable`
(default: GitHub's `releases/latest`, never a pre-release) or `prerelease`
(the releases list: the highest semver of the non-draft releases whose tag
is a version, pre-releases included, so 0.2.0-rc.1 < 0.2.0-rc.2 < 0.2.0;
its manifest must name that version). The stored check (setting
`updateCheck`) records its channel; one from the other channel offers
nothing, and a failed check keeps the last good release of the same
channel only. Nothing offers a downgrade: `updateAvailable` and the run's
steps need a newer version, and `updates.updateNode` answers CONFLICT for a
node that already runs the release or a newer one (back on stable, an RC
stays until a newer stable release). `updates.status` has `channel`,
`canChangeChannel`, `panel.offeredVersion` and `panel.latestIsPrerelease`.
A run is update_runs/update_steps advanced by the `updates.run` job: panel
step (UpdatePanel on the panel node), then one agent step per older node
(UpdateAgent with the verified bytes, deadline 2 minutes since 0.2.1:
`updateAgentTimeoutMs`); a durable `UpdateResult` or the new
version on reconnect finishes a step, and so does ALREADY_EXISTS at once.
A node that answers busy (ABORTED: another update holds its lock, such as
the panel swap that just brought this panel up) is logged and gets
UpdateAgent again after 5 s, doubling up to a minute (`busyRetryMs`, kept
in memory: after a panel restart such a step finishes by version or times
out), within the step's deadline; since 0.2.1 the agent's UpdateAgent
also waits up to a minute for a panel swap that holds the lock
(`Lock.AcquireWithin`, never into the last 30 s of the call's deadline;
any other holder is busy at once), and its on-connect auto-update retries
for 10 minutes. 10 minutes without a result fails the step and the run
with "The update did not finish in time." and an `update_failed` alert
(key `update-failed:<step id>`, the one a failed `UpdateResult` uses, so a
late result does not alert twice; a Docker step without a result alerts
too), and an agent step is tried once more 5 minutes later
(`timeoutRetryMs`, through the catch-up as retry `waiting`; that try is a
run of trigger `auto`, and a second timeout is left to Update now). That alert is resolved when the node gets there
after all: a late successful `UpdateResult` for the step (it stays
failed), the retry or a later run reaching that version, a successful
agent `UpdateResult` for it or a newer one, or the catch-up finding the
node up to date. A run keeps the manifest it installs (`update_runs.manifest`,
`manifest_signature`; a run from before rc.2 gets the stored one while it
is still that version), so a later check or a channel switch never changes
what its steps send. `nodes.updateDocker` is a one-step run finished by
its `UpdateResult`; the `updates.run` job watches it (every 30 s; the node
going offline is expected while Docker restarts) and fails it when no
result came within an hour (`dockerStepTimeoutMs`: the agent reports only
after the package manager is done and keeps nothing across a restart) or
its node was removed, so it never holds other runs and catch-ups back for
good. A late result still finishes a step that failed for lack of one. On
start the panel queues `updates.run` for every running run without a
waiting job (runs older panels left running). The release check runs every 6 hours (schedule
`updates.check`) and starts a run when auto-update is on. That automatic
run leaves out a node whose update to the release was rolled back (any
rolled-back agent `UpdateResult`, also from the agent's own update on
connect) and does not start when the panel's own update to it was; a newer
release, or a run a person starts (Update now, update everything),
installs it again and clears the record, and a successful update forgets
it. UpdateAgent carries `automatic` for every run a person did not start.

A node offline when its step comes up, or whose session drops while its
UpdateAgent is in flight (UNAVAILABLE `offline`), is skipped with `retry:
waiting` (`modules/updates/catch-up.ts`), and the run goes on. A connect queues `updates.catchUp` only
when the node has a waiting step (one indexed lookup, so most connects
write no job); for its newest waiting step the job records `upToDate` (the
node runs that version or newer), `held` (the node rolled that version
back: not retried automatically, Update now installs it) or starts a run of
trigger `reconnect` with one agent step to that run's version and manifest
(`retried`, `retryRunId`: that run's step says how it went), waiting 30
seconds at a time while another run is active. A later run with a step for
the node marks older waiting steps `superseded`. The agent's own waits end
the catch-up step as skipped with its message (FAILED_PRECONDITION
`backoff`), not as a failure: `rolledBack` makes it `held`; `failed` makes
it `waiting` again with `retryAt` the agent's `retryAfter` + 30 s (never
sooner than 5 minutes, against a slow agent clock, nor later than 24.5
hours, against one far ahead or a bad value: the agent's longest wait is a
day) and queues the job for then; connects before that queue nothing. A catch-up step whose node is
offline again waits for its next reconnect the same way. Steps a panel
before rc.2 skipped as offline ("it updates itself when it starts", no
`retry`) are adopted at start (`adoptOldSkips`): a node's newest one
becomes `waiting` unless a later run has an agent step for the node. Their
runs kept no manifest, so the catch-up installs the stored release when it
is the step's version or newer (`held` when the node rolled that one back);
until a check finds one the step keeps waiting. The steps'
`retry`, `retryRunId` and `retryAt` and the run's trigger show in the
history.

Metrics: each `metrics` event feeds `modules/metrics/ingest.ts`: a 5-minute
in-memory window (range `live`) and `metrics.db` buckets 1m (26 h), 5m
(8 days) and 1h (35 days); `30d` groups hourly buckets by 6 hours. Network
rates come from the cumulative counters of consecutive samples. Each sample
is one metrics.db transaction; closing a minute writes the 1m row and
updates the 5m and 1h rows from running sums (a bucket's 1m rows are read
only when it starts, after a restart, or when a minute comes again), and
the hourly prune deletes through `(resolution, bucket_start)` indexes
(metrics migration 0001).

Live node samples (`modules/metrics/node-live.ts`, the dashboard's Live
graphs; `metrics.nodeLive` in `@seylo/ops`: one sample every 2 s, a
5-minute window). The 10 s reports above are too coarse for them, so
while at least one tab follows `node-live:<id>` the panel keeps one
WatchMetrics stream open to that node's agent with `light: true`,
`interval` 2 s and `lease` 60 s, and publishes every sample to the topic
as `nodeLive { nodeId, sample }` (`t` on the node's clock, CPU, memory used
and total, network rates from the stream's own consecutive counters; the
first sample's rate comes from the ingest's latest periodic counters,
`MetricsIngest.networkCounter`). The hub fans one stream out to every tab.
Nothing is stored: metrics.db and the 5-minute live window still take the
10 s reports only. Each watch is renewed 5 s before its lease ends (the
next one opens; at its first sample the old one is cancelled, and older
samples than one already sent are dropped); when the last tab leaves, the
watch lingers 10 s (a reload, a quick tab switch) and is cancelled; an
offline node gets its watch when it connects; a failed watch, or one that
ends on its own before half its lease, is opened again after 2 s, doubling
to 30 s; a node without `metrics.read.v1` gets none. A sample costs the
agent three small /proc reads and about 40 bytes on the wire, plus about
200 bytes of JSON per tab.

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
| People and access: setup link, email and password, GitHub device flow, sessions, TOTP and recovery codes, passkeys, API keys; users, invites and grants; avatars; the audit log; the op pipeline, permission checks and the op framework | `auth`, `avatars`, `setup`, `users`, `invites`, `grants`, `apiKeys`, `audit` | `src/auth/`, `src/security/`, `src/ops/`, `scripts/create-owner.ts`, `scripts/setup-link.ts` | `identity.ts`, `audit.ts` |
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
(checked in the handler, `move-project.ts` `requireTargetProject`). Clones
and imports write the new service's rows through `services/portable.ts`
`materializeService` in one transaction (the spec through
`portableSpecOf`). A clone
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
`<name>.<node wildcard>`). Previews are off on the clone. A repository
source (`github`, `git`, `provider`) keeps the source's `deployOnPush`
unless `services.clone` gets `deployOnPush` (add-only, optional; other
sources ignore it, and `portableSpecOf` keeps the source as it is, so an
export is unchanged and an import still decides for itself). While it is
on, the clone deploys on each push to its branch like the source:
pushes through the GitHub App reach every service of the repository
(`github/push.ts` `servicesForRepo`), and polling follows every service
with `deployOnPush` set, but a delivery to a repository webhook names one
service, so a source read through the connected GitHub account or a
provider connection gets the clone a webhook of its own after the
transaction (`connectCloneHook`: `ensureRepoHook` or `ensureHook`, the
connectRepo rules, a provider's origin address only for
`gitProviders.manage`; a refusal keeps its reason on the row and polling
covers pushes, a throw is logged and never fails the clone). A `git` URL
deploys on push through a deploy trigger URL, which a clone never copies.
A compose member becomes a standalone app (`member: null`), compose stacks
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
`copies.ts`); a second copy from the same source is refused. A push to
the clone's branch meanwhile (a webhook, the GitHub App or polling, all
through `queuePushDeploy`) is held back: its delivery is `failed` with
"Its data is still being copied from <source>: this push deploys once
the copy is done." (`copies.ts` `heldPushMessage`). When the copy ends,
the job settles those deliveries (`clone.ts` `settleHeldPushes`): a copy
that is `done` queues one push deploy of the head of the clone's branch
(no commit: the build reads the head, so the newest push wins) and marks
them `deployed` with it, while a copy that failed deploys nothing into
its half-copied volumes ("The data copy from <source> failed, so this
push was not deployed.") and a clone whose Deploy on push was turned off
meanwhile deploys nothing either (`ignored`). A push to a source the
copy stopped is still refused, as before. Deleting
the clone or the source ends a copy that has not ended (`failed`, "The
clone was deleted." or "The source service was deleted.", in the delete's
transaction, `services/delete.ts`) and starts a source the copy stopped; a
copy whose clone is gone never holds anything back, so rows older panels
left `queued` release their source. A move to
another node with volumes (`services/move.ts`) places the service on the
new node, stopped, in the same step that stops it on the old one, and
waits for that desired state before it copies, like a parked clone; a
failed move removes that placement, and the new node drops the partial
copy with it. While the move copies (`deployments.moveCopying`),
`serviceSpecFor` sends the service stopped to both nodes whatever
`services.stopped` says, and `services.start`, `boxes.open`,
`services.setPlacements` and `services.setVolumes` refuse it (CONFLICT
`reason: moving`, `copies.ts` `assertNoMoveCopy`); a clone with
`data: copy` is refused for the whole move (`reason: moving`), since the
move deletes the old node's data once the new node serves.
`ServiceDetail.dataCopy` is the
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

Service export and import (`modules/serviceTransfer`, contracts and the
file format in `packages/ops/src/ops/serviceTransfer.ts`, published as
`service-export.schema.json`; added in 0.2.10). Owners
and admins only: `services.export` on the service and `services.import` on
the project are scoped actions with `adminOnly` (see Permission model), so
an admin key limited to some projects works there and nowhere else, and
members never hold them. Every op is `mcp: false`.

- The file (format `service-export`, `formatVersion` 1; the string is
  fixed, not the brand): `README.txt`; `manifest.json` (panel version and
  `panelId`, `exportedAt`, the secrets mode, `requires` (feature names an
  importer refuses when it does not know them; none in version 1), the
  services with counts, and every other entry's size and sha256);
  `manifest.sig` (HMAC of the manifest's exact bytes) and `secrets.enc`
  when encrypted; `services/<name>/service.json` (`PortableServiceV1`)
  only when secret values were left out; `services/<name>/source/upload.tar.gz`,
  the newest uploaded archive of an upload app, stored;
  `services/<name>/volumes/<volume>.tar.gz`, a volume's data as
  ExportVolume streams it (gzipped tar, owners, modes and links kept),
  stored with a data descriptor (zip64 past 4 GiB), its manifest entry with
  `unpackedBytes` (the agent's file bytes) and `files` (its entries, null
  from older agents); the document's `volumes[].data` names it. Entry names are an
  allowlist (`isExportEntryName`). With a passphrase the whole service
  document is inside `secrets.enc` (commands, URLs, host names and notes are
  private too); left out, service.json is in clear and holds no secret value
  (`.env` values, file mount contents, database logins, certificates, basic
  auth hashes, the tunnel token, shared variables' lines stay out). The
  uploaded archive and volume data are never encrypted; the dialog and
  README say so.
- Crypto (`crypto.ts`): scrypt (N 2^16, r 8, p 1 for new files; a file may
  ask for N 2^14 to 2^20, r 8 to 16, p up to 4, at most 256 MiB, checked
  before anything runs; 2 at a time, 8 waiting, then RATE_LIMITED, the
  shared `security/limiter.ts`), HKDF-SHA256 keys for the secrets, the
  manifest MAC and a 16-byte passphrase check, AES-256-GCM with the AAD
  `service-export/1` plus `<name> <kind>` per service. A wrong passphrase is
  FORBIDDEN `reason: passphrase`; an edited or damaged file BAD_REQUEST
  `reason: tampered`. The MAC proves the file against people who do not
  know the passphrase only: the UI never calls a file signed.
- `serviceTransfer.exportPreview` lists what goes in, what stays out
  (`leftOut`, also everything the caller may not read: `.env` and file
  mounts need `env.view`, logins `databases.credentials`, domains
  `domains.view`, the archive `files.read`, backups `backups.view`,
  listeners `exposures.view`, the tunnel `tunnels.view`) and blockers:
  `compose` (stacks and members), `protected`, `panel`, `preview`,
  `copying`, `moving`; `tooLarge` from the export op (service.json over
  2 MiB, secrets.enc over 3 MiB). `serviceTransfer.export` needs a fresh
  sign-in for every export (`requireFreshIfSession`), builds the document
  (`snapshot.ts`: panel-local ids replaced by names: an App installation by
  its account, the connected GitHub account by login, a git credential by
  name, host, user and fingerprint, a provider by kind, address and
  workspace, a registry login by server and user, nodes, channels and
  backup destinations by name; git URLs without credentials; the live
  commit, and for image sources the digest, never a panel-built image
  reference), `includeSourceLogin` adds the git credential or registry
  login (encrypted only, needs `git.manage`/`registries.manage`), seals the
  small entries, the manifest's fields and the MAC key on a
  `service_exports` row (`service.export`) and returns a one-minute ticket
  link. `GET /api/transfer/export?t=` (`http.ts`) takes the row from
  `ready` to `streaming` in one transaction and wipes the payload then (a
  second request gets 410), reads the archive's size, CRC-32 and sha256
  first (it must still match `source_uploads.sha256`), and writes the zip
  through `@seylo/zip` with the manifest last; the row records bytes, the
  zip's sha256 and the entries, and `serviceTransfer.exportFinished` is
  audited. `serviceTransfer.exportLink` issues a new link while the row is
  `ready` (2 minutes, same person, fresh sign-in). File name:
  `<service>-<yyyymmdd-hhmm>.<slug>.zip` (UTC).
- Volume data in an export: `serviceTransfer.export { volumes, stopService }`
  (`files.read`; a database all of its volumes or none, only encrypted,
  BAD_REQUEST `reason: databaseLogins` otherwise, and with
  `databases.credentials`; stopping a running service needs
  `services.control`). `exportPreview.data` says whether the data can go
  now (`noNode`, `offline`, `agentTooOld`, `permission`, `exporting`,
  `busy`), whether it is a database and whether it runs. With volumes the
  row keeps the node, the volumes and `stop_service` (on by default, always
  for a database). The download (`export-stream.ts`) takes the row to
  `streaming` only while no other download reads that service's data and
  fewer than 3 do on the panel (else 409); with `stop_service` it stops the
  service (`services.stopped` and `source_stopped` in one transaction,
  `desired.settled()`, `waitStopped`, 2 minutes, else 409 and it runs
  again) before the response starts, then writes the small entries, the
  archive, each volume (`readVolume`), the manifest and the signature, and
  saves `bytes_sent` every 2 seconds. However it ends (done, an agent or
  stream failure, the browser cancelling, nothing read for 5 minutes,
  12 hours stopped, `serviceTransfer.cancelExport`, or the panel
  restarting: `start()` fails `streaming` rows) the service starts again
  (`startExported`) and `serviceTransfer.exportFinished` is audited with
  the volumes and how long the service was stopped. `ServiceDetail.transfer`
  shows a download that runs or ended in the last 10 minutes (bytes, stopped,
  the zip's sha256 once done) and an import that still receives data.
- Guards (`services/copies.ts`): while a download with `stop_service`
  streams (whether it stopped the service or the service was stopped
  already; `source_stopped` only decides whether it starts again at the
  end), `queueDeploy`, `services.start` and `boxes.open` refuse it
  (CONFLICT `reason: exporting`); while a download reads its data, `services.move`,
  `services.setVolumes`, `services.delete`, `services.clone` with data and
  `backups.restore` refuse it too (`assertNoTransfer`, also `importing` for
  an import that fills it, except delete) and `services.moveProjectImpact`
  lists `exporting`/`importing`. An export is refused while a copy, a move
  or an import runs. `updates.start` (and the automatic run) waits with
  CONFLICT `reason: transfer` and the panel move preflight lists the work
  while a download or an import upload moves bytes (`transfersInFlight`).
- `serviceTransfer.importBegin` (strict rate limit, 4 MiB body, every
  input field sensitive) takes the text of the small entries the browser
  read: the manifest is checked (`document.ts`: clean relative paths
  through `@seylo/zip` `cleanName`, the allowlist, no duplicates, no
  entries for services not listed, at most 200 entries and 20 volumes per
  service, archive at most 512 MiB, secrets.enc listed if and only if
  encrypted, a newer `formatVersion` is "update this panel first"), every
  sent entry must match its size and sha256, secrets.enc is opened (KDF
  bounds, passphrase, MAC, AAD) and the document checked against
  `PortableServiceV1`: an item of `domains`, `exposures`, `cronJobs`,
  `uptimeChecks`, `alerts` or `backups` that does not fit (an unknown
  middleware, a new alert event: domain middlewares, listeners and access
  are strict objects) is left out with a note, never imported weaker;
  `access`, `tunnel` and `maintenance` fall back to none; anything else
  refuses the file with the path and the rule, never the value; keys this
  panel does not know are listed as `unknownSettings`. Compose documents
  are refused. A `service_imports` row (`previewing`, the opened file
  sealed as `service.import`, 24 h) holds it; nothing is created.
- `serviceTransfer.setChoices` saves the review page's choices on the row
  (normalised, never a password) and returns the preview;
  `serviceTransfer.importPreview` is the same answer as a scalar query. The
  plan (`plan.ts`) runs the create ops' checks on everything: name free and
  no planted references (else `<name>-2`), node, `checkEnvReferences`
  (hidden references are a blocker), `cronSettings`, `checkWatchPaths`,
  cron `checkSchedule`, uptime `assertTimeout` (and `assertTarget` at
  import), `checkRedirects`, `normalizeCidrs`, basic auth hashes only
  bcrypt `$2a/$2b/$2y` cost 4 to 12, certificates through
  `checkCertificate` and `assertCertificateNames` (a failing one drops to
  Let's Encrypt), hosts through the unique (host, path) and `hostConflict`
  (`usedHere`, `usedHidden`: skipped), the primary recomputed after skips
  (the file's, else the first that is not a redirect); custom domains get
  `domains.add`'s DNS check against the import's node when the import
  runs, so one whose records still point at the old node waits before its
  route asks Let's Encrypt (`acme_released_at` only once a check proves
  it, the re-check and the origin check go on from there, as after
  `domains.add`). Database and Box specs are built from the engine
  (`databaseSpec`, `boxSpec`), never taken from the file: a database runs
  this panel's catalog image of its version, whatever image the file says
  it ran (a `databaseImage` warning names both). A version the panel does
  not offer (0.2.11, any image) starts on the image the file ran when that
  image is of the engine's repository and names that line
  (`importedVersion`); otherwise the item is refused (`engineVersion`).
  The one exception is data
  written by a newer release of the line (`importedDatabaseImage`): data
  files do not go back (`judgeVersion`'s `olderImage`), so with its data
  the database keeps the file's image when `customImage` takes it (what
  `databases.setVersion` would set), and a newer one it does not take
  blocks the data (`databaseImage`, field `volumes`: leave it out or
  update the panel). Without the data an empty database starts on the
  catalog image, and a newer custom one is set again on the Version card
  once it runs. Of the file's container command only MySQL 8.4's
  `--mysql-native-password=ON` is kept (0.2.11, `databaseSpec(engine,
  version, { nativePassword })` with `hasNativePassword` of the file's
  command): when the file's command has that very argument and the
  version's `nativePasswordOption` takes it, the database runs `mysqld
  --mysql-native-password=ON`, so its accounts made with
  mysql_native_password keep signing in; no other argument of the file's
  command comes along, and other versions and engines run the engine's
  command. `pinDigest` only pins a source from the file: a database's
  or Box's image is never pinned to the file's digest (their
  `source.imageDigest` is null). One user inside and through the exposed port (0.2.9):
  the export never carries the `exposed_password` of a database from
  before 0.2.9, and names its `service_databases.exposed_user` only while
  that old user still waits for its retirement (`exposedUser`, a name).
  The import writes only `admin_password`, and `exposed_user` is that name
  only when the database's data comes along (`retiredUserToKeep`: the
  copied data holds the login, so this panel's node retires it, as
  `services.clone` does), "" otherwise; a password for it in a file is
  never stored. The admin password comes from the file only when
  it fits `databases.create`'s password rule (12 to 128 of
  `A-Za-z0-9._~-`: `engines.ts` writes it into SQL and shell input as it
  is), else a new one with a `databasePassword` warning. Listeners follow
  `databases.setExposure` on this panel: none for a version without TLS
  (MariaDB 10.11) or on a node whose agent cannot keep the port TLS only
  (`extras.exposures[].refusal` says why, and they are listed as skipped).
  What reads the source (`mapping.ts`) is the row the file's names point
  at, else a `needs` choice: another row, `createFromFile` (the included
  login, needs `git.manage`/`registries.manage`), or none (a repository
  source becomes no source). `createFromFile` builds the row through
  `git.createCredential`'s checks (`git/credentials.ts` `newCredential`:
  the op's input schema, known_hosts lines for the host, the host lower
  case, a key the panel can read, whose public key and fingerprint come
  from the key, never from the file; origin `manual`) or
  `registries.create`'s input schema (`registryLogin`; the login itself is
  not tried, so a registry the panel cannot reach does not stop an
  import); one that does not pass is a `sourceAccess` blocker. Shared
  variables: a file value is taken only when it is one `KEY=value` of
  that variable over the whole line, without syntax problems or
  references (what `env.setShared` takes; anything else is `noValue` with
  a `sharedRefused` warning, so a value cannot carry more lines); missing
  ones are added (`overwrite` replaces ones that differ, `skip` leaves
  them), merged at import into the text stored then, inside the
  transaction (`mergeSharedLines`: a variable someone added since the
  preview stays theirs; the result stays under 256 KiB); every existing
  service a reference reads from is listed (`readsFrom`). The new
  automatic domain takes the old automatic domain's access rules through
  the same checks; when they do not pass or the file left the basic auth
  hashes out, no automatic domain is offered. First-run IP:port access
  opens only for an app whose file had no domains at all (the file does
  not say whether the old one's IP:port was closed, and a skipped domain
  may have been the only way in, behind basic auth or an allow list);
  otherwise an app left without a domain stays closed with an
  `unreachable` warning.
  Defaults: push deploys off, the tunnel off, deploy when ready from the
  file's `stopped`; from the same panel (`manifest.panel.id`) cron jobs,
  uptime checks and backups arrive switched off; channels and backup
  destinations (by name, kind and bucket) are used on the same panel and
  skipped from another one; database listeners open to anyone are skipped.
  Sections the caller may not write here (`env.edit`, `files.write`,
  `domains.edit`, `services.cron`, `services.alerts`, `services.edit`,
  `backups.edit`, `databases.expose`, `tunnels.edit`, `services.update`)
  are left behind and listed.
- `serviceTransfer.import` (fresh sign-in; `passwords` is sensitive and the
  only way basic auth passwords arrive, bcrypt cost 10) refuses while a
  blocker or a `needs` choice is open, then writes everything in one
  transaction (credential from the file, after `assertGitSourceTarget`
  with the caller for every git source, so an admin's internal host is
  recorded like saving the source does; shared variables;
  `services/portable.ts` `materializeService`, the import row to
  `receiving` or `done` with the sealed file wiped). The service is created
  stopped and never deployed (parked on its node); repository webhooks are
  made like the connect ops do (`ensureRepoHook`, `ensureHook`); a new
  deploy trigger URL is answered once. Nothing is left when the
  transaction throws.
- Volume data in an import: importBegin refuses a volume archive no volume
  of the document names (`tampered`), one without `unpackedBytes` or
  claiming more than 1100 times its size plus 16 MiB (`badManifest`). The
  preview lists each volume with its sizes; `choices.volumes` (default: all
  in the file; a database all or none; `files.write`) picks what goes up.
  With data picked: blockers `offline` and `agentTooOld` (the node needs
  `importVolume` and `volume.import-limits.v1`), `databaseLogins` for a
  database whose file left its logins out or whose logins this panel does
  not take (new ones would not open the data; leave the data out instead),
  a `needs` item `confirmData` (`choices.confirmData`) when the data may
  take more than half of what the node last reported free or unpacks to
  more than 200 times its size, a warning when the node may refuse it for
  space, and one that files keep the owners and modes from the file. Each
  picked volume is an entry of the import (`kind: volume`) with
  `volumeImportLimits`: at most `ceil(unpackedBytes * 1.01) + 16 MiB` file
  bytes and `ceil(files * 1.01) + 1000` entries (2,000,000 when not
  counted); the archive goes before the volumes.
- The archive goes up after: `serviceTransfer.uploadTicket { entry, offset }`
  then `PUT /api/transfer/import?t=` with one part of at most 32 MiB
  (`uploadPartBytes`, under Bun's 128 MiB body default and Cloudflare's
  100 MiB): Content-Length required (411), no part past the entry (413),
  the offset must be what the panel has; parts append to
  `<dataDir>/uploads/import-<id>.part`; the last one goes through
  `services/upload.ts` `storeUpload` with the manifest's size and sha256
  (a mismatch keeps nothing and starts the entry over). Each finished or
  failed entry is audited (`serviceTransfer.importData`). When the last
  entry is in the row is `done` and, with deploy when ready, the service
  deploys (at the exported commit when chosen). While a row is `receiving`,
  `queueDeploy`, `services.start` and `boxes.open` refuse the service
  (CONFLICT `reason: importing`, `copies.ts` `activeImport`).
  A volume's parts never land on the panel (`import-data.ts`): the first
  part (offset 0) waits for `desired.settled()` (the node parks the
  stopped service) and opens ImportVolume with `replace`, the manifest's
  sha256 and the limits (`pipeIntoVolume` over a `ChunkFeed`); every part
  goes straight into that stream, which stays open between parts. The
  panel hashes what passes and, at the last byte, compares with the
  manifest before it ends the stream (a mismatch cancels it, BAD_REQUEST
  `reason: checksum`, and the entry starts over); the node checks the same
  hash and empties the volume on any failure. A part cut short keeps what
  reached the node (400, the next part goes on from `received`); 10
  minutes without a part, a panel restart (`start()` sets `received` to 0)
  or a failure on the node start the volume over (`received` 0, `offset`
  refused otherwise). Starting over (a part at offset 0, or one after the
  stream ended) cancels the open stream at once, even while a write waits
  for the node's window, and opens the next one only after the panel's
  side of the old one ended. The agent runs one ImportVolume per volume
  folder at a time (`volumes.Transfer.Import`, `lockVolume`): a second
  stream waits until the first one ended, its emptying of the volume after
  a failure included, so that cleanup never deletes what the second
  unpacks; a waiting stream that is cancelled gives up without touching
  the volume. `discardImport`, deleting the service and the sweep end an
  open stream first. The web app (`?resume=<importId>` on the import
  page) goes on after a closed page once the same file's manifest hashes to
  `manifestSha256`.
- `serviceTransfer.getImport` tells a reloaded page the status and each
  entry's received bytes; `serviceTransfer.discardImport` deletes the row
  and the part file and, only while the row is `receiving`, the service
  (`deleteServiceTree`); a protected service or one with deployments is
  refused there (CONFLICT `reason: protected` or `deployed`). A `failed`
  row's service is the owner's (the sweep told them to upload the code on
  the Source tab) and a `done` one's is in use: both stay. It waits while
  a part is uploading (`reason: uploading`). Only the person who began an
  import goes on with it (`reason: notYours`).
- The hourly `serviceTransfer.sweep`: `ready` exports past 2 minutes lose
  their payload, exports go after 7 days, `previewing` imports at their
  expiry, `receiving` ones 48 h after their last part turn `failed` (the
  service stays, without its archive, and is no longer held back), done
  and failed rows go after 30 days. At start, `streaming` exports are
  marked failed (the panel restarted during the download).
- Limits (`transferLimits`): 200 entries and 1 MiB of central directory
  (the reader), 20 volumes per service, manifest.json 256 KiB, service.json
  2 MiB, secrets.enc 3 MiB, the browser inflates a JSON entry to at most
  4 MiB, the uploaded archive 512 MiB in parts of 32 MiB, a passphrase 12
  to 1024 characters (NFC), one service per file in format version 1, the
  scrypt bounds above, download links 2 minutes, files in review 24 h,
  imports waiting for their archive or data 48 h; volume data: one download
  per service and 3 per panel, 5 minutes without a read, 12 hours stopped,
  10 minutes between upload parts, a confirmation past 200 times its size,
  refused past 1100 times.
- `test/service-transfer-columns.test.ts` lists every column of every
  table with a foreign key to `services` (and the scope-id tables) and
  every key of `ServiceSpecJson` as exported or left out with a reason: a
  migration that adds one fails until someone decides.

`compose.preview` and `templates.preview` are POST mutations (bodies too
large for a query string) that change nothing. Project collapse and order
are per person (`project_prefs`). Hidden projects (0.2.1) are per person
too, in `auth.preferences.hiddenProjectIds` (at most 200 distinct ids;
`modules/auth/profile.ts` keeps only projects that exist and the caller
holds `projects.view` on, on every read and write, so deleted projects and
lost access drop out and the key is left out when nothing is hidden). The
sidebar and the dashboard grid leave them out (`Hidden (N)` and `Show
hidden` show them without unhiding); `projects.list`, the command palette
and the project pages ignore the list. `auth.preferences.showHiddenInSidebar`
(per person, on by default) turns the sidebar's `Hidden (N)` group off; the
panel stores it only as `false` (true, null and non-booleans leave the key
out). `auth.preferences.hiddenSidebarItems` (per person, none by default)
lists main navigation items taken out of that person's sidebar; the panel
keeps only names in `auth.sidebarItems` (dashboard, nodes, templates,
activity, approvals: never settings), each once, drops unknown names
without an error and leaves the key out when none is left. Global
`templates.manage` gates custom templates.

APIs for other modules (all in `apps/panel/src/modules/`):

- `services/volume-pipe.ts`: `readVolume(deps, { nodeId, serviceId, volume })`
  (ExportVolume as a stream) and `pipeIntoVolume(deps, { nodeId, serviceId,
  volume, chunks, sizeBytes?, limits?, kind? })` (ImportVolume with
  `replace`, the limits of data from outside, stops at the node's refusal;
  answers the bytes sent and written) are how every volume copy goes
  through the panel (`move.ts` `relayVolume`, which refuses fewer bytes
  written than read, the export download, the import's parts through a
  `ChunkFeed`). Pipes are listed per panel: `cancelPipesInto` (deleting a
  service), `pipesRunning`. `services/copies.ts`: `activeExport`,
  `assertNoTransfer`, `transfersInFlight`, `latestTransfer`.

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
  `POST /api/hooks/github-repo/<webhook id>` (repository webhooks of the
  connected GitHub account, see "The connected GitHub account"),
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
  `db-ui:<serviceId>` and `box:<serviceId>`; `uid` is the user's id, or
  `key:<api key id>` when an API key opened the tool. Links are
  `https://<slug>-db-<serviceId>.<wildcard>/_<slug>/ticket?t=<token>` and
  `https://<slug>-box-<serviceId>.<wildcard>/_<slug>/ticket?t=<token>`;
  without a wildcard domain on the node the ops answer CONFLICT
  (`details.reason` `noWildcardDomain`). An optional `&to=<path>` (and the
  portgate handoff's target) is followed only when it is a plain absolute
  path on the same host: no control bytes (browsers drop tabs and line
  breaks), no backslash, no `//` (also after decoding), no scheme or host
  (`edge.safeTarget`); anything else redirects to `/`.
- Regenerate certificate (`domains.retryCertificate`,
  `modules/domains/certificate-retry.ts`): a mutation with `domains.edit`
  on the service (an API key needs that action and must not be read-only,
  as MCP tokens are by default; `mcp: true`, a mutation and never
  destructive, so models need no approval), audited, refusals included. Only `https: acme` domains whose certificate is
  pending or failed (CONFLICT `reason` `notAcme`, `certificateValid`). Once
  a minute per domain, in memory (RATE_LIMITED `reason: certificateRetry`
  with `retryAfter`; a refused try does not start the minute). The minute
  is taken before the DNS lookup and the agent calls and given back when
  the try fails, so requests sent together make one retry. DNS is
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
  `tunnels.expire`, `domains.recheckWaiting`, `databases.retirements`; restores run as the `backups.restore` job (one
  attempt). Backup results come from durable `BackupResult` events;
  `backup_id` is the policy id, or `manual` for one-off runs (kept until
  deleted). A result's `object_key` must name that run's object,
  `[<prefix>/]<service id>/<backup id>/<UTC time>-<run id><ext>` with one
  of the agent's extensions (`ownObjectKey` in `modules/backups/runs.ts`;
  the prefix is not compared, it may have been edited): any other key
  fails the run, and a key recorded earlier that does not match is never
  restored (the restore fails) or deleted from the bucket (`deleteRun`
  only drops the row). `RunBackup` and `RestoreBackup` carry the
  destination without its keys and `signing_id` (the run's id, the
  restore's id for a restore), only to agents that advertised
  `backup.signed.v1`; any other agent's run fails with "too old for
  backups" (CONFLICT `agentTooOld`). The node asks
  `PanelService.SignBackupRequests` (`modules/backups/signing.ts`) for each
  S3 step: for a running backup on the node it ran on, presigned (1 hour,
  SigV4 query auth, `modules/backups/presign.ts`) PUT, UploadPart and
  DELETE URLs of the run's own object, and the multipart create, complete
  and abort steps, which the panel makes itself with header signing (R2
  takes no presigned POST); for a running restore on the service's node,
  the GET of the restored object. Anything else refuses the whole call
  (PERMISSION_DENIED); at most 32 steps and 1 MiB per call, 600 calls burst
  and 50 per second per node. `keep_last` is always 0 for such agents:
  after a policy run succeeds, and when its keepLast changes, the
  `backups.prune` job (3 attempts) lists the policy's folder with the
  panel's keys and deletes the objects past keepLast, newest kept by the
  time in the key, only names the agent writes, never in sub-folders.
- Database engines (`modules/databases/engines.ts`, listed by the
  `databases.engines` op): Postgres 18 (default, data at
  `/var/lib/postgresql`), 17, 16, 15 and the `pgvector` variant of each
  (`databases.create { variant: "pgvector" }`, `service_databases.variant`,
  `pgvector/pgvector:0.8.7-pg<major>-trixie`), MySQL, MariaDB, MongoDB
  9.0/8.0/7.0, Redis, Valkey 9.1/9.0/8.1, KeyDB 6.3, Dragonfly 2.0 and
  ClickHouse 26.8/26.3, every image pinned to an exact release (KeyDB by
  digest). MariaDB containers get `MARIADB_AUTO_UPGRADE=1`, so the first
  start of a newer version upgrades the system tables (existing MariaDB
  databases get it with their next deploy: the env is the deployment's
  snapshot).
  KeyDB carries `notice` in `databases.engines` (unmaintained, no security
  fixes, prefer Valkey) and `exposureNeedsAllowlist`: `setExposure` refuses
  it without `allowedCidrs` and `exposure.needsAllowedCidrs` tells the web
  app to ask for them first.
  Valkey and KeyDB start through their image's entrypoint (non-root) with
  `--requirepass "$<ENGINE>_PASSWORD" --appendonly yes`; Dragonfly takes
  `DFLY_requirepass` from the environment; ClickHouse gets a generated admin
  user (`ch_` + 10 characters) from `CLICKHOUSE_USER`/`_PASSWORD`/`_DB`
  with `CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1` (so it can manage users
  with SQL: the agent retires the old exposed user), and its health check reads `/ping` on the container's own
  address (the first start serves 127.0.0.1 only). Mongo's health check is
  TCP on its port (`healthProbe`), not mongosh: that is a Node.js program
  (about 0.2 s of CPU and a 265 MB process inside the container on every
  probe, measured with `mongo:8.0`); migration 0003 moves databases still on
  the mongosh default, in the service and its deployments' run settings,
  and leaves changed checks alone. ClickHouse adds
  `INTERNAL_HTTP_URL` (`http://user:password@<name>:8123/<db>`, a
  credential) and `INTERNAL_HTTP_PORT` to the references; exposed URLs
  carry `secure=true` (and `skip_verify=true` with a self-signed
  certificate). The Redis-like engines have one user (`default`), used over
  TLS when exposed.
- The exposed port's certificate (`databases.get exposure`,
  `modules/databases/certificate.ts` `exposureCertificate`, from the
  node's `OpenPort.certificate_*`): `certificate` is "selfSigned" without
  `tlsHostname` and for MariaDB (it serves its own whatever the host name
  says); with one, "pending" until the node reports a certificate that is
  not self-signed and has not expired ("valid"), and "failed" while the
  node reports the self-signed fallback with an ACME error (0.2.12; a
  self-signed Mongo or Redis port with a host name used to read "valid":
  its issuer is its own name and it lasts ten years). Since 0.2.12
  `selfSignedReason` says why an open port serves a self-signed one:
  "noHostname", "acmeMissing" (only once a node from 0.2.12 reports its
  fallback, with `certificateError` the node's last ACME error for the
  host, null while it knows none) or "engine" (MariaDB); null for an ACME
  certificate and for a closed port. `certificatePem` is the fallback's
  PEM as the node reports it (public), null unless it is a whole
  certificate (`servedPem`). Clients that check certificates refuse a
  self-signed one: node-postgres reads `sslmode=require` as full
  verification (libpq does not verify for require), so its EXPOSED_URL
  from a database without an ACME certificate fails until it adds
  `sslmode=no-verify` (or `uselibpqcompat=true&sslmode=require`) or trusts
  the downloaded file. The Connection tab's Exposed card says so
  (`self-signed-note.tsx`, i18n `serviceDatabase.selfSigned`): what it
  means, the reason with the ACME error, how to get a trusted one (a TLS
  host name under Port and access, an A record to the node set to DNS
  only, port 80 reaching the node; not for MariaDB), the client settings
  that connect meanwhile per engine (Postgres as above, psql/libpq fine
  with require; MySQL and MariaDB `ssl-mode=REQUIRED`, which does not
  verify; Mongo and ClickHouse URLs that already carry
  `tlsAllowInvalidCertificates`/`skip_verify` without a host name, or the
  parameter to add with one; redis-cli `--insecure` or `--cacert`), and
  "Download certificate" (`<service>.crt`) when the node reported the PEM,
  with how to trust it: with a TLS host name the file names that host, so
  any client trusts it by that name (sslrootcert, ssl-ca, tlsCAFile);
  without one it names no host, so only clients that skip the name check
  connect with it, said per engine (Postgres `sslmode=verify-ca` with
  `sslrootcert`, node-postgres with `uselibpqcompat=true` too; MySQL
  `ssl-mode=VERIFY_CA`; Mongo `tlsCAFile` with
  `tlsAllowInvalidHostnames=true`; otherwise a client that does not check
  the host name). The issuer is left out of the certificate line while it
  is self-signed (it is its own name).
- Exposure uses the database's own credentials (0.2.9): the exposed
  connection (`databases.connection .exposed`, `databases.get
  exposure.user`, the `EXPOSED_URL` reference) has the same user and
  password as the internal one, for every engine, over TLS only; exposing
  opens the port and changes nothing inside the database. New rows have
  `service_databases.exposed_user` "" and no `exposed_password` secret.
  Databases from before 0.2.9 keep `exposed_user` ("external", or
  "default" for the Redis-like engines) and their `exposed_password`,
  which nothing reads: the desired state names the user in
  `DatabaseSpec.retired_exposed_user` (not for the Redis-like engines,
  never the admin user) and the agent disables it once per node. A
  deployment's env is sealed when it starts, so a service that used
  `${{db.EXPOSED_URL}}` runs the old user's URL until it deploys again:
  `databases/retire.ts` names the user only once no live or target
  deployment's env holds `exposed_password` (as it is or percent-encoded;
  one scan per compile, `CompileMemo`), a stopped service's too:
  `services.start`, a clone's data copy, an undone move and boxes start
  one again with the env it deployed with. The compile remembers the
  databases it held back, in memory, and `releaseHeldRetirements` checks
  them again and marks the ones nothing holds any more dirty, once each:
  when a deployment goes live (`watchRetirements`, `onDeploymentChange`)
  or a service is deleted (`deleteServiceTree`), in any project, and
  every 60 s (`databases.retirements`), which reads nothing while none is
  held back. A version without TLS (`EngineVersion.noExposure`,
  MariaDB 10.11) is never exposed: `setExposure` refuses it (CONFLICT
  `noTls`) and `loadDatabase` reads an exposure row from before 0.2.9 as
  closed.
  `services.clone` never copies `exposed_password` and keeps
  `exposed_user` only with copied data (the old user is in it); a service
  export carries its name only, and an import keeps it only with the data
  (see Service export and import). Postgres,
  MySQL and MariaDB exposure needs `database.exposure.v2` on the node
  (`capability.ts` `missingExposureCapability`, `Engine.exposureNeedsCapability`):
  `setExposure` refuses it elsewhere (`agentTooOld`) and the desired state
  sends `{ enabled: false }` there, so an exposed database on a node that
  was not updated is closed until its agent is. The readers say the same
  (`loadDatabase` `exposureWaitsFor`, the same check on the node's stored
  facts): `databases.get` has `exposure.state` `waitingForNodeUpdate` with
  `enabled` true and no host or port, `databases.connection .exposed` and
  `exposures.get .database` are null, and `EXPOSED_URL`, `EXPOSED_HOST`
  and `EXPOSED_PORT` resolve empty (env.analyze: `empty-reference`; a
  running service keeps the env it was sealed with until it deploys
  again). The row is kept, so the port opens with the node's sync once it
  is updated; the Connection tab says "Closed until <node> updates", and
  when the node's facts change (its updated agent connects) open screens
  of the databases exposed there read `databases.get`,
  `databases.connection`, `exposures.get` and `env.references` again
  (`capability.ts` `watchExposureCapabilities`).
- Databases and Boxes are created with `insertService` and `queueDeploy`.
  Credentials live in `service_secrets` (`admin_password`, purpose
  `service.secret`; `exposed_password` only in databases from before
  0.2.9, unused); password resets run in the database through the agent's
  `Exec` with the password on stdin. `databases.resetPassword` changes the
  one password for `user` "internal" and "exposed" alike (the latter kept
  for API compatibility) and lists the services whose env references
  `PASSWORD`, `INTERNAL_URL`, `INTERNAL_HTTP_URL` or `EXPOSED_URL`.
  MySQL and MariaDB give root the admin's password, also for an admin
  other than root (`containerEnv` sets `rootPasswordVariable`,
  `MYSQL_ROOT_PASSWORD` or `MARIADB_ROOT_PASSWORD`, to it), and since
  0.2.11 a reset keeps them equal (`changePasswordExec`, script
  `mysqlPasswordScript`; before, an admin other than root got the new
  password and root kept the old one, so root sign-ins with the
  container's root password failed with ERROR 1045 after the next
  deploy). Root signs in on the socket with `MYSQL_PWD` (never an
  argument; the SQL goes on the client's stdin through the shell's
  `printf`), first with the container's root password, then with the
  admin's current one (stdin's first line; the container keeps the old
  environment until its next deploy), and changes the admin's account,
  then `ALTER USER IF EXISTS 'root'@'%'` and `'root'@'localhost'` (for root
  as the admin, both of root's in one go). When root cannot sign in
  either way (ERROR 1045: a reset before 0.2.11, or a change by hand), an
  admin other than root signs in over TCP and changes its own password
  (MySQL `ALTER USER USER()`, MariaDB `SET PASSWORD = PASSWORD(...)`);
  that, or root's change failing after the admin's, prints
  `rootUnchangedMarker` with exit 0, and `resetPassword` stores the new
  password and returns `warning`: root kept an older password the panel
  does not know, and how to set it by hand. `warning` is null otherwise.
  Any other failure (the server down) refuses with `execFailed` and
  stores nothing. Tested with the script under sh and dash against a fake
  client (`database-password.test.ts`) and on MySQL 8.4 and MariaDB 11.8
  in the VM (`TestITPasswordResetKeepsRoot`: reset, redeploy, root with
  the container's password and the admin with the new one; two resets
  before a deploy; MySQL's mysql_native_password check between a reset
  and its deploy; an out-of-step database), not yet through a real
  panel. Since 0.2.12 a reset is `users.ts` `changeMainPassword`, shared
  with `databases.setUserPassword` on the main user, one at a time per
  database (`withUserLock`): Postgres and MongoDB sign in with the stored
  login (`user-scripts.ts` `mainPasswordExec`; `changePasswordExec` is
  null for them now), not the container's first one, which the container
  keeps until its next deploy (MongoDB's `-p "$MONGO_INITDB_ROOT_PASSWORD"`
  failed a second reset before a deploy; Postgres signed in as
  `$POSTGRES_USER`), and Postgres gets a SCRAM verifier, not the password.
  ClickHouse and Dragonfly stored a new password without anything
  restarting them (the env is sealed per deployment, so the container
  kept the old one), and Redis, Valkey and KeyDB changed theirs with
  `CONFIG SET` only, which a restart undid: these now queue a deploy
  (`deploymentId` in the output; services.deploy, else FORBIDDEN before
  anything changes). A stopped database is refused (`notRunning`): that
  deploy would start it, and storing the password alone would not do,
  since `services.start` brings the container back with the sealed env
  of its last deploy (the old password).
- Database users (`modules/databases/users.ts`, `user-scripts.ts`,
  0.2.12): the Users tab. Seylo keeps no table of users: `databases.users`
  reads them from the running engine through `Exec` (no agent change)
  and Seylo still stores only the main user (`admin_user`,
  `admin_password`), the one the shell, web UI, backups, TLS jobs, env
  built-ins and URLs use. Every script follows one protocol: stdin line 1
  is the stored main password (moved into the client's env by the
  script, never argv), the rest is SQL or JavaScript; names are quoted by
  `pgIdent`/`pgLiteral`, `mysqlString`/`mysqlAccount` (database-level
  grants escape `_` and `%`, `mysqlGrantDatabase`), `chIdent`/`chString`
  and JSON for mongosh; listed names with control characters or
  backslashes are shown read only (`manageableName`). List output is one
  JSON object a line (mongosh's prompt before the first one is skipped);
  at most 500 users. Sign-in: Postgres as the main user on the trusted
  socket (`psql -X -At -v ON_ERROR_STOP=1`, `PGPASSWORD` for a pg_hba
  edited by hand); MySQL and MariaDB as root on the socket with the
  container's root password, then the main user's, then (root as the
  main user) root@% over TCP, an optional second SQL line whose output
  runs with `--force` (a deleted account's `KILL`s); MongoDB as the main
  user inside the script (`admin.auth`, `quit(code)` at the end);
  ClickHouse as the container's own `CLICKHOUSE_USER` (the image makes it
  from the env at every start). Exit `signInFailedCode` (10) when the
  engine refused the sign-in: `signIn: "failed"`, or for MySQL with only
  the main user signing in over TCP (root out of step) that user alone
  and nothing else changes. `signIn: "offline"` (stopped, not placed,
  node away) lists the stored main user only. Presets: `readOnly`,
  `readWrite`, `databaseAdmin` (not Postgres), `serverAdmin`; Postgres
  uses `pg_read_all_data`/`pg_write_all_data` (every database of the
  server; only from 14, else serverAdmin only) plus CONNECT, CREATE and
  `public`'s USAGE, CREATE for readWrite; MySQL grants on the database
  (readWrite without GRANT OPTION, routines or events), MongoDB `read`,
  `readWrite`, `dbOwner` and `root@admin`, ClickHouse grants on the
  database and `GRANT CURRENT GRANTS ON *.*` for serverAdmin (the image's
  user lacks a few privileges of ALL). Postgres passwords go as SCRAM
  verifiers (`scramVerifier`, RFC 7677 vectors in the tests), so a failed
  statement in the container's log holds none. Renames: Postgres keeps
  ownership and grants, an md5 password is cleared so one is needed
  (`renameNeedsPassword`); the main user is the session user, renamed
  through a temporary `SUPERUSER NOLOGIN` role that takes the session
  (`SET SESSION AUTHORIZATION`) in one transaction, and the database
  restarts so its health check has the new `POSTGRES_USER` (`deploy:
  false` skips it). MySQL and MariaDB `RENAME USER` (host too), refused
  while views, routines, triggers or events have it as DEFINER unless
  `acceptOrphanDefiners`; the main user in place unless it is root.
  MongoDB has no rename: a new user with the same roles and a new
  password, then the old one goes; its main user and MySQL's root
  refuse with `useSwitchMainUser`. ClickHouse SQL users `ALTER USER
  RENAME`; its main user is stored and the database restarts (refused
  when a SQL user has the name, or while it is stopped). Deletes keep the data: Postgres refuses
  an owner (`ownsObjects`, details.count) unless `reassignOwned`, then in
  every database that takes connections `REASSIGN OWNED BY` to the main
  user and `DROP OWNED BY` (grants only by then), and drops the role.
  Before the first REASSIGN the role gets `NOLOGIN`, its sessions are
  ended and a `DO` block waits up to 5 s for them to be gone
  (`pg_stat_clear_snapshot` each look, the name through the setting
  `seylo.target`, never inside the dollar quotes), else the script
  fails: a session still alive could make a table between REASSIGN and
  DROP OWNED, which DROP OWNED would drop with its rows. The script is
  not one transaction (`\connect`), so a failure says the user may no
  longer sign in and what it owned may already have moved (VM-tested
  with a live session of the user). Never the main user (`mainUser`),
  Postgres's bootstrap role or MySQL's root@localhost (`systemUser`),
  MongoDB's last user with root (`lastAdmin`).
  `databases.switchMainUser` (Postgres, MySQL, MariaDB, MongoDB): a new
  user with full rights, or an existing one (never a locked one,
  `locked`; `can.makeMain` false) with a new password, proved by signing
  in as it the way the tools do (`proofExec`: Postgres over the
  container's own address, where the image checks passwords; MySQL over
  TCP; MongoDB `auth`), then given full rights when it lacks them
  (`grantAdmin`, else `notAdmin`; `grantAdminExec` runs after the proof,
  so a failed proof leaves no rights behind) before anything is stored;
  a user made for it is dropped again when a step fails, and an existing
  one keeps its new password, which the error says. Then the new main
  user is stored at once; MySQL and MariaDB give root the new password
  (root always has the main user's, `containerEnv`) and drop the old main
  user with `oldUser: delete` (root: root@% only), refused like a delete
  while objects have it as DEFINER unless `acceptOrphanDefiners`. Main
  user changes store `admin_user`/`admin_password` after the engine took
  them, mark the service dirty (agent tools follow at once) and list
  `affectedServiceIds` from env references to `USER`, `PASSWORD` and the
  URLs (`servicesUsing`). An Exec of a main user change that gets no
  answer (the node went away, the 75 s timeout: `runExecOrLost`) is not
  taken as a failure: a rename or a password change is stored when Seylo
  signs in with the new name or password (`proofExec`, a warning says
  so), else `UNAVAILABLE` `noAnswer` with nothing stored; a step after the
  store (root's password, the old main user) is a warning; a switch step
  before it removes a user made for it. Every change refuses while a
  deploy of the database runs or it is stopped (`deployRunning`,
  `notRunning`, `noNode`); all six need `databases.credentials`; the four destructive
  ones wait for a person's approval for MCP and AI callers; passwords are
  `sensitive` and nothing an engine prints is logged (exit codes only) or
  shown unscrubbed (`scrub`). Postgres restores run `pg_restore
  --single-transaction` (Go `backup/engines.go`): a dump that names a
  role renamed or deleted since fails with nothing changed (before, it
  stopped after the drops: VM-tested both ways); a schema too large for
  `max_locks_per_transaction` needs that raised. Tested: the scripts
  under sh and dash against fake clients and mongosh's JavaScript
  against a fake db (`database-users-scripts.test.ts`), the ops against
  a fake agent (`database-users.test.ts`), and on the real images of
  Postgres 18, MySQL 8.4, MariaDB 11.8, MongoDB 9.0 and ClickHouse 26.8
  (`go/internal/backup` `TestDatabaseUsers`, the panel's own scripts from
  `testdata/database-users.json`, which `database-users-vm.test.ts` keeps
  equal to what the panel builds and whose recorded list outputs it
  parses): every preset's rights with the engine's own client, password,
  rename and delete, the main password twice before a deploy, the main
  name in place, by a switch or a restart, then after a redeploy the
  shell, a backup and its restore as the new main user. Not yet through a
  real panel.
- Version changes (`modules/databases/version.ts`, 0.2.9):
  `databases.versionChoices` lists the catalog lines of the database's
  engine and variant with `kind` (current, patch, upgrade, major,
  downgrade), `allowed`, `reason` (a refusal: only `current` since
  0.2.11), `risk` (what setVersion needs `acceptRisk` for, 0.2.11),
  `risks` (every risk it takes, the most serious first, 0.2.11) and
  `message`, plus `blocked` (noNode, stopped, deployRunning),
  `pendingImage`, the newest successful database backup, and (0.2.11)
  `release` (the release the running image's tag names, null for latest
  or a digest), `repository` and `anyImage`. `databases.setVersion`
  (destructive, `services.deploy`, so MCP and AI callers need approval)
  writes `service_databases.version` and the spec's image (the variant
  stays) and queues a deploy (recreate on the same volume). The rules are
  one pure function, `judgeVersion`: the same line with a newer pinned
  image is a patch (no backup needed), an older image or line is refused
  for every engine, Postgres and pgvector never change major (dump and
  restore into a new database), MongoDB, MariaDB and MySQL go one line up
  at a time, Redis, Valkey and ClickHouse any newer line, KeyDB and
  Dragonfly patches only, and a line whose data folder differs is
  refused. Since 0.2.11 `judgeImage` wraps it for any image of the
  engine's repository: only the very image that runs stays a refusal
  (`current`, "nothing to change"; `judge` lets it through when only
  MySQL 8.4's `keepNativePassword` changes, below), and every other refusal becomes a
  risk (`downgrade`, `olderImage`, `postgresMajor`, `dataPath`,
  `patchOnly`, `oneStep`), joined by `otherLine` (either side a line the
  catalog does not have: not tested by Seylo, and `oneStep` says nothing
  then), `postgresBase` (another base system than the running image's:
  `baseOfTag`, Alpine's own version left out), `floatingTag` (a tag
  without an exact release, as the target or as what runs: the release
  behind it is unknown and can change on the next deploy; on the same
  line no releases are compared) and `digest` (a target with a digest, or
  a running image known by a digest only); a tag that names no release
  (`custom`) is judged against nothing but those. `risk` is the most
  serious one (`riskOrder`); the message says each of them, the MongoDB
  compatibility note for a MongoDB move, and that a new version that
  never gets healthy brings the old container back. It names what a tag
  is, in the words that refused a tag of another line before (`notOfLine`,
  which imports' `customImage` still uses): a line outside the catalog,
  the target's or the one that runs, as "mongo:8.2.12 is MongoDB 8.2.
  Seylo does not offer MongoDB 8.2, so this change is not tested by
  Seylo." ("with pgvector" for that variant), and a floating tag as "not
  an exact release: it moves to each new MongoDB 8.2 release" ("a tag
  without a full release number moves to each new release" for latest and
  pgvector's tags). Without `acceptRisk`
  such a change is refused (CONFLICT `riskNotAccepted`, nothing changed;
  `details.risk`, `details.risks` comma-separated, `details.message`,
  `details.version` and `details.image` as it would be recorded, and
  `details.backupRequired` "true" when the backup step would refuse it
  next); with it, it proceeds, and the deploy's log says `Risk accepted:
  <risks>`. The hard refusals stay hard with `acceptRisk`: another
  repository (BAD_REQUEST `customImage`, field `image`), `noNode`,
  `stopped`, `deployRunning` and `current` (but for `keepNativePassword`
  alone). Rules judge from what runs: the
  live deployment's image (so after a failed change the old image may be
  set again and the change retried). Every change but a newer patch of the
  line that runs (another line, or any risk taken) needs a backup run
  that succeeded in the last 24 hours (object not deleted) or
  `confirmNoBackup` (reason `backupRequired`). Before a MongoDB line
  change that takes no risk (a one-step upgrade between catalog lines) the
  panel runs `setFeatureCompatibilityVersion` to the running
  line through `Exec` (`mongoFcvExec`: the admin signs in inside the
  script on stdin; `quit()` gives the exit code), and refuses with
  `fcvFailed` without changing anything when it fails; other MongoDB
  moves (0.2.11) get no step, and MongoDB refuses data whose
  compatibility version it does not support, which the risk message says.
  Since 0.2.11 the account list below also runs for every change to a
  MySQL line from 8.4 on that the catalog does not have (9.0 removed the
  plugin; a tag without a release counts as one), from a line before 8.4,
  one run with the plugin on, or a running image whose tag names no
  release (`mysql:8` pulled while it was 8.0 may be such a line)
  (`nativePasswordCheckNeeded`); for a line
  without `nativePasswordOption` the refusal names only switching the
  accounts (`nativePasswordGoneRefusal`, the same reason and details), and
  `keepNativePassword` is a BAD_REQUEST there as on other lines. MySQL 8.4 ships the
  mysql_native_password plugin off (0.2.11): accounts made with it (older
  apps, users made by hand) cannot sign in there, while the data is fine.
  Before a change from 8.0 to 8.4 the panel lists the running 8.0's
  accounts whose plugin is mysql_native_password, MySQL's own (mysql.sys,
  mysql.session, mysql.infoschema) left out, through `Exec`
  (`mysqlNativeUsersExec`: root signs in on the socket with `MYSQL_PWD`,
  like `changePasswordExec`, first with the container's
  `MYSQL_ROOT_PASSWORD`, then with the admin's stored password, since an
  admin other than root has rights on its own database only and cannot
  read `mysql.user`, and a password reset gives root the admin's new
  password while the container keeps the old environment until its next
  deploy; only when root's sign-in is refused both ways (ERROR 1045) does
  the admin sign in over TCP, the shell's `read` taking its password from
  stdin's first line, never an argument; the query follows on stdin; a
  database whose root a reset before 0.2.11 left out of step fails the
  check until root has the admin's password, as the reset's `warning`
  says). A
  failed list refuses with `nativePasswordCheckFailed`, any account with
  `nativePasswordUsers` (`details.accounts`: at most 10 user@host, one a
  line; `details.count`; the message names them, "and N more", and the
  two ways out: `ALTER USER ... IDENTIFIED WITH caching_sha2_password BY
  '...'`, which needs each password, or keeping the plugin on); either
  way nothing changes. `keepNativePassword: true` (MySQL lines with
  `nativePasswordOption`, 8.4; BAD_REQUEST elsewhere) skips the list and
  runs 8.4 with `mysqld
  --mysql-native-password=ON` through the image's entrypoint: the spec's
  container command (`containerCommand(engine, { nativePassword })`,
  `withNativePassword` for a mysqld command set by hand, CONFLICT
  `customCommand` for one that is not mysqld's), so every later deploy,
  rollback and clone keeps it, and so do patch updates of 8.4, which leave
  the command alone unless `keepNativePassword` is given; `false` takes
  it out again after the same list on the running 8.4. A line without the
  option (8.0, staying on it after a failed change) runs without it. New
  databases and other engines never get it; an import keeps it only from
  a file whose MySQL 8.4 ran with it (see Service export and import). On
  the image that runs, `keepNativePassword` that changes the option is a
  change of its own (0.2.11): not refused as `current`, it writes the
  command alone and deploys the same image again (off after the same
  list), with the deploy note "mysql_native_password logins on
  (--mysql-native-password=ON), on the image it runs (<image>)." (or
  "off") and no "Version change" line, no risk to accept and no backup
  step, also when the image that runs is a floating tag (`mysql:8.4`) or
  a release the catalog does not pin, sent as `image` alone or with
  `version`; the same image with the option as it is stays `current`,
  `acceptRisk` or not. `versionChoices.nativePassword` is null for other engines
  and `{ on, lines }` for MySQL; the Version card shows "Old
  mysql_native_password logins are on" and, on a line in `lines`, the
  switch "Keep old mysql_native_password logins working" with Apply
  (disabled while `blocked` or `pendingImage`), whose dialog ("Turn old
  mysql_native_password logins on?" or "off?", Update) sends the version
  it runs, its image only when it is not the catalog's, and
  `keepNativePassword`, and shows a `nativePasswordUsers` refusal's
  accounts; a version change's confirm dialog shows a
  `nativePasswordUsers` refusal with the accounts and the checkbox "Keep
  mysql_native_password logins working in 8.4" (after a
  `nativePasswordCheckFailed` too, and checked for patch updates while it
  is on). A stopped database
  is refused (the deploy would start it). `image` (0.2.11; `version` is
  then not needed and not used) takes any tag or digest of the engine's
  own repository (`modules/databases/images.ts` `engineRepository`:
  `mongo`, `postgres` or `pgvector/pgvector` for that variant, `mysql`,
  `mariadb`, `redis`, `valkey/valkey`, `clickhouse/clickhouse-server`,
  `eqalpha/keydb`, `ghcr.io/dragonflydb/dragonfly`), with or without
  `docker.io/` (and `library/`), stored without them, a bare repository
  as `:latest`. Another repository is refused (`customImage`): the
  panel's env, data path, health check and command are made for the
  engine's image. `engineImage` reads the tag: the line recorded in
  `service_databases.version` is the catalog's for a catalog image, else
  major.minor of the tag's release ("8.2" of `mongo:8.2.12`; ClickHouse
  26.8 of 26.8.36.3; KeyDB's `x86_64_v6.3.4` is 6.3), Postgres its major
  from 10 on ("17", "9.6" before), pgvector the `-pgN` of its tag, and
  `custom` when the tag names none (latest, a digest, `mongo:8`). A tag
  floats unless it names an exact release (Postgres 17.6, ClickHouse four
  numbers, pgvector `<x.y.z>-pgN`, the others three) or a digest pins it.
  An import with the data keeps the image the file ran when it is of
  the engine's repository and recorded as the same line, and this
  panel's image could read the data differently: a newer release, a tag
  that floats or a digest whose release does not show, or another
  Postgres base system (`keptRanImage`, 0.2.11; before, only an exact
  release tag of the line on the catalog's base, through `customImage`,
  and the data of the others was refused); an older release on the same
  base starts on the catalog's newer patch.
  Every reader of `service_databases.version` takes a line the catalog
  does not have: `dataPathOf` gives the volume path (the catalog line's,
  else the engine's own; Postgres before 18 `/var/lib/postgresql/data`,
  18, later and `custom` `/var/lib/postgresql`), `exposureRefusal` goes
  by the newest catalog line not newer than it (else the oldest, so
  MariaDB 10.6 and 11.2 are not exposed; `custom` by none),
  `databaseRuntime` sends it as the agent's `DatabaseSpec.version`
  (display only), clones copy it, and an import of such a database
  (`importedVersion`) starts on the image the file ran when that image
  is of the engine's repository and names the same line. `databases.create`
  takes the same `image` (0.2.11): any image of the engine's repository,
  the line recorded the same way, the volume at `dataPathOf`; a Postgres
  image whose tag names no release also gets `PGDATA=/var/lib/postgresql/docker`
  in its own variables (`createdPgdata`, with a comment saying why), so an
  image older than 18 keeps its data on the volume. `databases.setVersion`
  pins `PGDATA` before a Postgres move to another line, or from or to a
  tag without a release, on a volume at `/var/lib/postgresql` whose
  variables set none (`needsPgdataPin`): `/var/lib/postgresql/<major>/docker`
  of the line that runs from 18 on, else what the running container's
  `$PGDATA` says (an exec; CONFLICT `pgdataFailed`, nothing changed, when
  it cannot be read). The deploy's log says `PGDATA set to <folder>`; a
  `PGDATA` set by hand stays. The same image that runs is refused as
  `current` whatever line it is recorded as (`custom` does not compare,
  so before this a database on latest could be "upgraded" to latest). The Version
  card offers the catalog lines (the running one left out, a risky one
  with a short note in the select) and "Use another image" (while
  `anyImage` and not blocked), which opens the confirm dialog on an image
  field starting from the image that runs ("The database runs ...: give
  the image to run instead" until it changes; after a failed change,
  `pendingImage`, that image is the way to stay on it). A risk shows as
  "What can go wrong" with one line for each risk (a catalog choice's
  `risks`, every risk it takes, 0.2.11; `riskWords` in the web names the
  tag like the panel's message: "Not tested by Seylo: mongo:8.2.12 is
  MongoDB 8.2, which Seylo does not offer", the target's line or else the
  one that runs, and "mongo:8.2 is not an exact release: it moves to each
  new MongoDB 8.2 release", or that what runs is not one), the MongoDB note for a
  MongoDB move, and that the old container comes back, and "I understand",
  which sends `acceptRisk`; for another image the dialog learns the risks
  from the `riskNotAccepted` answer (and the backup step from
  `details.backupRequired` or `backupRequired`), and forgets them when the
  image changes. Until the panel answers, the dialog reads the line of the
  typed image's tag as `engineImage` does (`imageLine` in the web), so a
  change of line shows the backup step at once, MySQL 8.4's account check
  note and "Keep mysql_native_password logins working" follow that line
  (`keepNativePassword` is never sent for a line without the option), and
  MongoDB's compatibility note shows only for a catalog line whose choice
  takes no risk. The New database form's "Use another image" (under
  Version, starting from the picked version's image) says "Not tested by
  Seylo", and for a floating tag that it can change on the next deploy.
  The header chip and the card say "MongoDB 8.2", or "MongoDB
  (mongo:latest)" for `custom`. `versionChoices.customOnCurrent` is
  deprecated (0.2.11): it is `anyImage` while not blocked.
  `deployments.rollback` of a database takes only a
  deployment of the image it runs (CONFLICT, reason `databaseVersion`):
  the deployments from before a version change ran the older version.
  That stays so with any image (0.2.11): `acceptRisk` is for
  `databases.setVersion` only, and a rollback across images is not offered
  or taken. The same image means the same reference and the same pulled
  digest (`sameDatabaseImage`, deployments/store.ts): a rollback pins the
  deployment's digest, so an earlier deployment of a floating tag
  (`mongo:latest`, `postgres:17`) that pulled an older release is not
  offered either (a digest recorded on one side only counts as different). `deployments.list` and `deployments.get` say `canRollback: false` for
  those (0.2.11; before, they were offered and then refused). The
  web app's Version card is on the database's Settings tab; the header's
  version chip links to it (`#version`).
- DNS checks use public resolvers (1.1.1.1, 8.8.8.8);
  `domains/dns.ts` `setDnsLookups` swaps them in tests.
- Origin check (`modules/domains/origin.ts`): for a custom domain (not
  automatic, not redirect-only) whose DNS is ok or proxied, the panel
  fetches `http://<host>/.well-known/<slug>-origin/<challenge>` (24 random
  bytes, base64url) through the public network, 6 s for everything,
  following up to 3 redirects only to http(s) on the same host, default
  port and path (Always Use HTTPS), reads at most 1 KiB, and verifies the
  signature against the stored keys of the service's nodes
  (`agent-hub/signature.ts` `verifyEd25519`; the shared vector is in
  `go/internal/edge/origin_test.go` and `test/domain-origin.test.ts`).
  `node`: a node's key signed. `elsewhere`: an answer below 500 without
  the proof while every node of the service advertised
  `routing.origin-proof.v1`, is online and reported the domain's route.
  `unknown`: no node with the capability (nothing is fetched), a network
  error, timeout, 5xx (Cloudflare's 52x), a redirect off the host or path,
  or a node that may have answered without the proof. When the last answer
  came from Cloudflare itself (a `cf-ray` or `server: cloudflare` header)
  the check also says why it did not reach the node (0.2.12,
  `OriginReason`, `cloudflareReason`): `cloudflareCertificate` for 525/526
  (SSL/TLS Full (strict) refuses the node's temporary certificate, Traefik's
  default one, until Let's Encrypt issues the domain's), `cloudflareUnreachable`
  for 521/522 (Cloudflare cannot connect to the node on 443 or 80),
  `cloudflareChallenge` for a challenge page (a `cf-mitigated` header,
  whatever the status) or a 403 or 429 from Cloudflare (its security in
  the node's place: Bot Fight Mode, Under Attack mode, a WAF or rate
  limiting rule, which may pass one request and stop the next and stop
  Let's Encrypt the same way; always `unknown`, never `elsewhere`, since
  the request may not have left Cloudflare; before, the 403 page read as
  another server answering), `notFound` for 404 (with `unknown` or
  `elsewhere`); any other answer gives none. `Domain.originReason` (while `origin` is listed) and
  `DnsCheck.originReason` carry it; the panel keeps it in memory per
  domain id (`lastOriginReason`, set and cleared with every stored origin,
  dropped for `node`), so after a restart it is absent until the next
  check (no column, no migration). Stored in
  `domains.origin_status`/`origin_checked_at` (migration
  `0007_domain_origin`), cleared when DNS leaves ok/proxied, and an
  `elsewhere` is cleared when an ACME route turns ACTIVE (Let's Encrypt
  reached a node). `Domain.origin`/`originCheckedAt` are set only while
  DNS is ok or proxied; `DnsCheck.origin` only from `domains.checkDns`.
  Runs in `domains.checkDns`, and 5 s after `domains.add` as the
  `domains.checkOrigin` job (one attempt; while an online node with the
  capability has not reported the route it enqueues itself again 10 s
  later, 4 tries, storing nothing meanwhile). `setOriginFetch` swaps the
  fetch in tests. The web's Domains row asks `domains.checkDns` while a
  certificate is generating and the origin is not `node`, and below a row
  whose origin is `elsewhere`; every minute while the certificate waits
  for DNS, and Check again (on every pending-certificate note) runs it at
  once and refreshes the row. A held domain whose DNS is `proxied` reads
  "Certificate waits for Cloudflare" (not "... for DNS": its record there
  is set, the check through Cloudflare is what holds it, since 0.2.12),
  and its note, like the one below an `elsewhere` row, says the
  `originReason` in place of the general sentence when there is one
  (`apps/web/src/i18n/en/serviceDomains.ts` `originReason.*`).
- Let's Encrypt waits for DNS (0.2.8, `modules/domains/acme-hold.ts`): an
  `https: acme` custom domain's route goes out with `Route.acme_hold`
  (ACME without the certificate resolver: plain HTTP without the HTTPS
  redirect, and HTTPS with Traefik's default certificate plus the origin
  routers on both entry points, so the origin check reaches the node when
  Cloudflare's proxy connects on 443 with SSL/TLS Full; Full (strict)
  refuses that certificate with 525/526, which the check reports as
  `originReason: cloudflareCertificate`; Always Use HTTPS redirects the
  check to https but leaves Let's Encrypt's `/.well-known/acme-challenge/`
  on http, so after the release the order reaches port 80; with a
  redirect to https for every path the challenge router on websecure
  (`Route.acme_challenge_on_https`) is in place for the first order, since
  0.2.12; an agent from before 0.2.8 ignores
  the field and asks the CA at once), and `Domain.certificate` has
  `waitingForDns: true`, while the last check said `missing` or
  `wrongTarget`, `proxied` with the origin not `node`, or `ok` with the
  origin `elsewhere`. `unknown` DNS (a failed lookup, no node address)
  never starts a hold, and never ends one either: a held domain keeps its
  last DNS and origin answer (`keepsLastAnswer`; only `dns_checked_at`
  moves on, `domains.retryCertificate` refuses with `waitingForDns`), so
  it stays on the re-check and a resolver timeout starts no certificate
  against a record still missing. The first check that proves the domain (DNS `ok` with the
  origin not `elsewhere`, or `proxied` with `node`), or a `proxied` one
  nothing can prove (redirect-only, or no placed node with
  `routing.origin-proof.v1`), sets `domains.acme_released_at` (migration
  `0015_domain_acme_hold`, which sets it on existing domains whose DNS was
  not `missing`/`wrongTarget`) and marks the service dirty at once, so the
  node asks Let's Encrypt right away. Released is for good, and so is a
  domain that has or had a certificate (`cert_status` valid, an expiry or
  `live_at`); automatic domains and HTTPS custom/off are never held. The
  checks: `domains.add` (DNS only), `domains.checkDns`, the
  `domains.checkOrigin` job, the `domains.recheckWaiting` schedule
  (`modules/domains/recheck.ts`, every 60 s: at most 20 waiting domains
  whose last check is older than 2 min in their first hour, 15 min in
  their first day, 6 h after, oldest check first) and
  `domains.retryCertificate`, which refuses
  a still-held domain (CONFLICT `reason: waitingForDns`) and, when its
  check releases one, returns it pending without calling the agents (the
  new desired state starts the certificate). Route reports of a held
  domain count only with a certificate in them (ACTIVE without
  `certificate_expires_at` is a held route serving; CERTIFICATE_FAILED is
  ignored); one with a certificate, or a DNS_MISMATCH that holds a domain
  nothing proved, marks the service dirty too.
- Let's Encrypt's challenge on 443 (0.2.12, `acmeChallengeOnHttps` in
  `modules/domains/acme-hold.ts`): an ACME domain's route goes out with
  `Route.acme_challenge_on_https` unless its last DNS check said `ok` (the
  record points straight at the node, so the CA reaches port 80, where
  Traefik answers, and the app keeps `/.well-known/acme-challenge/` over
  https); automatic domains (the node's wildcard record, never checked)
  and the panel's own domain (`nodes/panel-service.ts`) always have it.
  Held or released alike, since renewals take the same way. A check that
  moves an ACME domain's DNS between `ok` and anything else marks the
  service dirty (`settleHold`), so the route follows a record put behind
  Cloudflare's proxy or taken out of it.

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
  console, metrics, storage and the Files popup, backups, previews,
  cron jobs, alerts, advanced, notes, settings, connection) is
  `src/routes/_app/p/$projectId/s/` and `src/components/service/`, with the
  tab sets per kind in `src/components/service-tabs.ts` (`tabsFor(kind)`).
  Every settings page, the activity (audit) page and approvals are
  `src/routes/_app/settings/`, `src/routes/_app/{activity,approvals}.tsx`,
  `src/components/settings-nav.ts` and `src/components/settings/`. Nothing
  is mocked in shipped screens.
- Service export and import (0.2.10): the Export card on the Settings tab
  (owners and admins, `auth.whoami`; compose and protected services show
  why instead) opens `components/service/transfer/export-dialog.tsx`; New
  service > Import from a file opens `/import?project=`
  (`routes/_app/import.tsx`, `components/import/`): `read-export.ts` reads
  only the zip's central directory and small entries in the browser
  (`@seylo/zip/read` over the File, so a damaged file is refused before
  anything is sent and a re-zip by macOS still reads), the review page
  saves every choice with `serviceTransfer.setChoices`, basic auth
  passwords stay in the page until `serviceTransfer.import`, and the
  uploaded archive and each picked volume go up in 32 MiB parts with a row
  per entry, progress and Retry (which asks `serviceTransfer.getImport`
  what the panel has). The Export dialog picks the volumes whose data goes
  in and whether the service stops (a database always, and only with a
  passphrase), warns that it stays stopped until the download ends, and
  shows the download's bytes, Stop the export and the zip's sha256 from
  `ServiceDetail.transfer`; `components/service/transfer/transfer-note.tsx`
  says the same under the service header, and while an import still sends
  data links to `/import?project=&resume=` (`components/import/resume-step.tsx`:
  the same file again, checked by its manifest's sha256).
- Sidebar (0.2.2, `components/shell/`): the mark and the panel name are
  one link to the dashboard (`/`, active only there). Each project row
  but the protected Panel project has a + next to its "..." menu (shown
  on hover or keyboard focus, always on touch screens) that opens the New
  service menu with that project chosen. Approvals is in the main
  navigation (sidebar and command palette, `use-main-nav.ts`) only while
  something can ask for one (`system.features`: MCP or the assistant on),
  something waits for the viewer, or the page is open
  (`nav-items.ts` `showApprovals`). Settings > Preferences has a switch
  per main navigation item but Settings, all on by default
  (`auth.preferences.hiddenSidebarItems`, `lib/use-sidebar-items.ts`).
  Off only takes the item out of the sidebar, the phone menu included
  (`use-main-nav.ts` `useSidebarNav`, `nav-items.ts` `inSidebar`): the
  command palette (`useMainNav`) still lists it and its page still opens
  at its link. Settings never hides, so the switches stay in reach;
  Approvals turned off still shows while a request waits for the viewer;
  an item a rule of its own leaves out (Approvals with MCP and the
  assistant off) stays out when its switch is on. Until the preferences
  answer the sidebar shows one placeholder per item, so a hidden item
  never flashes.
- Session key: the op client's fetch (`lib/session-key.ts` `sessionFetch`)
  sends the key from localStorage on every call and keeps the one an
  answer hands out (an empty one clears it); the live socket and the
  archive upload (`sessionKeyHeaders()`) send it too. Any new way to call
  the panel with the session must do the same (see Credentials).
- Plain HTTP (changed in 0.2.1): the signed-out screens (`AuthFrame`:
  sign-in, setup) show no notice. The app shell shows
  `components/shell/plain-http-notice.tsx` at the top whenever the page is
  not a secure context (`lib/plain-http.ts`; loopback counts as secure, so
  the tunnel itself shows nothing, and a `*.ts.net` host, the tailnet URL
  in HTTP mode, counts too): one neutral line "HTTPS is off until the
  panel has a domain.", "Set a domain" to Settings > General for owners
  and admins, "More" for the SSH tunnel command for this port
  (`ssh -L <port>:127.0.0.1:<port> root@<host>`, then `http://127.0.0.1:<port>`:
  127.0.0.1 because with IP access off Docker publishes the port on IPv4
  loopback only, the same form as the panel's `recovery.sshTunnel`), and a
  dismiss button remembered per browser (localStorage
  `<slug>.plainHttpNoticeDismissed`, every access in try/catch).
- Service terminal (`components/service/terminal/`): one Console tab with
  two modes, console (attach to the main process, stdin a line at a time,
  `terminals.console`) and shell (a PTY in a running container,
  `terminals.shell`). The mode is `?mode=shell` on the Console tab (left
  out: console), so links and reloads keep it; the old `/shell` route
  redirects there, and the service tab links ignore search so the Console
  tab stays current (on a phone the tabs' swipe row scrolls the current
  tab into view, never the page). The Console | Shell switch in the terminal header
  (`Segmented` with `tone="terminal"`) changes the mode in place:
  `TerminalPanel`'s `sessionKey` closes the open session and opens the
  other in a fresh xterm while the header stays mounted, so focus and the
  sliding background stay; a ticket that arrives after its session was
  closed opens no socket. On the Console tab the card fills the rest of
  the page (at least 440 px, `fill`), one height in both modes: the stdin
  line takes its room from the terminal, which is laid out absolutely and
  fits what is left, so it never sets the card's height. The header is one
  row: the subtitle (hidden on a phone) and the user:folder chip share
  what the switch and the buttons leave and truncate, so the chip arriving
  with a shell's ready message never wraps the buttons. The Overview shows
  the same terminal as a card under Deploys (360 px in every state:
  loading, nothing running, connected, exited; "Open full" to the Console
  tab in the same mode, just its arrow on a phone; no Console quick
  action next to it). Its first session waits for a running container
  (`hasRunningInstance`: running, partial, unhealthy, or a deploy on top of
  a live version; before that a dark card with the switch and "The
  console opens once the app runs."); once shown the terminal stays until
  the page is left, so a crash or a restart keeps the output, the exit
  note and Reconnect and opens no new ticket. It watches the console by
  itself (`terminals.watchConsole`: a query for the console's output only,
  the panel drops what is sent on it, not in the audit log, like reading
  logs; same permission as `terminals.console`), so looking at the page is
  no console use; the first stdin line sent opens `terminals.console`
  (audited) in its place in a fresh terminal (the tail replays) and goes to
  it once it is ready. A shell opens only when asked: the switch, or "Open
  shell" (`TerminalPanel`'s `start`) for a person who may open only the
  shell.
  It never takes focus until clicked and closes its socket when the page
  is left. Both offer only the modes the person may open
  (`useTerminalModes`: owners and admins every mode, members what
  `grants.mine` allows on the service or its project); with none the card
  is hidden and the tab says so. The database shell and the node's host
  shell use the same `TerminalPanel`.
- Deploy titles (`deploymentTitle(d, service.source)`): the commit
  message, else Rollback, Move, or "Deploy <image>" for a pulled image,
  else "Deploy from <branch>" (the commit's), else "Deploy from <what it
  built>" (`Deployment.source`), else for an inline Dockerfile the
  service's source label, else the generation. `Deployment.source` comes
  from the deploy's own row (`deploymentSource` in
  `apps/panel/src/modules/deployments/store.ts`): its branch, which the
  engine records before the source is fetched so a failed clone keeps the
  branch it tried, else the uploaded archive's name (its `source_uploads`
  row, else the clone step's detail once older uploads are deleted). The
  service's source as it is now never names an older deploy: it would put
  the newest archive or the fixed branch on every row. The panel
  registry's own address (`127.0.0.1:5755/...`, any
  loopback registry, or any image a builder made) is never shown. A deploy
  whose clone failed with git's exit 128 ("could not fetch") for a plain
  git URL on github.com, gitlab.com or bitbucket.org with no credential
  gets one hint under the error (`private-repo-hint.tsx`): connect it
  through that provider on the Source tab, or pick a git credential there.
- New app source tabs (0.2.2, `components/new-service/`): Docker image |
  GitHub | Git repository | Set up later, under a visible Source label (the
  track hugs its items and scrolls sideways on a phone, as every kit
  `Segmented` does).
  GitHub tab (`repo-field.tsx`): one Repository field takes `owner/repo` or
  a github.com address (https://, ssh://, git@github.com:, or
  `github.com/owner/repo` without a scheme), with or without `.git`
  (`repo-input.ts` `parseRepoInput`, `githubParse`); another host says to
  use the Git repository tab. Page addresses give the repository and what
  follows `tree/`: the branch is its longest start that is one of the
  repository's branches (`branchFromRef`; `tree/main/apps/web` gives
  `main`), its first segment when the branches cannot be read, never a
  commit id, and the default branch otherwise. Browse lists, by connection
  and with private or public, the repositories of the GitHub App
  installations that are not suspended and of the connected GitHub account
  ("Connected account · @login", `github.repos` with `accountId`), searched
  and paged; a hidden installation list gives none, a connection whose list
  the panel refuses (FORBIDDEN) drops out, and a failed list says so. While
  nothing on GitHub is connected (no installation and no account, or a list
  hidden from the person) the tab shows three short steps (open Settings >
  GitHub; create the App and install it on the account or organization, or
  connect an account or paste a token; come back and pick) with a button to
  Settings > GitHub that closes the dialog (owners and admins), or whom to
  ask (members); then there is no Port and nothing to create from the tab.
  Browse is the field's width on phones, at least 420px from `sm`, 16px
  from the window's edges, and no taller than the space Radix leaves; arrow
  keys, Home and End move through it (and the branch list), and Show more
  keeps the focus. What the field becomes (`repo-source.ts` `decideSource`,
  `sourceFor`): a repository picked from a connection (in that project: a
  new project looks the text up again), or typed and read by one by its
  exact name (`github.branches`, NOT_FOUND with `details.field` `repo` when
  it cannot read it; installations are asked first, then the account), is a
  `github` source with `deployOnPush` on, through the installation
  (`installationId`, `accountId: null`) or the account (`installationId:
  null`, `accountId`), as on the Source tab; a typed repository no
  connection reads (NOT_FOUND) or may use here (FORBIDDEN) is a `git`
  source (owner/repo as `https://github.com/<owner>/<repo>.git`, no
  credential, `deployOnPush` off). Any other failure of a lookup or of the
  installation list leaves it unchecked with Try again, and nothing is
  created. A quiet line under the field says which. `services.create`
  refuses GitHub sources, so the dialog creates the app without a source,
  then calls `github.connectRepo` (which creates the account's repository
  webhook), then `deployments.deploy` when "Deploy right away" is ticked; a
  failed connect opens the service's Source tab with the error. connectRepo
  needs `services.update`, so for a member without it in the project
  (`grants.mine`) Browse says so and typing gives `git` sources only. Git
  repository tab: a plain URL field (https://, ssh://, git@host:path, or a
  host and path without a scheme), with no picker, no `owner/repo`
  shorthand (it says to type the host or use the GitHub tab) and no
  lookups in the App, the account or git providers; it is always a `git`
  source with no credential and `deployOnPush` off (a github.com URL says
  "Private? Use the GitHub tab"). GitLab, Gitea and Bitbucket repositories
  are picked on the service's Source tab, not in the dialog. On both tabs an
  SSH URL creates without the first deploy (no deploy key yet), and Branch
  suggests the repository's branches (`github.branches`, or `git.branches`
  for an https URL) and follows the repository until edited for it; a
  branch chosen for one repository is dropped when the repository changes
  (`repoKeyOf`), an empty field is the suggested branch, and one git
  refuses (`GitBranch`) is marked with a note. Port: 80, filled in, unless
  edited; on the Docker image tab the port a Docker Hub image exposes
  (`dockerHub.inspect` once the name rests, `image-port.ts`
  `dockerHubRef`, `portChoices`; another registry or a digest keeps 80), an
  edit sticks across images and tabs, and the hint says where the number
  came from (built apps: they get it as `PORT`). The dialog's subtitle is
  its own (`newService.dialogHints`), the footer (Cancel, Create) stays at
  the bottom while a tall form scrolls on a phone, the database engine
  tiles have a visible Engine label and centre their badge, the cron
  schedule hint runs under both fields, the compose Preview sits in the
  docker-compose.yml label row (with why it is off), and the pgvector
  statement shows as code.
- Source tab, GitHub (`service/source/github-form.tsx`): the Account picker
  lists the App installations and the connected account ("@login
  (connected account)"); "Connect GitHub first" shows only when there is
  neither. For a repository read through the account, a line says whether
  its webhook takes the pushes or why the branch is polled
  (`github.repoWebhook`).
- Copy fields (`packages/ui/src/components/copy-field.tsx`, since 0.2.1):
  a click anywhere on the field copies, the copy icon included
  (`copy.spec.ts`).
- Narrow screens (0.2.2): a table never cuts text or hides columns off
  screen without a hint. The audit log is one table on the Activity page
  and a project's Activity tab (`components/activity/activity-log.tsx`:
  action sentences, error codes in words, `formatRelative` times, "Load
  more" centered, the same detail sheet); on a phone it keeps What and
  Result and repeats who and when under the action. Tables that hide
  columns on a phone (`hideOnMobile`) repeat those facts as one line in a
  kept cell (project People, internal git hosts, git providers, MCP
  clients, Updates). The node list renders its table only when the list
  is at least 1000 px wide and the drawn table fits it (`lib/use-table-fits.ts`
  `useTableFits`: a long address or Update now with a warning needs more,
  and that width is kept), else one stacked row per node with the column
  names as labels; it never runs past the card. The dashboard's service
  table does the same from 760 px. Rows that scroll sideways
  on a phone (project tabs, service tabs, the settings sections, the node
  sheet's views, template categories) use `scroll-row` with
  `scrollFadeRef`, which the kit's `TabList` and `Segmented` carry
  themselves, and scroll the current item into view. From md up the
  service tabs show every tab instead (a mouse wheel cannot scroll a
  sideways row): one row at 1440 px, wrapping below with a track line per
  40 px row. Unknown paths go to `routes/_app/$.tsx` (the 404 next to
  the sidebar); the root's not-found and error screens sit in `AuthFrame`.
- Your account (Settings, `settings-nav.ts` `accountNav`): Personal
  details (`/settings/profile`, `components/settings/profile/`) above
  Security. Personal details holds the avatar (the one in use, Upload
  image, Remove image while an upload shows, and the generated faces after
  Clipnest's picker: a style, six faces, Randomize; a pick saves at once;
  the credit line names the style's artwork and license) and the Profile
  card (name and email saved together; a new email goes through
  `auth.changeEmail`, so the re-auth dialog may open, and a taken one shows
  under the field). Security keeps the password, authenticator app,
  passkeys, GitHub and sessions. The sidebar's account chip links to
  Personal details. People are drawn with the kit's one `Avatar` (image
  with alt, or `decorative` next to the written name; tinted initials
  while it loads past 400 ms and when it fails): the sidebar chip, People
  and the person sheet, a project's People tab, Activity rows (actors with
  an id) and the Approvals requester.
- Hiding projects (0.2.1, per person, not global): the person's
  preferences (`auth.preferences` / `auth.updatePreferences`, the
  free-form `Preferences` record) gain `hiddenProjectIds` (`HiddenProjectIds`
  in `packages/ops/src/ops/auth.ts`), add-only: at most 200 distinct ids,
  `null` removes the key. The panel keeps only ids of projects that exist
  and the caller can see, on every read and write; unknown, deleted or no
  longer visible ids drop out silently (see "Services and deploys"). Hidden
  projects leave the sidebar's Projects list and the home page grid;
  "Hide project" and "Unhide project" are in the project's "..." menu
  (`components/project-menu.tsx`) in the sidebar and on its home card,
  and a hide toasts with Undo (`lib/use-hidden-projects.ts`). A folded
  "Hidden (N)" row ends the sidebar list and "Show hidden (N)" brings the
  cards back on the home page with a "Hidden" chip, without unhiding.
  The sidebar waits for the preferences, so a hidden project never
  flashes. The command palette, direct links and the project pages ignore
  the list. Nothing is hidden by default: the protected Panel project
  shows until the person hides it. Settings > Preferences (the "Your
  account" group, `routes/_app/settings/preferences.tsx`) has "Show hidden
  projects in the sidebar" (`showHiddenInSidebar`, `ShowHiddenInSidebar`
  in `auth.ts`, on by default, only `false` is stored). Off removes the
  "Hidden (N)" row; the home page's "Show hidden", the palette and links
  still reach hidden projects, and a hidden project whose pages are open
  shows alone at the end of the sidebar list until you leave it
  (`hiddenInSidebar`), so the sidebar still marks where you are.
- Dashboard projects views (`components/dashboard/`): a Cards | List |
  Table switch (kit `Segmented`) next to Expand all | Collapse all,
  remembered per browser (localStorage `<slug>.dashboardView`, every
  access in try/catch, `lib/dashboard-view.ts`), Cards by default and for
  any unknown value. Cards (`project-sections.tsx`): each project is a
  title row on the page ground (tile, name and counts linking to the
  project, then open, Settings (`?tab=settings`), + with the New service
  menu for that project (not on the protected Panel project), the "..."
  menu and the chevron) over a grid of the project page's service cards
  in their compact size (`components/project/service-card.tsx`
  `ServiceCard compact`), 1 to 5 columns by the width the sections get (a
  container query); an empty project shows a dashed Add a service card,
  a collapsed one only its title row. List is the one-card-per-project
  layout. Table (`service-table.tsx`): every service of the projects on
  screen (collapsed ones too, hidden ones with Show hidden and a Hidden
  chip) with Service, Project, Status, CPU, Memory, Node and Last deploy;
  unsorted it follows the projects' order, then the names; a header sorts
  (`service-sort.ts`: CPU, memory and last deploy start with the largest
  and newest, words from A; the third click goes back; empty values last
  both ways; `aria-sort` on the header), and the service link covers its
  row. Expand and collapse are hidden there. Each view has placeholders in
  its own shape (a card, a row or a table row per service of a project
  still loading). A line (`bg-border`, the ground's line token) with a gap
  on both sides separates the projects from Recent deploys and Alerts.
- Assistant chat (`components/assistant/`, `routes/_app/assistant.tsx`):
  a round bubble bottom right on every signed-in page but the Assistant
  page while `ai.me.available` (the assistant on, with a key, and for
  members only with `allowMembers`), opening a compact chat (a full-screen
  sheet under `sm`); the Assistant page in the main navigation while
  `ai.me.chatPage` too (Settings > AI assistant > Assistant page, on by
  default; `nav-items.ts` `showAssistant`). Both show one person's chats
  from one query cache: the chat open and the current chat live in
  `assistant-context.tsx` (above the pages, and the tab's sessionStorage
  `<slug>.assistant`, per person), the page's chat is `?c=<id>`. A chat's
  data is `use-chat.ts`: `ai.conversation` kept current by `ai:<id>` (one
  follow per chat, a log of recent events applied on top of each fetch;
  `stream.ts` applies an event twice safely and asks for a refetch on a
  gap). Tool calls are action cards (`action-card.tsx`, phrases per op in
  the `assistant` i18n section, `phrases.ts`, else the op's summary);
  one with an `approvalId` is the approval itself (`approvals.get`, Approve
  and Reject call `approvals.approve`/`deny`), so the chat and the
  Approvals page decide the same record. Empty chats offer chips for the
  page they were opened on (`place.ts`), which is also a new chat's
  context. The auto switch is in both headers and the composer says when
  it is on. While the bubble shows, the shell's `main` ends 96 px higher
  and toasts sit above it (`--toast-lift`), so it never covers a page's
  last buttons. The Approvals page shows each request's source as chips
  (Assistant and the chat, linking to it for its owner; MCP and the token).
- Dashboard Nodes card, Live (`components/dashboard/node-usage.tsx`): the
  Live chip in the header is a toggle and on by default; picking 1h, 24h
  or 7d turns it off (the range picker shows no choice while Live is on),
  and the chip again goes back to the last range. Each person's choice is
  kept per browser (localStorage `<slug>.dashboard.nodesRange`, every
  access in try/catch: `lib/dashboard-range.ts`). Live shows the last 5
  minutes: `metrics.nodes` range `live` (the panel's 10-second points) as
  the seed, then the 2-second `nodeLive` samples of every shown node's
  `node-live:<id>` topic (`lib/node-live.ts` `useNodeLive`), followed only
  while Live is on and the tab is visible, so a hidden tab lets the
  panel's watches lapse. Samples go into a `NodeLiveBuffer`
  (`lib/node-live-buffer.ts`: a ring of 192 points per node outside React,
  subscribers told once per frame, each node's times moved onto the
  browser's clock by the smallest arrival delay of its last 30 samples);
  the graphs re-render from it at most once a second. `SmoothChart`'s
  `window` (`{ now, spanMs, lagMs, follow, maxGapMs }`, series with their
  own `times`) draws them on a time axis in a wider layer that a Web
  Animations transform slides left at real speed between renders (no
  work per frame; the right edge runs 3 s behind now so a new point slides
  in), with a y maximum that stays on a nice round number until the data
  outgrows it or shrinks well under it (`stickyNiceMax`), and gaps over
  25 s break the line; with reduced motion nothing slides and each render
  shows the window up to now. The values under the graphs follow the
  newest sample, the tooltip names the sample's time with seconds. No
  sample for 8 s (`liveStaleMs`): the chip turns amber and the card shows
  `metrics.nodes` 1h with a note ("Live updates paused: the connection to
  the panel dropped." while the socket is down, "No live samples from the
  nodes right now." otherwise), and the hour also stands in while there is
  nothing at all to draw.
- Live data: `lib/live.ts` `listen(topic, fn)` for topics with payloads
  (deployment logs, assistant replies, node-live samples), `useLiveUp()` to poll only while the socket is down.
  The saved accent's CSS is `accentCss` from `@seylo/ops` (the panel's
  boot.ts emits the same string).
- Re-auth: `lib/api.ts` wraps the one op client in `withReauth`
  (`lib/reauth.ts`), so any mutation refused with
  `details.reason: "reauth"` opens the dialog mounted once in `main.tsx`
  (`components/auth/reauth-dialog.tsx`: password, authenticator or
  recovery code, passkey, or "Confirm with GitHub" when `auth.security`
  has a linked `github` and `githubAvailable` (the device code card from
  `components/auth/device-code.tsx`, polled until GitHub answers), else
  sign in again) and runs once more after the confirmation; nothing per op
  is needed. A closed
  dialog fails the call with `isReauthCancelled(error)` true, which
  `toastError` and the screens keep quiet. `/reauth?redirect=<path>` is the
  same form as a page (for the MCP consent page). `?redirect=` on `/login`
  and `/reauth` goes through `lib/redirect.ts` `safeRedirectPath` (a path
  on this origin whose parsed path does not start with `//`, so
  `/..//evil.example` is refused), and `validateSearch` always returns the key, because the router keeps raw
  search values a route leaves out.
- Shared helpers: `lib/theme.ts` (`refreshBoot()` after an appearance or
  branding save, `useBoot()`), `lib/format.ts`, `lib/types.ts`,
  `lib/service-display.ts`, `components/query-error.tsx` (`QueryError`
  renders 501 as "not built yet"), `components/pickers.tsx` (`NodePicker` from
  `nodes.choices`, `ProjectPicker`). In `components/service/`: `editor/code-editor.tsx`
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
  and pgvector Connection tabs; a self-signed Postgres exposure's note
  without a TLS host name and with a failed ACME certificate, and its
  certificate download), `database-users.spec.ts` (the Users tab
  on the demo data: the Connection tab's Change links opening the main
  user's dialogs, a new user's password once, a Postgres owner's delete,
  Redis's one user, a MongoDB switch), `database-version.spec.ts` (the Version
  card on the demo data: choices with reasons, a patch update, a MongoDB
  upgrade that waits for Back up now or the checkbox, Postgres refusals),
  `flows.spec.ts` (CLI sign-in approval, keys, invites, 2FA, appearance,
  channels on the real panel), `reauth.spec.ts` (the re-auth dialog on the
  real panel: it ages the owner's sessions in `panel.db`, then API key,
  a git provider connection, authenticator setup, CLI approval, GitHub
  link, passkey, a GitHub-only account confirming with GitHub (mocked
  answers, another GitHub login refused) and a node join command each ask
  first and go through; `/reauth`; sign in again),
  `git-providers.spec.ts` (Settings > Git providers, a provider repository
  in the Source tab and the watch paths tester, on the demo data),
  `dockerhub.spec.ts` (Docker Hub search, tag picker, prefilled form and
  create, popular images, with `demo/dockerhub.ts`),
  `dashboard-views.spec.ts` (the dashboard's Cards, List and Table views on
  the demo data: compact service cards with status and bars, collapsing,
  sorting the table by CPU with the mouse and keys, the view kept across
  reloads, phone width, the divider, screenshots per view in a light and a
  dark preset), `template-logos.spec.ts` (app logos on the Templates page from the real
  catalog: logo images, letter tiles without one or when one fails to load,
  the popular images row and its dialog, a screenshot per preset),
  `nodeops.spec.ts` (the node sheet's Cleanup and Shell views with the demo
  data: saving a schedule, allowing and opening a host shell),
  `clone-move.spec.ts` (the Clone and Move to project dialogs on the demo
  data, with the ops answered and recorded per test), and since 0.2.1
  `nodes-build-default.spec.ts` (Add node's Build images on this node:
  ticked by default, the request carries the choice, Change),
  `panel-access.spec.ts` (the Panel domain card's switches in every state,
  the confirm dialog, Keep IP access closed needing the tick, Check now and
  a Cloudflare-proxied domain), `tailscale.spec.ts` (every Tailscale card
  state, Install typing into the Shell view without running, sign-in, the
  Serve switch, the other-tailnet card and Lock to Tailscale only from the
  tailnet with the recovery commands saved) and `build-settings.spec.ts`
  (the build node picker says why a node is not offered: Can build off,
  docker buildx missing, offline; Save sends the build node only when it
  changed), `hide-projects.spec.ts` (Hide project from the sidebar and
  the home card on the real panel: Undo, a reload, Hidden (N) and Show
  hidden, the palette and the project page still open it, Unhide),
  `env-save.spec.ts`
  (typing during a slow service or shared environment save keeps the new
  text unsaved), `console.spec.ts` (the Console | Shell switch in place
  with `?mode=shell` and the old session closed, one card height for both
  modes at four window sizes with a one-row header, no ring on the
  switch in a dark preset, `/shell` redirecting, the Overview console
  card: 360 px while loading, while nothing runs and through a restart and
  a crash with its session kept, a watch ticket until a line is sent, then
  the console with that line, no socket while nothing runs, no focus
  taken, the header one row when a shell connects at 1024 px, Open full,
  closed when left, a member's modes and Open shell for shell-only, phone
  width; a failed clone's title and private repo hint),
  `repo-picker.spec.ts` (the New app dialog's Repository
  field with `demo/repos.ts`: Browse and pick, owner/repo an installation
  reads or not, pasted URLs and page addresses (a self-managed GitLab's
  too), branch suggestions and the branch following the repository, the
  empty, loading, refused and unchecked states, a project change, a member
  without `services.update`, the list at a short window and a phone,
  arrow keys and Show more, and what gets created and connected; a demo
  handler answers an error by throwing `demo/refusal.ts` `DemoRefusal`),
  `sidebar-new-service.spec.ts` (the + on a project row and the form with
  that project, none on the Panel project, the logo link home, Approvals
  hidden until MCP or the assistant is on), `personal-details.spec.ts`
  (Settings > Personal details above Security: the name, a taken email
  under its field, the generated faces with Randomize, another style and a
  pick, an upload cut to 256 px in the browser and removed again, the
  sidebar chip following; screenshots in a light and a dark preset),
  `assistant.spec.ts` (the chat bubble and the Assistant page with
  `demo/assistant.ts`, which streams replies over the demo live socket:
  page suggestions, a streamed reply and its action card, an approval card
  approved from the chat and resolved on the Approvals page with its
  source chips, the auto switch, the chats menu, search, the bubble hidden
  on the page and back elsewhere with the same chat, room under the page,
  who sees it, a phone; screenshots in `$SHOTS_DIR/assistant/`),
  `node-live.spec.ts` (the
  dashboard's Nodes card in Live on the demo world, whose live socket
  streams `nodeLive` samples on `node-live:<id>`: `installDemo`'s
  `nodeLive` "stream", "silent" or "refuse": Live by default with no range
  picked, sliding graphs (one animation per layer, none with reduced
  motion), values following the newest sample, the tooltip, a hidden tab
  unfollowing, a range turning Live off and the choice after a reload, the
  hour with a note without samples or without the socket),
  `appearance.spec.ts` (color mode `system` following the device and
  every switch, an explicit mode winning, every preset's two halves with
  readable text and a look of their own, and the Appearance screen: tiles
  following the mode, default branding images, the sign-in message
  placeholder, the custom CSS guide and Insert example),
  `screens.spec.ts` (every screen with the demo data in `demo/`, in every
  theme preset and both of its halves, the sign-in page among them, plus
  the phone width, the service tab bar (one row
  at 1440 px, two wrapped rows with their lines at 1280 and 1024, a swipe
  row on a phone), the node list with its widest row at four laptop
  widths and the accent check;
  screenshots in `$SHOTS_DIR/screens/<preset>/<light|dark>/`; `PRESETS=`,
  `MODES=` and `SCREENS=` narrow it).

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
