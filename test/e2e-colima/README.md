# End-to-end harness (three VMs)

`make e2e` (or `test/e2e-colima/run.sh`) builds test releases, installs Seylo on
three VMs with the real installer and runs the 40-check checklist. Results go to
`RESULTS.md` here (PASS / FAIL / BLOCKED with evidence per check).

| VM | What | Role |
|---|---|---|
| `seylo-e2e-a` | Colima (vz, `--network-address`), Docker | "panel + node here", can build; also the unlabeled infra containers `e2e-registry` (127.0.0.1:15000, panel images), `e2e-minio` (:19000, bucket `e2e-backups`), `e2e-pebble` (:14000), `e2e-headscale` (:18443 HTTPS, 3478/udp, check 40) and, from check 33, `e2e-gitea` (:13000, HTTPS) |
| `seylo-e2e-b` | Colima, Docker | joined node, most app checks |
| `seylo-e2e-c` | plain Lima Ubuntu 24.04, no Docker | joined node; `install.sh` installs the missing Docker by itself (systemd cgroup driver), no `--yes` needed |

On the Mac (`serve.sh`, at the vzNAT bridge address, normally 192.168.64.1):

- `http://<mac>:18555` release server in GitHub's layout (`/<org>/<repo>/releases/download/v<ver>/...`,
  `/releases/latest/download/...`, the API shape at `/repos/<org>/<repo>/releases/latest`, `/install.sh`).
- `https://<mac>:18556/git/<app>.git` smart-HTTP git (the panel takes only `https://` URLs and the agent
  clones shallow). The certificate comes from a test-only CA that `serve.sh` adds to each VM's trust store.
- `http://<mac>:18555/e2e-tools/tailscale_<version>_<arch>.tgz` Tailscale's static release for check 40,
  fetched once from pkgs.tailscale.com and checked against the sha256 in `lib.sh` (`E2E_TS_VERSION`).

Releases: N (`0.2.0`, installed), N+1 (`0.2.1`, self-update target), N+2 (`0.2.2`, a panel image that
exits at once, for the swap rollback), all from the working tree, and the base release (`0.1.1`,
`E2E_BASE`) built from its git tag `v0.1.1` (build step `base`: the tag's agent, installer, panel
image and releasetool), which the upgrade check (38) installs and updates. Agents, panel and installer are TEST builds: the agent's
`-X .../internal/update.TestRelease{BaseURL,PublicKey}`, the panel's `bun build --define
__TEST_RELEASE_{API_URL,PUBLIC_KEY}__` and `INSTALLER_TEST_PUBLIC_KEY` for `scripts/render-installer.sh`
point them at the release server and the TEST-ONLY key in `keys/`. The installer checks the signed
`manifest.json` like a real install and starts the panel image pinned by the digest in it (check 1).
The panel's TypeScript is built inside VM A so no darwin `.node` files get in. The working tree's
panel images get one test layer on top of `deploy/panel.Dockerfile`: the e2e's test-only CA
(`serve.sh`) and `NODE_EXTRA_CA_CERTS` pointing at it, so the panel trusts the Gitea of check 33,
which serves HTTPS with a certificate from that CA (the agents trust it through the VMs' stores).

## Steps

```sh
test/e2e-colima/up.sh          # create/start the VMs, routes between them
test/e2e-colima/serve.sh       # release + git servers on the Mac (serve.sh stop)
test/e2e-colima/infra.sh       # registry, MinIO, Pebble on A
test/e2e-colima/build.sh       # agents panel release git base (any subset)
test/e2e-colima/publish.sh 0.2.1   # make a built release "latest"
test/e2e-colima/checks.sh 7 8  # rerun some checks (make e2e-checks CHECKS="7 8")
test/e2e-colima/refresh.sh     # put the working tree on the kept VMs (make e2e-refresh)
test/e2e-colima/extra-installs.sh [deb] [ufw]  # install.sh on Debian 12 and on Ubuntu with ufw (not one of the 40)
test/e2e-colima/down.sh        # delete the VMs and ~/.cache/seylo-e2e
```

`extra-installs.sh` creates a fresh plain Lima VM for each run, `seylo-x-deb` (Debian 12, template
`debian-12`) and `seylo-x-ufw` (Ubuntu 24.04 with ufw on: deny incoming, ssh allowed), installs the
published release there as a panel with its own `install.sh` (Docker comes from get.docker.com), then
`test/install-smoke/smoke.sh` from the Mac sets the panel up through its API (owner, API key, a project,
`traefik/whoami` live) and curls the service's IP:port. On the ufw VM that address stays closed until the
`ufw allow <port>/tcp` the panel shows is run (the agent serves it itself, so ufw applies). The VMs pull the
pinned panel image from A's registry through relays (`e2e-regfwd-x` on A, port 15003) like check 38, then
are deleted (`KEEP_X=1` keeps them). It needs A running, `serve.sh`, `infra.sh` and `build.sh`; logs go to
`~/.cache/seylo-e2e/state/extra/`. It only creates and deletes VMs with those two names.

The same `smoke.sh` runs on GitHub's amd64 and arm64 runners after a release is published
(`.github/workflows/install-smoke.yml`, or by hand with a tag).

`refresh.sh` builds the next test release from the working tree (0.2.3, then 0.2.4, ...; `build.sh`
with `E2E_BUILD_VERSIONS`), publishes it and runs the panel's own update (panel first, then the
nodes), so single checks can be rerun against new code without a fresh run. New migrations apply as
in any update: `0000_init` is frozen since the first release and schema changes are new, add-only
migrations. After a refresh, check 22 (N -> N+1) cannot be rerun alone; check 38 upgrades to the
refreshed version instead of N.

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
- The default order is 1..30, 32..40, then 31.
- Check 3 joins C without `--yes`: the installer installs the missing Docker by itself and waits for the
  agent's first connection ("Connected: the node shows up in the panel now."). B and C join with the default
  join command, so they build images (canBuild), and check 6's inline and uploaded builds run on B, their own
  node (a kept B joined before 0.2.1 only gets a note).
- Check 39 takes C out of the panel (like check 38) and joins it with a join command made with "Build images
  on this node" unticked plus the node's own `--can-build`: C must not build. The same, now used, command
  again must exit 3 with "the panel refused this node". C then joins with a default command and builds.
  Then it gives the panel a domain the way check 31 does (`p31_domain_up`, and `p31_cleanup` afterwards),
  signs the owner in over the domain and turns "Serve on IP address" off from there (an API key and an
  IP:port session with a forged `Host` are refused first). http://<A>:3000 must stop answering from the
  Mac, B and C while 127.0.0.1 on A, the domain and A's own agent keep working; with B and C on the domain
  the agents' port closes too. `seylo panel ip-access on` opens both again. Last, the domain dies for the
  panel (the test CA goes, and one failed check is backdated so the next is the second in a row): IP access
  reopens by itself; with the CA back and the hour backdated it closes again. While IP access is closed the
  check reaches the API from A itself over 127.0.0.1 (`api_loop`), as the SSH tunnel would.
- Check 40 runs Tailscale against `e2e-headscale` (`headscale/headscale:v0.29.7`, pinned by digest, on A;
  `infra.sh` starts it with a certificate from `serve.sh`'s test CA, so run `serve.sh` first). A's own
  tailscaled is the owner's server (kernel mode, or userspace when A has no `/dev/net/tun`), C's tailscaled
  the laptop (userspace, curl through its SOCKS5 proxy on 127.0.0.1:1055). Both sign in with a Headscale
  pre-auth key (`tailscale up --login-server ... --accept-dns=false`). Headscale gives no HTTPS
  certificates, so Serve runs in HTTP mode on `http://e2e-a.ts.e2e.test`. The check turns Serve on through
  `tailscale.setServe` from the owner's IP:port session, reaches the panel from C over the tailnet, signs in
  there and closes IP access from that session (Lock to Tailscale). Then: an agent restart during a request
  loop drops nothing, `tailscale serve reset` gets the entry back, a panel restart replaces the socket,
  `tailscale down` for 5 minutes (backdated) reopens IP access and `tailscale up` plus a backdated hour
  closes it again, `seylo panel tailscale status` works with the agent stopped, `seylo panel ip-access on`
  reopens, `seylo panel tailscale off` / `on` remove and restore the entry. It cleans up: Serve off, IP access
  open, tailscaled removed from A and C, the Headscale nodes deleted. HTTPS mode and the real
  login.tailscale.com sign-in link stay a manual check.
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
- Check 32 talks to the real Docker Hub through the panel (search, tags, a config read: one pull from
  the anonymous rate limit at most).
