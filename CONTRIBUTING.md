# Contributing

Bug reports, fixes and features are welcome. For anything bigger than a fix,
open an issue first so we can agree on the approach before you write it.

- Code, the installer and templates: this repository.
- User documentation (https://docs.seylo.dev): [Seylo-dev/Docs](https://github.com/Seylo-dev/Docs).
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
bun run create-owner you@example.com 'a long password'   # once
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
| `make release-dry-run` | goreleaser as a release runs it, in snapshot mode: signed, one panel image per platform loaded into Docker, nothing pushed |
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

Use a VM you keep for this only: the tests create and remove containers,
networks and volumes. `SEYLO_VM_ARCH=amd64` builds for an x86-64 VM.
`vm-gotest.sh` passes every `SEYLO_IT_*` variable into the VM; two tests
need one: the update guard test runs a real build
(`SEYLO_IT_GUARD_BIN=<absolute path of a linux seylo binary>`) and the
Nixpacks build test pulls a large image (`SEYLO_IT_NIXPACKS=1`).

## Browser tests

`test/playwright/run.sh` (needs Node.js for Playwright's runner; it installs
its own dependencies and Chromium) starts a panel on a fresh data dir and
Vite in front of it, then runs the Playwright suites: smoke (setup, sign-in, real panel),
flows (CLI sign-in approval, keys, invites, 2FA, appearance, channels),
re-auth, and screens (every screen with demo data in all four theme
presets). `test/playwright/run.sh --project smoke` runs one suite;
`PRESETS=seylo` and `SCREENS=` narrow the screens suite. Screenshots land in
`test/playwright/shots/`.

## End to end

`make e2e` builds test-signed releases (agents, panel image, installer),
creates three fresh VMs (two Colima VMs with Docker and one plain Lima
Ubuntu 24.04 VM without Docker), installs Seylo on them with the real
installer and runs 31 checks: joins, builds, deploys, zero-downtime
redeploys, crash policy, databases, backups to MinIO, cron, logs, moves,
replicas, updates with rollback, the CLI, MCP, the panel domain with an
ACME certificate from Pebble, uninstall. It takes about 40 minutes on an
Apple silicon Mac and needs Colima, Lima, minisign, jq, python3 and Node.js
(check 30 runs Playwright). The results and their evidence go to
`test/e2e-colima/RESULTS.md`.

```sh
KEEP=1 make e2e                  # keep the VMs afterwards
make e2e-checks CHECKS="7 8"     # rerun some checks on the kept VMs
make e2e-refresh                 # move kept VMs to the working tree through the panel's own update
make e2e-down                    # delete the VMs and ~/.cache/seylo-e2e
```

The scripts only use VM profiles named `seylo-e2e-*`. Details:
[test/e2e-colima/README.md](test/e2e-colima/README.md).

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
(`.github/workflows/release.yml`) from a pushed `v*` tag: the Draft release
job builds a draft release, then the Publish job checks the draft on its own
and publishes it.

Once, before the first release:

1. Make the release key pair with [minisign](https://jedisct1.github.io/minisign/):
   `minisign -G -p release.pub -s release.key`. Keep the secret key and its
   password offline (a password manager), never in the repository.
2. Put the public key (the `RW...` line of `release.pub`) into
   `brand/brand.json` as `minisignPublicKey`, run `make gen` and commit the
   result. Installers, agents and panels only trust files signed by this key.
3. Add two repository secrets (Settings > Secrets and variables > Actions):
   `MINISIGN_SECRET_KEY` with the full contents of `release.key` and
   `MINISIGN_PASSWORD` with its password.

Each release:

1. Run a dry run on `main`: Actions > Release > Run workflow, or
   `gh workflow run release.yml -f dry_run=true`. It runs the same checks
   and builds everything a release attaches (binaries, signed checksums,
   `install.sh`, both panel images, the signed manifest), signed with a
   throwaway key made inside the job, and publishes nothing. A run started
   by hand with `dry_run` off is refused: real releases only come from tags.
2. Tag the commit and push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
   The Draft release job checks that the tag is on the commit, runs
   `make install`, `make check-gen` and `make test`, then `make release` for
   exactly that tag, which makes the draft and pushes the image tags
   (`<version>`, and `latest` unless it is a pre-release) to
   `ghcr.io/seylo-dev/seylo`. One release runs at a time, and a running
   release is never cancelled by another tag. A `vX.Y.Z-<pre>` tag
   (`v0.1.0-rc.1`) makes a pre-release that installs and updates do not
   follow; to promote it, tag the same commit `vX.Y.Z`.
3. The Publish job (`scripts/release-publish.sh`) then checks the draft
   without trusting the job that made it, and publishes it only when every
   check passes:
   - `checksums.txt` and `manifest.json` are signed by `brand.json`'s
     `minisignPublicKey`, with this version in their trusted comments;
   - every release file is attached, and each file `checksums.txt` lists
     matches its signed sha256;
   - `manifest.json` names this version, this release's linux binaries,
     `install.sh` and panel image, and `install.sh` is this version's
     release build (not a test build);
   - the release is a pre-release exactly when the tag is;
   - `ghcr.io/seylo-dev/seylo:<version>`, and the digest the manifest pins,
     pull anonymously (as installs and updates pull them), with linux/amd64
     and linux/arm64.

   A stable version becomes the latest release, which installs and updates
   follow, unless a newer version already is; a pre-release never does. The
   run summary lists every check. When one fails, the draft stays a draft
   and the summary says what to do. Running Publish again on a release that
   is already published checks it and changes nothing.
4. On the first release only, the new package is private, so Publish stops
   with "The ghcr.io/seylo-dev/seylo package is private". Open it
   (github.com/orgs/Seylo-dev/packages > seylo), check that it is connected
   to the `App` repository, change its visibility to public (Package
   settings > Change visibility), then re-run the Publish job (the run's
   page > Publish > Re-run this job). It stays public for later releases.

To keep a release from going out on its own:

- Push the tag as a pre-release (`v0.1.0-rc.1`). Publish still publishes it,
  as a pre-release that installs and updates do not follow; tag the same
  commit `vX.Y.Z` when it is ready.
- Or cancel the workflow run (Actions > the run > Cancel workflow run)
  before the Publish job finishes. If the Draft release job had finished,
  the draft is complete and stays a draft: publish it later by re-running
  the Publish job. If it was still running, the draft may be half made:
  delete it and the tag as below.

If the Draft release job fails, or Publish refuses the draft's content (not
the private package), do not publish the draft by hand. Fix the cause on
`main`, delete the draft release if one was made, delete the tag
(`git push origin :refs/tags/v0.1.0` and `git tag -d v0.1.0`) and tag again.

`make release` is the local fallback for the Draft release job and the step
it runs. It needs the `v*` tag checked out, `GITHUB_TOKEN`,
`MINISIGN_SECRET_KEY` (the path of the key file), `MINISIGN_PASSWORD`, a
`docker login ghcr.io` and a buildx builder that builds linux/amd64 and
linux/arm64. `scripts/release-preflight.sh` first refuses a placeholder or
test signing key in `brand/brand.json`, a secret key that does not match it,
`INSTALLER_TEST_PUBLIC_KEY` in the environment and a repository the token
cannot push to (in Actions: a workflow running in another repository than
`brand.json`'s `githubOrg`/`githubRepo`). goreleaser then makes a draft
release with the binaries, signed checksums, `install.sh`, `openapi.json`
and the multi-arch panel image, and `scripts/release-manifest.sh` adds the
signed update manifest. `make release-dry-run` is the goreleaser half of the
dry run (it needs `MINISIGN_SECRET_KEY` and `MINISIGN_PASSWORD` too).

`scripts/release-publish.sh v0.1.0` is the local fallback for the Publish
job: the same checks, then the publish, with `gh` logged in to an account
that can write to the repository, `minisign`, `jq` and `curl`.
`scripts/release-publish.sh --check-image ghcr.io/seylo-dev/seylo:0.1.0`
runs only the anonymous pull check. `make test-release` tests the script
against a fake draft release and registry.
