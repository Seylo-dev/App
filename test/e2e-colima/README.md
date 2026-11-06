# End-to-end harness (three VMs)

`make e2e` (or `test/e2e-colima/run.sh`) builds test releases, installs Seylo on
three VMs with the real installer and runs the 31-check checklist. Results go to
`RESULTS.md` here (PASS / FAIL / BLOCKED with evidence per check).

| VM | What | Role |
|---|---|---|
| `seylo-e2e-a` | Colima (vz, `--network-address`), Docker | "panel + node here", can build; also the unlabeled infra containers `e2e-registry` (127.0.0.1:15000, panel images), `e2e-minio` (:19000, bucket `e2e-backups`), `e2e-pebble` (:14000) |
| `seylo-e2e-b` | Colima, Docker | joined node, most app checks |
| `seylo-e2e-c` | plain Lima Ubuntu 24.04, no Docker | joined node; `install.sh --yes` installs Docker (systemd cgroup driver) |

On the Mac (`serve.sh`, at the vzNAT bridge address, normally 192.168.64.1):

- `http://<mac>:18555` release server in GitHub's layout (`/<org>/<repo>/releases/download/v<ver>/...`,
  `/releases/latest/download/...`, the API shape at `/repos/<org>/<repo>/releases/latest`, `/install.sh`).
- `https://<mac>:18556/git/<app>.git` smart-HTTP git (the panel takes only `https://` URLs and the agent
  clones shallow). The certificate comes from a test-only CA that `serve.sh` adds to each VM's trust store.

Releases: N (`0.1.0`, installed), N+1 (`0.1.1`, self-update target), N+2 (`0.1.2`, a panel image that
exits at once, for the swap rollback). Agents, panel and installer are TEST builds: the agent's
`-X .../internal/update.TestRelease{BaseURL,PublicKey}`, the panel's `bun build --define
__TEST_RELEASE_{API_URL,PUBLIC_KEY}__` and `INSTALLER_TEST_PUBLIC_KEY` for `scripts/render-installer.sh`
point them at the release server and the TEST-ONLY key in `keys/`. The installer checks the signed
`manifest.json` like a real install and starts the panel image pinned by the digest in it (check 1).
The panel's TypeScript is built inside VM A so no darwin `.node` files get in.

## Steps

```sh
test/e2e-colima/up.sh          # create/start the VMs, routes between them
test/e2e-colima/serve.sh       # release + git servers on the Mac (serve.sh stop)
test/e2e-colima/infra.sh       # registry, MinIO, Pebble on A
test/e2e-colima/build.sh       # agents panel release git (any subset)
test/e2e-colima/publish.sh 0.1.1   # make a built release "latest"
test/e2e-colima/checks.sh 7 8  # rerun some checks (make e2e-checks CHECKS="7 8")
test/e2e-colima/refresh.sh     # put the working tree on the kept VMs (make e2e-refresh)
test/e2e-colima/down.sh        # delete the VMs and ~/.cache/seylo-e2e
```

`refresh.sh` builds the next test release from the working tree (0.1.3, then 0.1.4, ...; `build.sh`
with `E2E_BUILD_VERSIONS`), publishes it and runs the panel's own update (panel first, then the
nodes), so single checks can be rerun against new code without a fresh run. The repo keeps one
regenerated `0000_init` migration whose journal time moves forward, which drizzle would run again
over the kept databases: `schema-sync.ts` first adds the new tables, columns and indexes to the
running panel's `panel.db` and `metrics.db` and marks the new migration applied (additive changes
only; anything else stops the refresh and needs a fresh `make e2e`). After a refresh, check 22
(N -> N+1) cannot be rerun alone.

`KEEP=1 make e2e` keeps the VMs. Build output and state (API key, owner password, ids, per-check logs in
`state/results/NN.{status,evidence,log}`) live in `~/.cache/seylo-e2e`, outside `dist/` because
`goreleaser --clean` wipes that.

## Quirks

- macOS isolates vzNAT guests from each other (ARP between VMs fails) but forwards through the Mac, so
  `up.sh` installs an `e2e-routes` unit in each VM that routes the other two via the bridge address.
- No VM has a public IPv4: nodes are addressed by the private IPv4 their agents report (the address they
  dial the panel from), and the join command uses the address the API call reached the panel at (the
  panel node's public address is seeded from the setup link's host in check 2). The harness still maps
  node names to VM addresses and swaps in the panel URL if a loopback one shows up (check 3 records
  that as a failure).
- Joins go to the agents' TLS port (`https://<A>:3443`, the installer's default) with `--pin`; check 3
  asserts the command, `panel_pin` in B's and C's config.yml, and that a plain `http://` join to
  another server is refused without `--insecure`.
- The first-run port closes 24 h after its domain is live; check 4 moves that stored time into the past
  (one SQLite write in the panel container) and waits for the panel's minute sweep to close it.
- Check 31 (panel domain) runs last and puts everything back: it gives the panel a new
  `panel<time>.<A dashed>.sslip.io` name each run (so a certificate from an earlier Pebble never
  gets in the way), points A's ACME client at Pebble, adds Pebble's root (from its management port,
  a new one on every Pebble start) to the VMs' trust stores and restarts B's and C's agents so they
  read it. The Mac's keychain is left alone: only the check's curl calls (`--cacert`) and the macOS
  CLI (`SSL_CERT_FILE`, honoured on macOS since Go 1.27) trust Pebble. A test build of the panel
  trusts `<data dir>/panel/test-ca.pem` in its domain probe, so the domain turns active by itself
  (a panel without that hook gets the `panelDomainStatus` row written instead) and the panel asks B
  and C to reconnect and move. After an agent restart they come back on the domain and keep the old
  pinned `https://<A>:3443` as a standing fallback; the check then removes the domain, restarts them
  and waits (up to 8 minutes, the agent waits 5 minutes of failed connects) for them to return to
  that address by themselves. The node move is BLOCKED when the build the VMs run (the tree copy in
  A's `/root/e2e-src`) predates nodes moving to the panel domain; `refresh.sh` fixes that. The
  cleanup removes the domain, writes B's and C's old `panel_url`/`panel_pin` back (no `fallback:` block), removes A's
  ACME settings, the test CA and the trust-store root, and checks the nodes are back on
  `https://<A>:3443` with the pin.
- Some checks build on state from earlier ones. Check 5 recreates `node-app` with one deploy, and check 13
  searches its logs across two or more deploys, which check 7 adds: after rerunning 5, rerun 7 before 13
  (`make e2e-checks CHECKS="5 7 13"`).
- Run nothing that edits `checks.sh` or `lib.sh` while a run is going: bash reads the script as it goes.
- The scripts only take VM profiles named `seylo-e2e-*` (they create and delete them), so they never
  touch a VM you use for something else, such as the dev VM `seylo-a`.
