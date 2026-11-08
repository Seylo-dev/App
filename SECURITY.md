# Security

## Reporting a vulnerability

Report security problems privately through GitHub: on
[Seylo-dev/App](https://github.com/Seylo-dev/App), open the Security tab and
use "Report a vulnerability"
([direct link](https://github.com/Seylo-dev/App/security/advisories/new)).
If that form is not available, or you cannot use GitHub, email
**security@seylo.dev** instead. Do not open a public issue, pull request or
discussion for it.

Please include:

- what an attacker can do, and what they need first (no account, a member
  or admin account, an API or MCP key, control of a node, a position on the
  network between the panel and a node);
- the affected version (`seylo version` on a node, Settings > Updates in
  the panel) and how it was installed;
- steps to reproduce: requests, commands or a proof of concept;
- logs or a `seylo troubleshoot --dry-run` report if they help, with your
  own secrets removed.

We reply on the advisory (or by email), work out the fix with you there,
and publish the advisory with the release that fixes it. Tell us if you
want to be credited.

## Supported versions

Only the latest release gets security fixes. The panel updates itself and
every node from Settings > Updates, so moving to the latest release is one
switch.

## Threat model

What Seylo protects, and what it does not:

- The owner, and admins with full rights, are root on every node by design:
  they open host shells and run compose stacks, Dockerfiles and file mounts.
  Treat those accounts like root SSH keys.
- Members and guests stay inside the projects and services they were
  granted: no other project's data, secrets or logs, no root on a node
  (privileged containers, host mounts, the Docker socket, the host shell),
  no panel admin. A way out of a grant is a vulnerability.
- API keys and MCP tokens act as their owner, narrowed by their scope. MCP
  tokens are read-only unless allowed, and deletes need a person's approval.
  The AI assistant is off until an Anthropic API key is set; it runs
  queries as the person using it, and every change it asks for waits for a
  person's approval.
- A compromised panel, or a copy of `panel.db` together with `master.key`,
  is root on every node.
- A compromised node can lie about its own services, but cannot reach other
  nodes, their secrets or the panel's privileges. A node only receives what
  the services placed on it need, unless it builds: a node with Can build on
  also receives the source, git credentials and build-time variables of
  every service it builds, from any project, and pushes the images other
  nodes then run. Treat build nodes like the panel. Each deployment shows
  which node built it.
- Since 0.2.1 new nodes build by default, which partly reverses a fix from
  the 0.2 audit. 0.2 made every node that joins start with Can build off,
  so a join token could not produce a build node. In 0.2.1 the join token
  carries the choice ("Build images on this node" in Add node, ticked by
  default), so whoever runs a default join command gets a build node: it
  receives the source, git credentials and build-time variables of every
  service that builds on it, from any project. What limits it:
  - it is the explicit choice of whoever makes the join command, and they
    can untick it; that is an owner or admin with `nodes.manage`, from a
    browser with a sign-in from the last 15 minutes, or an API key that
    may manage nodes, and the `createJoinToken` audit row records the
    value that applies;
  - the token is single-use, valid for one hour, and can be revoked;
  - the node cannot change its own value: `--can-build` only writes its
    config.yml, and a re-join of a known node (also after a master key
    rotation) keeps the value the panel has;
  - services build on their own node first, so most builds stay where the
    service runs. A build node still gets builds of services pinned to it
    and of services whose own node is offline or cannot build;
  - an owner or admin turns it off under Nodes at any time.

  Join tokens made before the update to 0.2.1, and nodes that joined
  before it, keep 0.2's behavior. Untick the box for any server you would
  not trust with other projects' source and secrets.
- Backups and restores go straight from the node to the bucket, but nodes
  never get a backup destination's keys: the panel presigns each request of
  a running backup or restore for that run's own object only (and makes the
  multipart start, finish and abort steps and the keepLast deletes itself),
  so a compromised node can reach the backups of the services it runs, not
  other nodes' backups. The panel only records, restores and deletes an
  object named for the backup run it belongs to. Older agents (before 0.2)
  cannot back up to a 0.2 panel until the node is updated, because they
  would need the keys.
- Agents dial the panel over TLS: the panel's domain certificate, or the
  agents' TLS port (3443) with the panel's key pinned by the join command.
  Plain HTTP between a node and a panel on another host needs `--insecure`.
- Until the panel has a domain, the panel itself (the setup link included)
  is plain HTTP on its port (3000 by default). Create the owner and sign
  in over an SSH tunnel or a network you trust, or set the panel domain
  first.
- Docker publishes the panel port and the agents' TLS port past ufw. Since
  0.2.1 the owner can have them published on 127.0.0.1 only (Settings >
  General > Panel domain: "Serve on IP address", "Agents' port"). Closing
  needs the owner, from a browser session with a sign-in from the last 15
  minutes, on a request that came over a private path that works (the
  panel domain through the trusted proxy, or the tailnet listener), with
  the panel node's agent able to bind loopback and no node that closing
  would cut off. Every change is audited and raises a security alert. It
  fails open: when the private path stops working the ports reopen by
  default (the 0.2.0 baseline, never worse), as they do after a failed
  roll or with an older agent; "Keep IP access closed" is opt-in.
  `sudo seylo panel ip-access on` on the server and an SSH tunnel to
  127.0.0.1 always get the owner back in. On Docker older than 28, other
  machines on the same local network may still reach ports published on
  127.0.0.1; the panel and the node's health check warn.
- Since 0.2.1 the panel can be served on the owner's tailnet through the
  owner's own tailscaled (Tailscale Serve to a unix socket). That socket
  is a second listener that trusts `X-Forwarded-*` and the
  `Tailscale-User-Login` header: it is mode 0600, owned by the panel user
  inside the 0700 data folder, so only root and the panel connect, and
  Serve drops whatever a client sent in those headers. The panel answers
  only on the server's own tailnet name, refuses Funnel requests, and uses
  the tailnet login for the activity log only, never to sign anyone in.
  Every device the tailnet's access rules allow reaches the sign-in page
  (Tailscale's default policy allows all, including other users of a
  shared tailnet; the card offers a narrower grant), and installing
  Tailscale adds a firewall rule ahead of ufw for `tailscale0`. The panel
  can read tailscaled's status, keep one Serve entry, start an interactive
  sign-in and turn Tailscale DNS off; it never turns on Funnel. The
  sign-in link puts the server on whichever tailnet opens it, so only the
  owner gets it, it is kept in memory for 10 minutes and never stored or
  logged. No Tailscale secret is stored by Seylo, and `no_tailnet: true`
  in the node's config.yml (`seylo panel tailscale off`) turns all of it
  off from the server.
- Out of scope: the apps you deploy, and what you turn off yourself
  (`--insecure`, `--allow-unsigned`, `--trust-on-first-use`).

## Where secrets live

On the panel's server, in `/var/lib/seylo/panel/` (mode 0700, owned by the
panel's user, uid and gid 61000, which no login user has; the key and token
files are mode 0600). Only root and the panel container can read it. Before
0.2.0-rc.2 the panel ran as uid 1000, which on most cloud images is the
default login user (`ubuntu`, `debian`, `ec2-user`), and that user could
read `master.key` without sudo; the agent gives the folder to the panel's
user the first time it starts the panel after its update. The installer
warns when an account already has uid or gid 61000.

- `master.key`: seals every stored secret (env values and secrets, registry,
  Git and GitHub credentials, backup destinations, notification channels,
  the Anthropic key, two-factor secrets) with AES-256-GCM.
- `panel.db`: accounts, grants, settings and the activity log. Secrets in it
  are sealed with `master.key`; passwords are argon2id hashes, sessions and
  API and MCP tokens SHA-256 hashes. A copy without `master.key` holds no
  usable secret, but back the two up together and keep both private.
- `agent-tls.key`: the key of the agents' TLS port, which nodes pin.
- `setup-token` and `join-token`: the one-time setup link and the panel's
  own node's join token.

If a copy of this folder leaks, run `sudo seylo panel rotate-key
--new-panel-identity` on the panel's server: it replaces `master.key`, seals
every secret again, makes new identity keys and a new `agent-tls.key`, and
prints the `seylo join` command (with the new pin) for each node. With
`--keep-panel-identity` (only `master.key` leaked) nodes keep working. Both
delete recovery codes.

On every node, in `/var/lib/seylo/` (owned by root; `agent.key` and
`state/desired.pb` are mode 0600):

- `agent.key`: the node's Ed25519 identity, which the panel knows it by.
- `config.yml`: the panel's address and pin (the join token is removed once
  the node joined).