- Check 33 starts `e2e-gitea` (gitea/gitea, HTTPS on 13000 with a certificate from the e2e test CA,
  admin `e2e` with a token in `state/gitea-token`), makes a private `e2e/watch-app` repository and
  pushes to it from the Mac. Gitea posts its webhooks to the panel's IP:port (`insecure` in
  `gitProviders.webhook`, as the panel has no domain then).
- Check 34 fills B's disk past the scheduled cleanup's line with `fallocate` (no data written) and
  restarts B's agent, which checks its disks when it starts and every 10 minutes; it waits up to 13
  minutes for the disk-triggered run, then removes the file and turns the schedule off again.
- Check 35 uses the owner's browser session (check 2's cookie jar, signed in again with the saved
  password when it ended) with `auth.reauth`, as host shells need. To show the agent's own refusal it
  writes the panel's `nodes.host_shell` back to on without telling the node (one SQLite write), so
  only the node's setting says no, then puts it back.
- Check 36 gives `whoami` a data volume with a marker file before cloning it.
- Check 37 runs ClickHouse on B (about 550 MB; B uses about 1 of its 4 GB with everything else there).
- Check 38 takes C out of A's panel (its services go first, like check 27), installs the base release
  (`E2E_BASE`, 0.1.1) as a panel + node on C with that release's own installer, makes real rows
  through its API (a project, an app with env, Postgres 17 with a row, a cron job saved with 7 for
  Sunday, which 0.1 panels accepted), then publishes this build and runs the normal update
  (`updates.updatePanel`, panel then node). C pulls the pinned panel images of A's registry through
  two small Python TCP relays (`e2e-regfwd` units: A's address -> A's 127.0.0.1:15000, C's
  127.0.0.1:15000 -> A), since Docker only pulls plain HTTP from 127.0.0.0/8. The 0.1.1 panel runs as
  uid 1000; after the update the panel must run as the panel user (61000) with its folder 0700 and
  `master.key` 0600 (check 3 asks the same of a fresh install). Afterwards it puts the
  published release back, uninstalls C and joins it to A again.
- Kept VMs installed before the panel user existed: the first agent of this build replaces the panel
  container once (same generation) to move it to the panel user, so check 3's "no roll after the
  join" can see a new container id on that one rerun.
- Run nothing that edits `checks.sh` or `lib.sh` while a run is going: bash reads the script as it goes.
- The scripts only take VM profiles named `seylo-e2e-*` (they create and delete them), so they never
  touch a VM you use for something else, such as the dev VM `seylo-a`.
