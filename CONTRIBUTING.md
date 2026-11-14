# Contributing

Bug reports, fixes and features are welcome. For anything bigger than a fix,
open an issue first so we can agree on the approach before you write it.

- Code and the installer: this repository.
- One-click templates: [Seylo-dev/Templates](https://github.com/Seylo-dev/Templates)
  (`bun run new <slug>`, `bun run check`, then a pull request). The panel
  checks them with `apps/panel/scripts/check-templates.ts` from here and
  ships a copy of the signed catalog in `templates/`.
- User documentation (https://docs.seylo.dev): the docs app in the Website
  repo, [Seylo-dev/Website `apps/docs`](https://github.com/Seylo-dev/Website/tree/main/apps/docs).
- Security problems: not in a public issue; see [SECURITY.md](SECURITY.md).

How the pieces fit together, the protocol and the code conventions are in
[CONTRACTS.md](CONTRACTS.md). Read the parts you touch before you change them.

## Setup

You need Go 1.27 (the version in `go/go.mod`), Bun 1.4.4, [buf](https://buf.build)
1.75 and `make`. The installer tests also need minisign (they skip without
it). Go tools (`protoc-gen-go`, `staticcheck`) are pinned in `go/go.mod` and
the TypeScript tools in `package.json`, so nothing else needs a global
install.

```sh
git clone https://github.com/Seylo-dev/App.git seylo && cd seylo
make install   # bun install --frozen-lockfile
make build     # bin/seylo, apps/web/dist, apps/panel/dist
```

Generated code is committed, so a fresh clone builds without `make gen`.

## Run it from source

The panel and the web app run on macOS or Linux:

```sh
cd apps/panel
export SEYLO_DATA_DIR=$HOME/.seylo-dev SEYLO_SECURE_COOKIES=false
bun run create-owner you@example.com                     # once; asks for the password
bun run dev                                               # API on :3000
cd ../web && bun run dev                                  # Vite on :5173, proxies /api to :3000
```

A real node agent needs Linux and Docker; see "Tests in a VM" below.

## Make targets

| Target | What it does |
|---|---|
| `make install` | JS dependencies (needed before `gen` and the TypeScript tests) |
| `make gen` | Regenerates brand constants, protocol code, op and module indexes, `openapi.json`, the web route tree and `installer/install.sh` |
| `make check-gen` | Fails when committed generated code is stale or the Drizzle schema changed without a migration |
| `make build` | Static `bin/seylo` (`CGO_ENABLED=0`), then the web app and the panel |
| `make test` | Go tests with `-race`, `bun test` in every workspace, the installer and release script tests |
| `make lint` | `buf lint`, gofmt, `go vet`, staticcheck, Biome, `tsc` |
| `make breaking` | `buf breaking` against `main` |
| `make release-snapshot` | Release binaries and `install.sh` into `dist/` (no signing, image or publish) |
| `make release-dry-run` | goreleaser as a release runs it, in snapshot mode, on the build `make build-ts` left (run that first): one panel image per platform loaded into Docker, nothing signed or pushed (`scripts/release-sign.sh` signs) |
| `make e2e` | The three-VM end-to-end test (below) |

Before you open a pull request:

```sh
make gen && make check-gen && make lint && make test && make build
```

CI runs the same on every push and pull request.

## Generated code

Never edit generated files by hand: `go/gen/`, `packages/proto/src/gen/`,
`packages/brand/src/`, `installer/brand.env`, `installer/install.sh`, every
`*.gen.ts`, `openapi.json` and `apps/panel/drizzle/`. Change the source
(`brand/brand.json`, `proto/`, op contracts, module folders, route files,
i18n sections, the installer template) and run `make gen`. After a schema
change in `apps/panel/src/db/schema/`, run `bun run db:generate` in
`apps/panel` and commit the migration with the change.

## Tests in a VM

Go packages that drive Docker (reconcile, proxy, build, backups, ...) have
integration tests behind the `integration` build tag. They run as root in
a Linux VM against its real Docker, never on your machine's Docker. On
macOS, create the dev VM once with [Colima](https://github.com/abiosoft/colima),
mounting the folder that holds your checkout at the same path:

```sh
colima start -p seylo-a --vm-type vz --network-address --cpu 4 --memory 8 --disk 60 \
  --mount "$(cd .. && pwd):w"
```

Then, from the repository root:

```sh
scripts/dev/vm-gotest.sh ./internal/reconcile            # one package (SEYLO_VM picks another profile)
scripts/dev/vm-gotest.sh ./internal/agent -run TestITShellPTY -v
scripts/dev/vm.sh 'docker ps'                            # any command as root in the VM
```

`scripts/dev/it-gitea.sh` runs the git provider tests against a real Gitea
in the same VM (a throwaway container, removed afterwards).

Use a VM you keep for this only: the tests create and remove containers,
networks and volumes. `SEYLO_IT_PREFIX=<a-z0-9, up to 8>` starts the test
projects' ids (and so their container and network names) with your own
prefix instead of `jbit`, when several runs share one VM. `SEYLO_VM_ARCH=amd64` builds for an x86-64 VM.
`vm-gotest.sh` passes every `SEYLO_IT_*` variable into the VM; two tests
need one: the update guard test runs a real build
(`SEYLO_IT_GUARD_BIN=<absolute path of a linux seylo binary>`) and the
Nixpacks build test pulls a large image (`SEYLO_IT_NIXPACKS=1`).

## Browser tests

`test/playwright/run.sh` (needs Node.js for Playwright's runner; it installs
its own dependencies and Chromium) starts a panel on a fresh data dir and
Vite in front of it, then runs the Playwright suites: smoke (setup, sign-in, real panel),
flows (CLI sign-in approval, keys, invites, 2FA, appearance, channels),
re-auth, databases (the New database form and the database Connection
tabs), and on demo data dockerhub (Docker Hub search and the prefilled image
form), git-providers (Settings > Git providers, provider sources and watch
paths), nodeops (the node sheet's Cleanup and Shell views), clone-move (the
Clone and Move to project dialogs), certificates (the Domains tab's
Generating SSL certificate state and Regenerate certificate) and screens (every screen in all four
theme presets). `test/playwright/run.sh --project smoke` runs one suite;
`PRESETS=seylo` and `SCREENS=` narrow the screens suite. Screenshots land in
`test/playwright/shots/`.

## End to end

`make e2e` builds test-signed releases (agents, panel image, installer),
creates three fresh VMs (two Colima VMs with Docker and one plain Lima
Ubuntu 24.04 VM without Docker), installs Seylo on them with the real
installer and runs 43 checks: joins, builds, deploys, zero-downtime
redeploys, crash policy, databases, backups to MinIO, cron, logs, moves,
replicas, updates with rollback, the CLI, MCP, the panel domain with an
ACME certificate from Pebble, uninstall, Docker Hub, a Gitea provider with
watch paths, scheduled cleanup, host shells, clone and move, Valkey,
ClickHouse and pgvector, an upgrade from the last release (0.1.1,
built from its tag) through the normal update, the build default and
closing IP access over the domain, the panel on a Headscale tailnet, a
panel move to another node and back, a service export and import with
volume and database data, and a MongoDB version change in place. It takes about 50 minutes
on an Apple silicon Mac and needs Colima, Lima, minisign, jq, python3,
psql and Node.js (check 30 runs Playwright). The results and their evidence go to
`test/e2e-colima/RESULTS.md`.

```sh
KEEP=1 make e2e                  # keep the VMs afterwards
make e2e-checks CHECKS="7 8"     # rerun some checks on the kept VMs
make e2e-refresh                 # move kept VMs to the working tree through the panel's own update
make e2e-down                    # delete the VMs and ~/.cache/seylo-e2e
```

The scripts only use VM profiles named `seylo-e2e-*` (and
`test/e2e-colima/extra-installs.sh`, the Debian 12 and ufw installs outside
the 43, only `seylo-x-deb` and `seylo-x-ufw`). Details:
[test/e2e-colima/README.md](test/e2e-colima/README.md). After a release is
published, `.github/workflows/install-smoke.yml` installs it with its own
install.sh on GitHub's amd64 and arm64 runners and deploys traefik/whoami
through the API (`test/install-smoke/smoke.sh`); run it by hand with a tag.

## Commits and pull requests

- One logical change per commit. Start the message with the area
  (`agent:`, `panel:`, `web:`, `installer:`, `e2e:`, `ci:`, `docs:`) and
  say what changed and why, in plain words.
- Plain hyphens, never em dashes, in code, comments, docs and messages.
- Tests with the change: unit tests next to the code, a VM test when it
  talks to Docker, a Playwright check when it changes a screen.
- In the pull request, say how you tested it (and add a screenshot for UI
  changes).

## License

Seylo is licensed under [AGPL-3.0](LICENSE). By contributing you agree that
your contribution is licensed under the same terms. There is no CLA. Code
ported from other projects keeps its original notice and is listed in
[NOTICE](NOTICE).

## Releases

Maintainers only. Releases are built by GitHub Actions
(`.github/workflows/release.yml`) from a pushed `v*` tag, in four jobs:
the Build and test job tests the tag and builds the web app and the panel,
the Draft release job makes an unsigned draft release from that build, the
Sign job signs it, and the Publish job checks the draft on its own and
publishes it. A fifth, small job then starts the install smoke test on the
published release.

Only the Build and test job runs npm packages (`make install`, `make test`,
`make build-ts`, about 550 of them). Its token can only read and it gets no
secret, so a compromised build dependency can spoil the build but cannot
write to the repository, its releases or ghcr.io. The Draft release job holds
the token that writes releases and packages: it gets the build as files,
runs no npm package (goreleaser's before hook only renders `install.sh`, and
the panel image only packages the built files) and gets no signing secret.
`scripts/check-release-workflow.ts` (`make test-release`) fails when a job
that holds a write token or a secret runs bun, npm or node, or when
goreleaser's hooks do.

The release key is the root of trust for every install and every
auto-update, so only the Sign job ever sees it. The Sign job runs in the
`release` environment, gets the built files as an artifact, runs no npm, bun
or goreleaser code, and only hashes, checks and signs them
(`scripts/release-sign.sh`).

Once, before the first release (owners):

1. Make the release key pair with [minisign](https://jedisct1.github.io/minisign/):
   `minisign -G -p release.pub -s release.key`. Keep the secret key and its
   password offline (a password manager), never in the repository.
2. Put the public key (the `RW...` line of `release.pub`) into
   `brand/brand.json` as `minisignPublicKey`, run `make gen` and commit the
   result. Installers, agents and panels only trust files signed by this key.
3. Create the `release` environment (Settings > Environments > New
   environment, name `release`) before the next tag. A tag run creates it
   on first use, but then without any protection, so set it up first:
   - Deployment protection rules: Required reviewers, the maintainers who
     may approve a release (leave "Prevent self-review" off while there is
     only one).
   - Deployment branches and tags: Selected branches and tags, then add a
     tag rule `v*` and no branch rule, so only a `v*` tag can reach the key.
   - Environment secrets: `MINISIGN_SECRET_KEY` with the full contents of
     `release.key` and `MINISIGN_PASSWORD` with its password.
4. Delete the repository secrets `MINISIGN_SECRET_KEY` and
   `MINISIGN_PASSWORD` if they exist (Settings > Secrets and variables >
   Actions > Repository secrets). A repository secret can be read by any
   workflow on any pushed branch; an environment secret only by jobs in that
   environment, after its rules pass.
5. Protect the refs a release comes from (Settings > Rules > Rulesets): a
   tag ruleset for `v*` that restricts creations, updates and deletions to
   the maintainers (bypass list), and a branch ruleset for `main` that blocks
   force pushes and deletion.
6. Security contact: turn on Private vulnerability reporting (Settings >
   Code security), which the link in [SECURITY.md](SECURITY.md) needs, and
   create the `security@seylo.dev` mailbox (or a forward to the maintainers)
   that SECURITY.md names as the fallback channel.
7. Turn on release immutability (Settings > General > Releases > Enable
   release immutability). A published release's files and tag can then not
   be replaced or deleted, also not with a workflow's token. Without it a
   token that writes to the repository can swap `install.sh` (which
   `curl ... | sh` runs) on a published release or delete the release.
   GitHub applies it to releases published after it is on, and drafts stay
   editable, so the Sign job still attaches its signatures. The Publish job
   warns on every release that is not immutable.
8. The template catalog's signing. The Templates repo signs its catalog
   with the release key (owner decision 2026-11-14), so there is no key to
   make: `brand/brand.json` `templatesMinisignPublicKey` is the same value
   as `minisignPublicKey` (its own field, so the catalog could get a key of
   its own later; `tools/brandgen` tests that the two match). In
   Seylo-dev/Templates, create the `catalog` environment (deployment
   branches: `main` only) with the secrets `MINISIGN_SECRET_KEY` and
   `MINISIGN_PASSWORD`, the same values as in this repository's `release`
   environment. Until then the Templates repo publishes nothing and GitHub
   answers 404 for its catalog: panels list the catalog they ship and say
   the official catalog is not published yet (not an error, checked again
   every 6 hours), `make sync-templates` keeps `templates/` as committed and
   exits 0, and the release preflight only warns.

Each release:

1. Vendor the template catalog: `make sync-templates` downloads the
   published catalog from the Templates repo's `catalog` release, verifies
   it with `templatesMinisignPublicKey` (the release key), refuses one older
   than `templates/catalog.json`, checks that every template installs on
   this panel (`apps/panel/scripts/check-templates.ts`) and writes
   `templates/`. Commit the result. `scripts/release-preflight.sh` refuses a
   release whose `templates/catalog.json` is older than the published
   catalog, or unsigned while one is published. While nothing is published
   yet (GitHub answers 404 until the Templates repo has the secrets of step
   8 above), `make sync-templates` writes nothing, says so and exits 0, and
   the preflight only warns, so the release ships the committed copy
   unsigned; its panels list it and take the first published catalog at
   their next check. When a template needs a feature this release adds,
   raise `check` in the Templates repo's `panel.json` to this tag after the
   release.
2. Run a dry run on `main`: Actions > Release > Run workflow, or
   `gh workflow run release.yml -f dry_run=true`. It runs the same Build
   and test job and builds everything a release attaches from its build
   (binaries, checksums, `install.sh`, both panel images, the manifest),
   then hands the files to a third job that signs them with
   `scripts/release-sign.sh` and a throwaway key made there, as the Sign job
   does, and publishes nothing. A run started by hand with `dry_run` off is
   refused: real releases only come from tags.
3. Tag the commit and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
   The Build and test job runs `make install`, `make check-gen`,
   `make test` and `make build-ts` on the tagged commit and hands
   `apps/web/dist` and `apps/panel/dist` on as an artifact. The Draft
   release job checks that the tag is on the commit, then runs
   `make release-draft` for exactly that tag on that build, which makes the
   draft (nothing signed yet), pushes the image tags (`<version>`, and
   `latest` unless it is a pre-release) to `ghcr.io/seylo-dev/seylo` and
   hands the release files to the Sign job as an artifact (kept 14 days).
   One release runs at a
   time, and a running release is never cancelled by another tag. Re-running
   the job replaces the draft an earlier run made. A `vX.Y.Z-<pre>` tag
   (`v0.1.0-rc.1`) makes a pre-release that installs and the stable update
   channel do not follow (panels on the Pre-release channel, Settings >
   Updates, offer it); to promote it, tag the same commit `vX.Y.Z`.
4. The Sign job waits for a reviewer: open the run, Review deployments,
   tick `release` and approve. It then checks the files (every file
   `checksums.txt` lists matches it; `manifest.json` is for this version and
   has the sha256 of this release's linux binaries and `install.sh`;
   `install.sh` installs this version and is not a test build), signs
   `checksums.txt` and `manifest.json`, verifies both signatures with
   `brand.json`'s key, and attaches them to the draft once it is the only
   release with the tag and its `checksums.txt` and `manifest.json` are the
   signed files.
5. The Publish job (`scripts/release-publish.sh`) then checks the draft
   without trusting the jobs that made it, and publishes it only when every
   check passes:
   - `checksums.txt` and `manifest.json` are signed by `brand.json`'s
     `minisignPublicKey`, with this version in their trusted comments;
   - exactly one release carries the tag (GitHub lets several drafts share
     one), and Publish downloads and publishes that release by its id;
   - every release file is attached and covered by a signature:
     `checksums.txt` lists the binaries, `install.sh` and `openapi.json`,
     and each matches its signed sha256;
   - `manifest.json` names this version, this release's linux binaries,
     `install.sh` and panel image, and `install.sh` is this version's
     release build (not a test build);
   - the release is a pre-release exactly when the tag is;
   - `ghcr.io/seylo-dev/seylo:<version>`, and the digest the manifest pins,
     pull anonymously (as installs and updates pull them), with linux/amd64
     and linux/arm64.

   Right before publishing, Publish reads the release again and stops if
   its files or flags changed, or another release with the tag appeared,
   while it checked. A stable version becomes the latest release, which
   installs and the stable update channel follow, unless a newer version
   already is; a pre-release never does (the Pre-release channel takes the
   highest version of all releases). The run summary lists every check. When one
   fails, the draft stays a draft and the summary says what to do (for two
   drafts with one tag: delete the stale one, then re-run Publish). Running
   Publish again on a release that is already published checks it and
   changes nothing.
6. On the first release only, the new package is private, so Publish stops
   with "The ghcr.io/seylo-dev/seylo package is private". Open it
   (github.com/orgs/Seylo-dev/packages > seylo), check that it is connected
   to the `App` repository, change its visibility to public (Package
   settings > Change visibility), then re-run the Publish job (the run's
   page > Publish > Re-run this job). It stays public for later releases.
7. Once the release is published, the Start the install smoke test job
   starts `.github/workflows/install-smoke.yml` for the tag (a release
   published with the workflow's token starts no `release: published`
   workflow, so it is started by hand there; one published by a person
   starts it by itself). It installs the release with its own `install.sh`
   on an amd64 and an arm64 runner, sets the panel up through the API and
   deploys traefik/whoami; a failed run keeps the logs as an artifact.

To keep a release from going out on its own:

- Reject the Sign job's deployment (the run's page > Review deployments >
  Reject). The draft stays unsigned and Publish never runs; delete the
  draft and the tag as below, or re-run the Sign job later to sign it.
- Or push the tag as a pre-release (`v0.1.0-rc.1`). Publish still
  publishes it, as a pre-release that installs and the stable update
  channel do not follow (panels on the Pre-release channel offer it); tag
  the same commit `vX.Y.Z` when it is ready.

If the Sign job stops at "Release secrets are set", the `release`
environment has no key yet: add its secrets (step 3 above), then re-run the
Sign job; Publish follows it. If the Draft release job fails, or Sign or
Publish refuse the draft's content (not the private package), do not sign or
publish the draft by hand. Fix the cause on `main`, delete the draft release
if one was made, delete the tag (`git push origin :refs/tags/v0.1.0` and
`git tag -d v0.1.0`) and tag again.

`make release` is the local fallback for the Build and test (without the
tests), Draft release and Sign jobs together, on a maintainer's machine that
holds the key: it runs `bun install` and `bun run build` itself, with the
token and the key around. It needs the `v*`
tag checked out, `GITHUB_TOKEN`, `MINISIGN_SECRET_KEY` (the path of the key
file), `MINISIGN_PASSWORD`, `jq`, a `docker login ghcr.io` and a buildx
builder that builds linux/amd64 and linux/arm64.
`scripts/release-preflight.sh` first refuses a placeholder or test signing
key in `brand/brand.json`, a secret key that does not match it,
`INSTALLER_TEST_PUBLIC_KEY` in the environment and a repository the token
cannot push to (in Actions: a workflow running in another repository than
`brand.json`'s `githubOrg`/`githubRepo`); `--no-secret-key`, as the Draft
release job runs it, skips the secret key. goreleaser then makes a draft
release with the binaries, `checksums.txt`, `install.sh`, `openapi.json` and
the multi-arch panel image, `scripts/release-manifest.sh` adds the update
manifest and gathers every release file into `dist/release/`, and
`scripts/release-sign.sh sign` and `upload` sign and attach the signatures.
`make release-draft` is the Draft release job's part alone (no key), and
`make release-dry-run` the goreleaser half of the dry run (no key either).
Neither runs bun: both package the build `make build-ts` left in
`apps/web/dist` and `apps/panel/dist`, and stop when there is none.

`scripts/release-publish.sh v0.1.0` is the local fallback for the Publish
job: the same checks, then the publish, with `gh` logged in to an account
that can write to the repository, `minisign`, `jq` and `curl`.
`scripts/release-publish.sh --check-image ghcr.io/seylo-dev/seylo:0.1.0`
runs only the anonymous pull check. `make test-release` tests
`scripts/release-sign.sh` and `scripts/release-publish.sh` against fake
draft releases and a fake registry.