- `state/desired.pb`: what the node runs, with the env values and secrets of
  the services placed on it, and only those.
- `services/<id>/files/` and `services/<id>/volumes/`: the services' file
  mounts (which hold secrets) and volume data. `services/` and every
  `services/<id>/` are mode 0700, so only root reaches them (Docker mounts
  them into containers as root). Before 0.2.0-rc.2 these folders were 0755
  under the data dir's 0711, so a local account that learned a service id
  could read file mounts (0644 unless the service sets a mode) and volume
  data; the agent sets 0700 when it starts, and the node's health check
  warns when a service folder is open to other accounts.

The release signing key (minisign) is kept offline by the maintainers, and
in GitHub only as secrets of the `release` environment of
[Seylo-dev/App](https://github.com/Seylo-dev/App). Only the Sign job of the
release workflow, for a `v*` tag and after a maintainer approves it, can
read them. The job that builds a release (and runs `bun install` and the npm
build scripts) never sees the key.

## How releases are signed

Every release attaches two signed files, signed with
[minisign](https://jedisct1.github.io/minisign/):

- `checksums.txt` (+ `checksums.txt.minisig`): the sha256 of every binary,
  `install.sh` and `openapi.json`;
- `manifest.json` (+ `manifest.json.minisig`): the update manifest: the
  version, the sha256 of the linux binaries and `install.sh`, and the panel
  image pinned by digest.

Each signature's trusted comment names the file and the version, for
example `seylo 0.2.0 checksums.txt`. The release public key is:

```
RWTwvrETQsecIkFOCm1ceiZwfxVq6sFfiEmJfWnUVv7UBIn0jWm2h1ip
```

It is `minisignPublicKey` in [brand/brand.json](brand/brand.json) and is
compiled into every agent and panel. The installer verifies
`manifest.json`'s signature (with OpenSSL 3 or minisign) and the sha256 of
what it downloads before it changes anything; agents and the panel do the
same before every update and refuse an unsigned or mismatching release.
`--allow-unsigned` turns the installer's check off; never use it with a real
release.

Releases are built by GitHub Actions from a pushed `v*` tag
([.github/workflows/release.yml](.github/workflows/release.yml)): a job whose
token can only read, and that gets no secret, tests the tag and builds the
web app and the panel (the only job that runs npm packages); a job with no
access to the key packages that build into a draft; the Sign job signs it;
and the Publish job verifies every signature and hash against the key in
`brand.json` before it publishes the draft.

## Verify a download by hand

You need [minisign](https://jedisct1.github.io/minisign/) (`brew install
minisign`, `apt install minisign`, or a release from its site). For the
laptop CLI on an Apple silicon Mac (pick your file from the
[latest release](https://github.com/Seylo-dev/App/releases/latest)):

```sh
base=https://github.com/Seylo-dev/App/releases/latest/download
for f in checksums.txt checksums.txt.minisig seylo_darwin_arm64; do curl -fsSLO "$base/$f"; done
minisign -Vm checksums.txt -P RWTwvrETQsecIkFOCm1ceiZwfxVq6sFfiEmJfWnUVv7UBIn0jWm2h1ip
awk '$2 == "seylo_darwin_arm64"' checksums.txt | shasum -a 256 -c -
```

minisign must print `Signature and comment signature verified` and a
trusted comment with the version you expect; the last line must print
`seylo_darwin_arm64: OK`. On Linux use `sha256sum -c -` instead of
`shasum -a 256 -c -`. On Windows, run `minisign -Vm checksums.txt -P <key>`
the same way and compare `(Get-FileHash seylo_windows_amd64.exe).Hash` with
that file's line in `checksums.txt` (case does not matter).

The same works for `install.sh`: download it from the release with
`checksums.txt` and its signature, check it, then run `sudo sh install.sh`
instead of piping `https://install.seylo.dev` into `sh`.

To check what the panel and the nodes will update to, verify the manifest
and read the panel image digest it pins:

```sh
for f in manifest.json manifest.json.minisig; do curl -fsSLO "$base/$f"; done
minisign -Vm manifest.json -P RWTwvrETQsecIkFOCm1ceiZwfxVq6sFfiEmJfWnUVv7UBIn0jWm2h1ip
jq -r '.panel.image + "@" + .panel.digest' manifest.json
```

## Scope

In scope: the `seylo` binary (node agent, node CLI and laptop CLI), the
panel and its web app, the installer, release signing and the update path,
the release workflow, and the templates in `templates/`.

Out of scope: the apps you deploy with Seylo, and the third-party images
that templates or database tools use (report those to their projects).

The minisign secret key in `test/e2e-colima/keys` is committed on purpose:
it signs the end-to-end test's local releases only, release builds refuse
it, and no real install trusts it (see that folder's README).
