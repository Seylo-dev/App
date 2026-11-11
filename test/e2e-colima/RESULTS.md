# E2E results

Written by `test/e2e-colima/checks.sh` from `~/.cache/seylo-e2e/state/results` (rerun one check with
`test/e2e-colima/checks.sh <N>`). VMs: seylo-e2e-a (panel + node, Colima), seylo-e2e-b (Colima), seylo-e2e-c (plain
Lima Ubuntu 24.04, Docker installed by install.sh). Release server and git server on the Mac.

| # | Check | Status | When |
|---|---|---|---|
| 1 | install.sh panel + node on A (signed manifest, image by digest); setup link; panel adopted as protected service | PASS | 50s, 2026-11-11 21:47, panel 0.2.0 |
| 2 | Owner through the setup link; API key; REST op routes | PASS | 1s, 2026-11-11 21:47, panel 0.2.0 |
| 3 | Join B and C (C gets Docker from install.sh); 3 nodes online; health checks | PASS | 58s, 2026-11-11 21:48, panel 0.2.0 |
| 4 | Image service on B with an auto domain; first-run IP:port -> 308 -> closed | PASS | 14s, 2026-11-11 21:48, panel 0.2.0 |
| 5 | Railpack git build on A, run on B through the 127.0.0.1:5755 relay | PASS | 56s, 2026-11-11 21:49, panel 0.2.0 |
| 6 | Dockerfile from git, inline Dockerfile and uploaded archive deploy | PASS | 26s, 2026-11-11 21:49, panel 0.2.0 |
| 7 | Zero downtime redeploy; failing health check keeps old; rollback | PASS | 123s, 2026-11-11 21:52, panel 0.2.0 |
| 8 | Crash policy: 5s restart, stop after N, crash report + one alert per streak | PASS | 113s, 2026-11-11 21:53, panel 0.2.0 |
| 9 | Env references across services; env.analyze flags cross-node address | PASS | 8s, 2026-11-11 21:54, panel 0.2.0 |
| 10 | Postgres: internal URL, project isolation, TLS exposure, web UI, DB shell | PASS | 60s, 2026-11-11 21:55, panel 0.2.0 |
| 11 | Backup Postgres and a volume to MinIO, restore both | PASS | 30s, 2026-11-11 21:55, panel 0.2.0 |
| 12 | Cron: schedule, run-now, history, keeps running while the panel is down | PASS | 240s, 2026-11-11 21:59, panel 0.2.0 |
| 13 | Logs search/follow across deploys; console stdin; shell PTY; files | PASS | 16s, 2026-11-11 21:59, panel 0.2.0 |
| 14 | Metrics: node and service series have samples | PASS | 1s, 2026-11-11 21:59, panel 0.2.0 |
| 15 | Move a service with a volume B -> C; data intact; domain follows | PASS | 27s, 2026-11-11 22:00, panel 0.2.0 |
| 16 | Replicas on B and C, entry on B; failover when either container dies (round robin and sticky) | PASS | 111s, 2026-11-11 22:02, panel 0.2.0 |
| 17 | Compose stack from pasted YAML (two services, shared volume) | PASS | 18s, 2026-11-11 22:02, panel 0.2.0 |
| 18 | A template from the catalog creates and runs | PASS | 12s, 2026-11-11 22:02, panel 0.2.0 |
| 19 | Global and per-service maintenance pages; timed expose locked to an IP | PASS | 320s, 2026-11-11 22:07, panel 0.2.0 |
| 20 | Panel down: apps, routes, crash restarts, cron keep working; outbox delivers | PASS | 247s, 2026-11-11 22:12, panel 0.2.0 |
| 21 | Agent restart adopts running services without restarting them | PASS | 47s, 2026-11-11 22:12, panel 0.2.0 |
| 22 | Self-update N -> N+1 (panel first, then nodes); broken N+2 panel rolls back | PASS | 38s, 2026-11-11 22:13, panel 0.2.1 |
| 23 | Cleanup preview + run removes only seylo-labeled garbage | PASS | 17s, 2026-11-11 22:13, panel 0.2.1 |
| 24 | Laptop CLI: login, deploy, env set/list, logs -f | PASS | 50s, 2026-11-11 22:14, panel 0.2.1 |
| 25 | MCP: read-only token lists tools and runs a query; destructive call -> approval | PASS | 1s, 2026-11-11 22:14, panel 0.2.1 |
| 26 | seylo troubleshoot --dry-run redacts; seylo status shows the connection | PASS | 1s, 2026-11-11 22:14, panel 0.2.1 |
| 27 | Uninstall on C leaves nothing behind | PASS | 30s, 2026-11-11 22:15, panel 0.2.1 |
| 28 | C (systemd cgroup driver) runs containers under seylo.slice | PASS | 0s, 2026-11-11 22:15, panel 0.2.1 |
| 29 | (stretch) ACME certificate from a local Pebble CA | PASS | 4s, 2026-11-11 22:15, panel 0.2.1 |
| 30 | Web smoke with Playwright against the e2e panel | PASS | 4s, 2026-11-11 22:15, panel 0.2.1 |
| 31 | Panel domain: Pebble HTTPS, Secure cookie, HSTS, IP:port -> domain, nodes move to it, CLI | PASS | 380s, 2026-11-11 22:40, panel 0.2.1 |
| 32 | Docker Hub: search, tags, inspect traefik/whoami on the real Docker Hub; dockerHub.create on B live on its auto domain | PASS | 8s, 2026-11-11 22:15, panel 0.2.1 |
| 33 | Gitea provider on A: a push outside the watch path skips (reason logged), inside deploys, [skip ci] skips | PASS | 47s, 2026-11-11 22:16, panel 0.2.1 |
| 34 | Scheduled cleanup on B: a disk line triggers a run that removes only labelled resources and reports them | PASS | 15s, 2026-11-11 22:16, panel 0.2.1 |
| 35 | Host shell on B: owner turns it on with re-auth, hostname through the panel's socket, audited, agent refuses when off | PASS | 24s, 2026-11-11 22:16, panel 0.2.1 |
| 36 | Clone whoami with its data into another project on C; move a service between projects (impact list, keeps serving) | PASS | 157s, 2026-11-11 22:19, panel 0.2.1 |
| 37 | Valkey, ClickHouse, Postgres 18 + pgvector on B: app connects, TLS exposure, shell query, backup to MinIO, restore | PASS | 88s, 2026-11-11 22:20, panel 0.2.1 |
| 38 | Upgrade: a 0.1.1 panel and node with real rows move to this build by the normal update; 0001 applies, data survives | PASS | 55s, 2026-11-11 22:21, panel 0.2.1 |
| 39 | Build default: Add node's box decides Can build, a refused join exits 3; Serve on IP address off over the domain, CLI and domain-death reopen | PASS | 219s, 2026-11-11 22:25, panel 0.2.1 |
| 40 | Panel on Tailscale (Headscale): Serve over HTTP to the panel's socket, reached from C, Lock to Tailscale, automatic and CLI recovery | PASS | 245s, 2026-11-11 22:29, panel 0.2.1 |
| 41 | Move the panel A -> B in the browser: data, keys, registry and sign-ins come along, every node follows; a failed move rolls back; back to A | PASS | 210s, 2026-11-11 22:33, panel 0.2.1 |
| 42 | Export whoami with its volume and a Postgres with its data from e2e-exports on B, import both into e2e-imports on C: env, cron job, the volume's file, the rows, basic auth; refusals | PASS | 51s, 2026-11-11 22:33, panel 0.2.1 |
| 43 | Database version: patch update and a MongoDB major upgrade keep the data | PASS | 37s, 2026-11-11 22:34, panel 0.2.1 |

43 passed, 0 failed, 0 blocked/skipped/not run.

## Evidence

### 1. install.sh panel + node on A (signed manifest, image by digest); setup link; panel adopted as protected service: PASS

```
ok   install.sh printed the setup link http://192.168.5.1:3000/setup?t=<redacted>
note: the link host is not A's vzNAT address 192.168.64.3 (the VM has two interfaces)
ok   panel answers on http://192.168.64.3:3000/api/health
ok   seylo.service is active on A
ok   A's agent joined its own panel: Panel: http://127.0.0.1:3000 (connected, version 0.2.0)
ok   install.sh checked the signed release manifest
ok   the panel runs the release's image pinned by digest (127.0.0.1:15000/seylo:0.2.0@sha256:8326db7c12f20de981e3e293ca05d8b01bd7936d32824e7c1a3fdc51c3452319)
panel container 4b3a6cc472db: {"seylo.generation":"1","seylo.kind":"app","seylo.managed":"true","seylo.project":"panelproject0000","seylo.protected":"true","seylo.replica":"0","seylo.service":"panel00000000000","seylo.user":"61000:61000"}
ok   panel container is in project panelproject0000
ok   panel container is protected
ok   the panel runs as the panel user with its folder closed to login users (61000:61000 61000:61000:700 61000:61000:600)
ok   no roll after the join: same container 4b3a6cc472db (now 4b3a6cc472db)
seylo panel status: Panel running (running), version 0.2.0, http://127.0.0.1:3000 IP access: open (0.0.0.0:3000); agents' port: open (0.0.0.0:3443) 
ok   the agent manages the panel service
ok   panel container survives an agent restart (same id, StartedAt 2026-11-11T19:46:33.345062666Z)
ok   panel still answers after the agent restart
```

### 2. Owner through the setup link; API key; REST op routes: PASS

```
setup.status: {"ownerExists":false,"link":{"valid":true,"expiresAt":"2026-11-11T20:46:33.597Z"}}
ok   the setup link is valid
ok   owner owner@e2e.test created through setup.createOwner (session cookie)
ok   API key created with the owner session (prefix seylo_key_pV...)
ok   auth.whoami with the API key: {"email":"owner@e2e.test","kind":null}
ok   Panel project: {"id":"panelproject0000","name":"Panel","protected":true,"serviceCount":1}
ok   Panel project is protected
ok   panel service: {"id":"panel00000000000","name":"panel","status":"running","protected":true,"placements":["colima-seylo-e2e-a"]}
```

### 3. Join B and C (C gets Docker from install.sh); 3 nodes online; health checks: PASS

```
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.0' --pin 'sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf'
ok   the join command uses the agents' TLS port with --pin (insecureTransport false)
ok   the join command needs no --insecure
ok   installer join on seylo-e2e-b finished: ==> Docker;Docker 29.5.2 is running;Turning on Docker live-restore: containers keep running while Docker restarts;==> Joining https://192.168.64.3:3443;Connected: the node shows up in the panel now.;
ok   the installer on B waited for the agent's first connection and says it is connected
ok   C had no Docker before its first join
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.0' --pin 'sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf'
ok   the join command uses the agents' TLS port with --pin (insecureTransport false)
ok   the join command needs no --insecure
ok   installer join on seylo-e2e-c finished: ==> Docker;Docker is missing: installing it with the official script from get.docker.com (--no-docker-install skips this);Using systemd to manage Docker service;INFO: Docker daemon enabled and started;Client: Docker Engine - Community;Server: Docker Engine - Community;To run Docker as a non-privileg
ok   the installer on C installed Docker by itself, without --yes (Docker is missing: installing it with the official script from get.docker.com (--no-docker-install skips this))
ok   the installer on C waited for the agent's first connection and says it is connected
ok   3 nodes online
ok   b joined with a default join command builds images (canBuild true)
ok   c joined with a default join command builds images (canBuild true)
node a: {"id":"pzy1aouwvqjcx9wm","name":"colima-seylo-e2e-a","status":"online","publicIpv4":null,"agentVersion":"0.2.0","canBuild":true,"facts":{"hostname":"colima-seylo-e2e-a","os":"ubuntu 24.04","arch":"arm64","cpuCores":4,"dockerVersion":"29.5.2","cgroupVersion":2}}
ok   node a has facts
health a: {"pass":20,"warn":0,"fail":0,"skipped":0} not passing: []
ok   health check on a has no fail
node b: {"id":"e6nzwjikjvlxzc3o","name":"e2e-b","status":"online","publicIpv4":null,"agentVersion":"0.2.0","canBuild":true,"facts":{"hostname":"colima-seylo-e2e-b","os":"ubuntu 24.04","arch":"arm64","cpuCores":2,"dockerVersion":"29.5.2","cgroupVersion":2}}
ok   node b has facts
health b: {"pass":19,"warn":1,"fail":0,"skipped":0} not passing: ["network.publicAddress=warn: No public address is known, so IP:port links, exposed databases and load balancing use the"]
ok   health check on b has no fail
node c: {"id":"7bwmtcri068hpbja","name":"e2e-c","status":"online","publicIpv4":null,"agentVersion":"0.2.0","canBuild":true,"facts":{"hostname":"lima-seylo-e2e-c","os":"ubuntu 24.04","arch":"arm64","cpuCores":2,"dockerVersion":"29.9.3","cgroupVersion":2}}
ok   node c has facts
health c: {"pass":18,"warn":2,"fail":0,"skipped":0} not passing: ["proxy.running=warn: the proxy container does not exist yet","network.publicAddress=warn: No public address is known, so IP:port links, exposed databases and load balancing use the"]
ok   health check on c has no fail
b config.yml: panel_url: https://192.168.64.3:3443 panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf 
ok   b joined over https:// with the panel's key pinned (panel_pin, no insecure_transport)
c config.yml: panel_url: https://192.168.64.3:3443 panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf 
ok   c joined over https:// with the panel's key pinned (panel_pin, no insecure_transport)
plain join refused: time="2026-11-11T21:48:21+02:00" level=fatal msg="exit status 1"
ok   the agent refuses a plain-HTTP join to another server without --insecure (and writes nothing)
C Docker after install.sh: 29.9.3 cgroup driver systemd v2 
```

### 4. Image service on B with an auto domain; first-run IP:port -> 308 -> closed: PASS

```
ok   B's wildcard domain: 192-168-64-4.sslip.io (sslip.io resolves it to B's address)
ok   whoami deployed on B (deployment live)
ok   first-run IP:port 192.168.64.4:43599 answers 200 before any domain
auto domain whoami.192-168-64-4.sslip.io (https acme)
ok   http://whoami.192-168-64-4.sslip.io answers through B's Traefik: Hostname: whoami
ok   first-run 192.168.64.4:43599 now redirects: 308 -> http://whoami.192-168-64-4.sslip.io/
firstRun after the domain went live: {"domainLiveAt":"2026-11-11T19:48:28.672Z","closeWhenDomainLive":true,"redirectToPrimary":true,"status":"redirecting","address":"192.168.64.4:43599","redirectTo":"http://whoami.192-168-64-4.sslip.io","closeAt":"2026-11-12T19:48:28.672Z","firewallHint":null}
the redirect closes by itself at 2026-11-12T19:48:28.672Z (too far to wait); moving that time 1 minute into the past in the panel database
ok   first-run 192.168.64.4:43599 closed by itself once closeAt passed (connection refused; exposures.get: {"status":"closed","address":null})
```

### 5. Railpack git build on A, run on B through the 127.0.0.1:5755 relay: PASS

```
deployment: {"status":"live","builder":"railpack","builtOn":"colima-seylo-e2e-a","shippedTo":["e2e-b"],"image":"127.0.0.1:5755/95wdmgucqx0z0d03:1","digest":"sha256:07fe2e3cd744b2fbaf665caaef7d127b0c4328d5e9e29c4e8a91c602c16e42a8","steps":["clone=ok","build=ok","ship=ok","health=ok","switch=ok"],"error":null}
ok   Railpack build from https://192.168.64.1:18556/git/node-app.git is live
ok   built on A (can-build): builtOn=colima-seylo-e2e-a
ok   shipped to B
deploy log says: Building on colima-seylo-e2e-a.|#1 pulling image moby/buildkit:buildx-stable-1 4.5s done|#1 creating container buildx_buildkit_seylo-builder-6u2sk94xig5nksow-2c-3g0 0.4s done|
container on B runs image 127.0.0.1:5755/95wdmgucqx0z0d03:1@sha256:07fe2e3cd744b2fbaf665caaef7d127b0c4328d5e9e29c4e8a91c602c16e42a8
ok   B pulled it through the 127.0.0.1:5755 relay by digest
ok   the app answers on its first-run address 192.168.64.4:34279
```

### 6. Dockerfile from git, inline Dockerfile and uploaded archive deploy: PASS

```
ok   Dockerfile build from git (go-app) is live
ok   go-app answers: go-app dockerfile on go-app
ok   inline Dockerfile service is live
ok   built on B, its own node (builtOn=e2e-b)
ok   inline-app answers inline-ok
POST /api/uploads/services/<id> -> 200 {"uploadId":"31ygu2zki7g7jit9","sizeBytes":632,"deployment":{"id":"3c44jnbea8s96glb","serviceId":"qxykddgwry36uat1","generation":1,"status":"queued","live":false,"trigger":"api","actor":"owner@e2e.tes
ok   uploaded archive service is live
ok   built on B, its own node (builtOn=e2e-b)
ok   upload-app answers upload-app ok
```

### 7. Zero downtime redeploy; failing health check keeps old; rollback: PASS

```
redeploy v1 -> v2 ended live; 620 requests during it, 0 not 200 ( 620 200 )
ok   zero downtime: no failed request during the redeploy
ok   v2 serves after the redeploy (Name: v2)
deploy with a failing health check ended failed: {"error":"e2e-b: not healthy after 30s: health check never passed: http check GET /: status 200\nlast output:\n2026/11/11 19:51:18 Starting up on port 80 The previous version stayed live.","steps":["clone=skipped","build=skipped","ship=ok","health=failed","switch=skipped"]}
ok   the failing deploy is marked failed
ok   the old version keeps serving (Name: v2)
node-app redeploy of the new commit ended live: {"app":"node-app","version":"v2","host":"node-app","greeting":null,"upstream":null}
ok   node-app v2 is live
rollback to r01ruh51qwkhmc4l ended live ({"trigger":"rollback","rollbackOf":"r01ruh51qwkhmc4l","image":"127.0.0.1:5755/95wdmgucqx0z0d03:1"}): {"app":"node-app","version":"v1","host":"node-app","greeting":null,"upstream":null}
ok   rollback serves v1 again
```

### 8. Crash policy: 5s restart, stop after N, crash report + one alert per streak: PASS

```
restart on: 3 crashes in 45s; die -> next start gaps: 5 6 5 s
ok   the service is restarted after each crash
ok   the wait before a restart is the fixed 5s (gaps 5 6 5 )
crash reports in the panel: 4 ([{"streak":1,"action":"restarting","exit_code":3},{"streak":2,"action":"restarting","exit_code":3},{"streak":3,"action":"restarting","exit_code":3},{"streak":4,"action":"restarting","exit_code":3}])
ok   a crash report carries the last log lines (crash-line)
crash alerts: [{"title":"crasher crashed","message":"Exit code 3, restarting in a few seconds."}]
ok   one alert for the whole streak (3 crashes)
stopAfterCrashes=2: status crashed, 0 starts in the 20s after
ok   the service stays stopped after the crash limit
ok   a crash_limit alert was raised
restart off: 1 start(s) in 30s after services.restart (one crash after 6s), status crashed
ok   with restart off the crashed service is not restarted
```

### 9. Env references across services; env.analyze flags cross-node address: PASS

```
references button: ["crasher: URL,DOMAIN,INTERNAL_URL,INTERNAL_HOST","go-app: URL,DOMAIN,INTERNAL_URL,INTERNAL_HOST","inline-app: URL,DOMAIN,INTERNAL_URL,INTERNAL_HOST","node-app: URL,DOMAIN,INTERNAL_URL,INTERNAL_HOST","upload-app: URL,DOMAIN,INTERNAL_URL,INTERNAL_HOST","whoami: URL,DOMAIN,INTERNAL_URL,INTERNAL_HOST"]
envref container output: GREETING=s3cr3t-e2e PEER=v2
ok   ${{whoami.SECRET_TOKEN}} resolved at deploy
ok   ${{whoami.WHOAMI_NAME}} resolved at deploy
env.analyze on far-client (node C): [{"code":"internal-address-other-node","severity":"error","message":"whoami runs on another node"}]
ok   the internal address of whoami (node B) is flagged on node C
```

### 10. Postgres: internal URL, project isolation, TLS exposure, web UI, DB shell: PASS

```
internal URL: postgresql://app:<redacted>@pg:5432/app
ok   Postgres 17 on B is running
ok   an app in the same project connects by the internal URL (PG-CONNECTED)
ok   an app in ANOTHER project cannot reach it (PG-FAILED-10 PG-FAILED-11)
exposed: {"host":"192.168.64.4","port":25432,"user":"app","tlsParams":"sslmode=require"}
ok   the exposed connection uses the database's own user and password
ok   psql from the Mac over TLS (sslmode=require): tls=true TLSv1.3
psql sslmode=disable: psql: error: connection to server at "192.168.64.4", port 25432 failed: FATAL:  this port only accepts TLS connections: connect with sslmode=require
ok   the exposed port refuses a login without TLS, with the gate's message
web UI ticket URL: https://seylo-db-3xh4oi65z7xch6lp.192-168-64-4.sslip.io/_seylo/ticket?t=<redacted>
ok   the web UI ticket opens pgweb through B's edge (seylo-db-3xh4oi65z7xch6lp.192-168-64-4.sslip.io, 200)
ok   the DB shell ran a query without a password (select 40+2 -> 42)
```

### 11. Backup Postgres and a volume to MinIO, restore both: PASS

```
ok   MinIO destination http://192.168.64.3:19000/e2e-backups
database backup run: {"kind":"backup","status":"succeeded","objectKey":"e2e/3xh4oi65z7xch6lp/b6lhkh1wj5mcohr9/20261111T195503Z-5hiojpy7l8ksbobu.sql.gz","sizeBytes":1451,"error":null}
ok   the Postgres backup succeeded
ok   the backup object is in MinIO
restore run: {"kind":"restore","status":"succeeded","objectKey":"e2e/3xh4oi65z7xch6lp/b6lhkh1wj5mcohr9/20261111T195503Z-5hiojpy7l8ksbobu.sql.gz","sizeBytes":1451,"error":null}
ok   the restored database has the marker row
volume backup run: {"kind":"backup","status":"succeeded","objectKey":"e2e/5tncuv5wg35b33zv/k8hj01t8s1ubi056/20261111T195516Z-b25uxwtzxv09tm0d.tar.gz","sizeBytes":263,"error":null}
volume restore run: {"kind":"restore","status":"succeeded","objectKey":"e2e/5tncuv5wg35b33zv/k8hj01t8s1ubi056/20261111T195516Z-b25uxwtzxv09tm0d.tar.gz","sizeBytes":263,"error":null}
ok   the restored volume has marker.txt
```

### 12. Cron: schedule, run-now, history, keeps running while the panel is down: PASS

```
ok   run-now result in the history ([{"result":"succeeded","exitCode":0}])
ok   a scheduled run in the history ([{"result":"succeeded","startedAt":"2026-11-11T19:56:00.002Z"}])
panel paused at 2026-11-11T19:56:01Z
panel back at 2026-11-11T19:58:32Z
runs that started while the panel was down: 2 ([{"startedAt":"2026-11-11T19:58:00.000Z","result":"succeeded"},{"startedAt":"2026-11-11T19:57:00.000Z","result":"succeeded"}])
ok   cron kept running while the panel was down (2 or more runs in 150s)
```

### 13. Logs search/follow across deploys; console stdin; shell PTY; files: PASS

```
logs.search 'listening': 3 lines across generations [1,2,3]
ok   search finds lines from two or more deploys
ok   logs.follow streamed lines (tail, then the restart's 'listening on')
ok   Console echoed stdin (echo:hello-e2e); ready: {"type":"ready","containerId":"3228d910d1bc7fdbfe3864a114250cd317620e8c9c61fef80f4c50d854a1d697","generation":1,"user":"root","workdir":"/"}
ok   Shell PTY ran a command (shell-42; tty: )
ok   files.write created /e2e/hello.txt
ok   files.list shows it (["hello.txt:22"])
ok   upload through the ticket
ok   download returns the uploaded bytes
ok   files.read returns the edit (edited by the e2e)
ok   the container sees the edited file
```

### 14. Metrics: node and service series have samples: PASS

```
node a: {"points":12,"latest":{"cpuPercent":0.8022060666833752,"memoryUsedBytes":990228480}}
ok   node a has samples
node b: {"points":10,"latest":{"cpuPercent":3.2795156407669057,"memoryUsedBytes":645971968}}
ok   node b has samples
node c: {"points":9,"latest":{"cpuPercent":0.1502253380070151,"memoryUsedBytes":453365760}}
ok   node c has samples
service f09mm1pf7t72drrc: {"points":9,"current":[{"cpuPercent":0.010781643973777106,"memoryBytes":3006464}]}
ok   service f09mm1pf7t72drrc has samples
service 95wdmgucqx0z0d03: {"points":8,"current":[{"cpuPercent":0,"memoryBytes":25858048}]}
ok   service 95wdmgucqx0z0d03 has samples
```

### 15. Move a service with a volume B -> C; data intact; domain follows: PASS

```
ok   before the move: mover.e2e.test serves the volume's page through B
move deployment: live {"trigger":"move","shippedTo":["e2e-c"],"error":null}
ok   placements now on C (["e2e-c"])
ok   after the move the domain follows to C and the volume data is intact
B answers  for mover.e2e.test after the move
ok   no container of the service is left on B
```

### 16. Replicas on B and C, entry on B; failover when either container dies (round robin and sticky): PASS

```
30 requests to the entry node B answered from (traefik/replica):  15 21801cca7ed3/172.19.0.4 15 eae185c1ecf6/172.19.0.14 
B's route for lb.e2e.test:  - url: http://172.18.0.1:5756 - url: http://seylo-7rz4otb7hthn8sac-1:80 - url: https://192.168.64.5:5757 
ok   both replicas (B and C) answer through the entry node
killed the replica on C (99f4a0609f04) during the load
200 requests during the failover, 0 not 200 ( 200 200 )
ok   requests keep succeeding when one replica dies
killed the replica on b (bc199671cc36) during the load
167 requests during the failover, 0 not 200 ( 167 200 )
ok   requests keep succeeding when the entry node's own replica dies
cookie jar pinned to b's copy (172.19.0.14): 6 of 6 requests answered by it
ok   the sticky cookie pins a client to one copy
killed the replica on b (bc199671cc36) during the load (sticky)
166 requests during the failover, 0 not 200 ( 166 200 )
ok   a client pinned to the copy on B keeps being answered when it dies
cookie jar pinned to c's copy (172.19.0.4): 6 of 6 requests answered by it
ok   the sticky cookie pins a client to one copy
killed the replica on c (99f4a0609f04) during the load (sticky)
170 requests during the failover, 0 not 200 ( 170 200 )
ok   a client pinned to the copy on C keeps being answered when it dies
```

### 17. Compose stack from pasted YAML (two services, shared volume): PASS

```
stack t1zyv4vni674kvcs with members ["stack-reader","stack-writer"]
member ob9usk6czqd6xwmr container ffc1bb54bdbc: read-1794427340 read-1794427342 
member 6n8maovpuc7ytkcz container d9fe47ab2751: wrote wrote 
ok   the reader sees the writer's file through the shared volume
```

### 18. A template from the catalog creates and runs: PASS

```
catalog: 23 templates (["appsmith","code-server","directus","excalidraw","filebrowser","ghost","gitea","grafana"])
ok   it-tools from the catalog is live
template domain: it-tools.192-168-64-4.sslip.io
ok   it-tools answers through B's Traefik
```

### 19. Global and per-service maintenance pages; timed expose locked to an IP: PASS

```
timed expose: {"host":"192.168.64.4","port":null,"allowedCidrs":["192.168.64.1/32"],"expiresAt":"2026-11-11T20:07:37.735Z"}
ok   the Mac (192.168.64.1) reaches 192.168.64.4:33825
ok   VM A (192.168.64.3) is refused (got 000)
ok   global maintenance page on whoami.192-168-64-4.sslip.io (HTTP )
ok   per-service maintenance page on whoami.192-168-64-4.sslip.io
ok   another service (lb.e2e.test) is not in maintenance
waiting 306s for the expose to expire at 2026-11-11T20:07:37.735Z
ok   the timed expose closed by itself on time (got 000)
```

### 20. Panel down: apps, routes, crash restarts, cron keep working; outbox delivers: PASS

```
panel paused at 2026-11-11T20:08:18Z
ok   the app and its route kept serving while the panel was down (30 ok, 0 failed)
ok   crash restarts kept working while the panel was down (11 crashes, 11 restarts)
panel back at 2026-11-11T20:10:49Z
ok   all 3 nodes resynced and online
crash reports for the downtime in the panel: 11 (node saw 11 crashes)
ok   the outbox delivered every crash report from the downtime
ok   cron runs from the downtime were delivered (2 in 150s)
```

### 21. Agent restart adopts running services without restarting them: PASS

```
B runs 15 seylo containers before the restart (crash-test services left out)
ok   every running container on B kept its id and StartedAt across systemctl restart seylo
ok   whoami still answers
```

### 22. Self-update N -> N+1 (panel first, then nodes); broken N+2 panel rolls back: PASS

```
updates.status after publishing 0.2.1: {"panel":{"currentVersion":"0.2.0","latestVersion":"0.2.1","updateAvailable":true,"offeredVersion":"0.2.1","latestIsPrerelease":false,"changelogUrl":"http://192.168.64.1:18555/changelog-0.2.1"},"checkError":null,"nodes":["colima-seylo-e2e-a=0.2.0","e2e-b=0.2.0","e2e-c=0.2.0"]}
ok   the panel sees 0.2.1 on the local release server (signed with the test key)
auto-update had not started within 20s; started the run with updates.updatePanel
ok   the panel runs 0.2.1 (system.version)
ok   every node runs 0.2.1: ["colima-seylo-e2e-a=0.2.1","e2e-b=0.2.1","e2e-c=0.2.1"]
update run: {"targetVersion":"0.2.1","trigger":"manual","status":"succeeded","error":null,"steps":["0:panel:panel:succeeded","1:agent:colima-seylo-e2e-a:succeeded","2:agent:e2e-b:succeeded","3:agent:e2e-c:succeeded"]}
ok   the panel step comes first, then the nodes one by one
ok   the update run succeeded
panel container image now: 127.0.0.1:15000/seylo:0.2.1@sha256:e4c2d719959b60aba98ae70c33e55903d88944a7eb98e9c65c8176c8c6891090
broken update run: {"targetVersion":"0.2.2","status":"failed","error":"the new panel did not become healthy: the panel is SERVICE_PHASE_FAILED: deploy failed: seylo-panel00000000000-3 exited right after starting","steps":["panel:rolledBack:the new panel did not become healthy: the panel is SERVICE_PHASE_FAILED: deploy "]}
ok   the 0.2.2 run is marked failed or rolled back
ok   the panel still runs 0.2.1 after the rollback (now 0.2.1)
ok   the restored database is intact (the API key works, projects are there)
ok   the old image runs again (127.0.0.1:15000/seylo:0.2.1@sha256:e4c2d719959b60aba98ae70c33e55903d88944a7eb98e9c65c8176c8c6891090)
```

### 23. Cleanup preview + run removes only seylo-labeled garbage: PASS

```
made an unlabeled stopped container, volume and image, plus a labelled image, volume and data folder of a removed service
preview: {"bytes":6201070,"count":4,"items":["image e2e-seylo-garbage-img:1 (ac4868bcebe2) (3.0 KiB): service removed from this node","volume e2e-seylo-garbage-vol: service removed from this node","data deadbeefdeadbeef (8 B): service removed from this node","build cache of seylo-builder-6u2sk94xig5nksow-2c-2g: 6.2MB reclaimable"]}
ok   the preview never lists the unlabeled resources
ok   the preview lists the removed service's image, volume and data
ok   the unlabeled container survives
ok   the unlabeled volume survives
ok   the unlabeled image survives
ok   the infrastructure containers on A survive (not cleaned there either)
ok   the labelled garbage image is gone
ok   the labelled garbage volume is gone
ok   the removed service's data folder is gone
ok   running services are untouched (whoami answers)
```

### 24. Laptop CLI: login, deploy, env set/list, logs -f: PASS

```
ok   seylo login (API key): Signed in to http://192.168.64.3:3000 as owner@e2e.test (profile "default").
seylo login (browser): Your sign-in code: <code> Approve it at http://192.168.64.3:3000/cli/approve?code=<code> 
ok   the approval page's request shows the computer: {"clientName":"<this computer> (darwin/arm64)","status":"pending"}
ok   seylo login (browser approval) signed in: Signed in to http://192.168.64.3:3000 as owner@e2e.test (profile "web").
ok   the approved read-only key reads (env list)
ok   the approved read-only key cannot write (seylo: This key is read-only.)
ok   seylo env set: Saved. The new values apply on the next deploy.
ok   seylo env list shows E2E_CLI (GREETING=${{whoami.SECRET_TOKEN}} PEER=${{whoami.WHOAMI_NAME}} E2E_CLI=from-cli)
ok   seylo deploy e2e/whoami: [switch] The new version is live. Live.
ok   seylo logs -f streamed lines (2 'listening' lines)
```

### 25. MCP: read-only token lists tools and runs a query; destructive call -> approval: PASS

```
initialize: {"protocolVersion":"2025-06-18","serverInfo":{"name":"seylo","title":"Seylo","version":"0.2.1"}}
read-only token sees 100 tools, destructive ones: []
ok   the read-only token lists tools
ok   the read-only token sees no destructive tool
ok   a query tool (nodes_list) runs and returns the nodes
destructive call (services_delete) answered: This action needs a person's approval before it runs. Approval oo3lqjynv4e07dbe is waiting in the panel's Approvals page (it expires at 2026-11-12T20:14:38.185Z). Call approvals_get with {"approvalId":"oo3lqjynv4e07dbe"}
ok   the destructive call created a pending approval ([{"id":"oo3lqjynv4e07dbe","status":"pending"}])
ok   the service still exists while the approval waits
```

### 26. seylo troubleshoot --dry-run redacts; seylo status shows the connection: PASS

```
troubleshoot --dry-run on B: 295 lines, 1 redaction markers
ok   the report is redacted (markers present)
ok   no join token, API key or private key in the report
seylo status on B: Node: e2e-b (e6nzwjikjvlxzc3o) Agent: 0.2.1 (commit e2e, built unknown) Panel: https://192.168.64.3:3443 (connected, version 0.2.1) PROJECT SERVICE PHASE 6u2sk94xig5nksow pg running 
ok   seylo status shows the connection
```

### 27. Uninstall on C leaves nothing behind: PASS

```
after uninstall on C: containers: 0 networks: 0 volumes: 0 seylo-named: 0 0 datadir-gone binary-gone
ok   no seylo containers, networks or volumes left
systemd units named seylo.* still loaded: 
ok   no seylo unit files or drop-ins left
ok   systemd no longer knows seylo.service
ok   /var/lib/seylo and the binary are gone
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.1' --pin 'sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf'
ok   installer join on seylo-e2e-c finished: ==> Docker;Docker 29.9.3 is running;==> Joining https://192.168.64.3:3443;Connected: the node shows up in the panel now.;
C joined again as 4btuy2d641nbhw2q
```

### 28. C (systemd cgroup driver) runs containers under seylo.slice: PASS

```
C Docker cgroup driver: systemd
ok   C uses the systemd cgroup driver
container 1e183be73e48: CgroupParent=seylo.slice, /proc cgroup=0::/seylo.slice/docker-1e183be73e48bc81fb0a63ea1f608f5493e6075d7bf7ee242be01110acb3fb59.scope
ok   the container's cgroup parent is seylo.slice
ok   the process runs under seylo.slice
ok   systemd shows it in seylo.slice
```

### 29. (stretch) ACME certificate from a local Pebble CA: PASS

```
ok   acme.192-168-64-4.sslip.io serves a certificate issued by Pebble
domains.checkDns acme.192-168-64-4.sslip.io: {"status":"ok","origin":"node"}
ok   the origin check of acme.192-168-64-4.sslip.io reached B (origin node)
```

### 30. Web smoke with Playwright against the e2e panel: PASS

```
service tabs visited: deployments, source, environment, domains, logs, console, metrics, storage, settings
 1 passed (2.6s)
ok   Playwright: dashboard shows the nodes, services and every tab load, console echoes, no page errors
```

### 31. Panel domain: Pebble HTTPS, Secure cookie, HSTS, IP:port -> domain, nodes move to it, CLI: PASS

```
ok   A, B and C trust Pebble's root (/CN=Pebble Root CA 302985); on the Mac only this check's curl and CLI calls do
B's and C's agents restarted to read the new trust store
A's agent restarted with Pebble (https://192.168.64.3:14000/dir) as its ACME CA
ok   panel domain panel223441.192-168-64-3.sslip.io set (sslip.io answers 192.168.64.3, A's address)
ok   https://panel223441.192-168-64-3.sslip.io answers with a certificate Pebble's root verifies: issuer= /CN=Pebble Intermediate CA 0a75e5 notAfter=Feb  9 20:34:41 2027 GMT 
the panel's domain check after 1s: {"state":"active","message":"","checkedAt":"2026-11-11T20:34:43.847Z","proxied":false}
ok   the panel's own probe found panel223441.192-168-64-3.sslip.io active (it trusts the test CA in a test build)
ok   settings.general reports the domain active
ok   http://panel223441.192-168-64-3.sslip.io goes to HTTPS (301 https://panel223441.192-168-64-3.sslip.io/)
ok   HTTPS answers carry HSTS (strict-transport-security: max-age=31536000)
ok   plain HTTP on IP:port carries no HSTS
auth.login over https://panel223441.192-168-64-3.sslip.io: HTTP/2 200 ; set-cookie: __Host-seylo_session=<redacted>; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax
ok   the session cookie set over HTTPS is Secure
ok   the session cookie is HttpOnly
ok   the session cookie over HTTPS is __Host- prefixed
ok   the session cookie names no Domain
ok   the HTTPS cookie alone is no session
ok   the HTTPS session works (auth.whoami with the session key)
ok   a page load on IP:port answers 302 to the domain (302 https://panel223441.192-168-64-3.sslip.io/settings/general?e2e=31)
ok   the panel's pages answer on the domain
ok   the API on IP:port is not redirected (scripts, CLI and agents keep working)
ok   pages on A's loopback are not redirected (the way back in over SSH)
ok   seylo login https://panel223441.192-168-64-3.sslip.io (macOS CLI, API key): Signed in to https://panel223441.192-168-64-3.sslip.io as owner@e2e.test (profile "default").
ok   seylo env set e2e/whoami over the domain: Saved. The new values apply on the next deploy.
ok   seylo env list over the domain shows E2E_DOMAIN_CLI
ok   the panel asked B and C to reconnect and both moved without a restart
ok   b moved to the domain: panel_url: https://panel223441.192-168-64-3.sslip.io 
ok   c moved to the domain: panel_url: https://panel223441.192-168-64-3.sslip.io 
ok   A (the panel's node) keeps dialing loopback
ok   b has no panel_pin (the domain's certificate is checked with system roots)
ok   b dropped insecure_transport
ok   b keeps the old address as a fallback for one cycle (fallback: panel_url: https://192.168.64.3:3443 panel_pin: sha256:...955bd0bf )
b agent log: time=2026-11-11T22:34:44.782+02:00 level=INFO msg="moved to the panel's new address; the old one stays as a fallback until a reconnect there works" panel_url=https://panel223441.192-168-64-3.sslip.io fallback=https://192.168.64.3:3443
ok   b is connected through the domain: Panel: https://panel223441.192-168-64-3.sslip.io (connected, version 0.2.1)
ok   b's agent talks to A:443, not to the agents' TLS port 3443 (ports on A it holds: 443 )
ok   c has no panel_pin (the domain's certificate is checked with system roots)
ok   c dropped insecure_transport
ok   c keeps the old address as a fallback for one cycle (fallback: panel_url: https://192.168.64.3:3443 panel_pin: sha256:...955bd0bf )
c agent log: time=2026-11-11T20:34:44.730Z level=INFO msg="moved to the panel's new address; the old one stays as a fallback until a reconnect there works" panel_url=https://panel223441.192-168-64-3.sslip.io fallback=https://192.168.64.3:3443
ok   c is connected through the domain: Panel: https://panel223441.192-168-64-3.sslip.io (connected, version 0.2.1)
ok   c's agent talks to A:443, not to the agents' TLS port 3443 (ports on A it holds: 443 )
ok   3 nodes online after the move
ok   b reconnects through the domain after an agent restart: Panel: https://panel223441.192-168-64-3.sslip.io (connected, version 0.2.1)
ok   b still dials the domain
ok   b keeps its pinned old address as a standing fallback ("the panel's new address works after a reconnect; keeping the previous pinned one for when it stops answering" panel_url=https://panel223441.192-168-64-3.sslip.)
ok   b holds no connection to the agents' TLS port (ports on A: 443 )
ok   c reconnects through the domain after an agent restart: Panel: https://panel223441.192-168-64-3.sslip.io (connected, version 0.2.1)
ok   c still dials the domain
ok   c keeps its pinned old address as a standing fallback ("the panel's new address works after a reconnect; keeping the previous pinned one for when it stops answering" panel_url=https://panel223441.192-168-64-3.sslip.)
ok   c holds no connection to the agents' TLS port (ports on A: 443 )
ok   3 nodes online after restarting B's and C's agents
ok   removing the domain without acknowledgeNodesOffline is refused ("message":"e2e-b and e2e-c connect over https://panel223441.192-168-64-3.sslip.io and go offline without it. A node that joined over the domain stays offline un)
ok   panel domain removed (settings.updateGeneral {domain: null, acknowledgeNodesOffline: true})
ok   IP:port pages are served again
ok   B and C came back to https://192.168.64.3:3443 by themselves 356s after the restart: b panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://192.168.64.3:3443 , c panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://192.168.64.3:3443 
cleanup: A's agent restarted without the Pebble ACME settings
ok   cleanup: b is back on the agents' TLS port with the pin, no fallback, connected (Panel: https://192.168.64.3:3443 (connected, version 0.2.1))
ok   cleanup: c is back on the agents' TLS port with the pin, no fallback, connected (Panel: https://192.168.64.3:3443 (connected, version 0.2.1))
ok   cleanup: 3 nodes online
```

### 32. Docker Hub: search, tags, inspect traefik/whoami on the real Docker Hub; dockerHub.create on B live on its auto domain: PASS

```
search traefik/whoami: [{"repository":"traefik/whoami","publisher":"traefik","badge":"none","pullCount":46647336},{"repository":"traefik","publisher":"Docker","badge":"official","pullCount":3600283059},{"repository":"rancher/library-traefik","publisher":"Rancher by SUSE","badge":"verified","pullCount":22521617}]
ok   search finds traefik/whoami first
tags: suggested v1.12.0, newest [{"name":"v1.12.0","platforms":["linux/amd64","linux/arm64","linux/arm/v7"]},{"name":"v1.12","platforms":["linux/amd64","linux/arm64","linux/arm/v7"]},{"name":"latest","platforms":["linux/amd64","linux/arm64","linux/arm/v7"]},{"name":"v1.11","platforms":["linux/amd64","linux/arm64","linux/arm/v7"]}]
ok   tags lists versions with their platforms and suggests one (v1.12.0)
inspect v1.10.3: {"digest":"sha256:43a68d10b9dfcfc3ffbfe4dd42100dc9aeaf29b3a5636c856337a5940f1b4f1c","platform":"linux/arm64","ports":[{"port":80,"protocol":"tcp"}],"entrypoint":["/whoami"],"user":"","private":false}
ok   inspect reads port 80/tcp, the entrypoint and a digest for linux/arm64
service: {"name":"hub-whoami","sourceConfig":{"type":"image","image":"traefik/whoami:v1.10.3","registryId":null},"ports":[80]}
ok   dockerHub.create deployed traefik/whoami:v1.10.3 on B
ok   it got B's automatic domain hub-whoami.192-168-64-4.sslip.io
ok   http://hub-whoami.192-168-64-4.sslip.io answers through B's Traefik: Hostname: hub-whoami
ok   the .env from the create form reached the container (WHOAMI_NAME)
```

### 33. Gitea provider on A: a push outside the watch path skips (reason logged), inside deploys, [skip ci] skips: PASS

```
ok   Gitea gitea/gitea:1.24.6 on A at https://192.168.64.3:13000 (certificate from the e2e test CA)
ok   e2e/watch-app (private) pushed to Gitea: Dockerfile, app/index.html, docs/notes.md
connection: {"kind":"gitea","host":"192.168.64.3:13000","account":"e2e"}
ok   the connection lists e2e/watch-app (["e2e/watch-app"])
webhook: {"created":true,"url":"http://192.168.64.3:3000/api/hooks/gitea/sf2l12mappd0sa8h","error":null,"insecure":true}
ok   the panel created the webhook on the Gitea repository
ok   the first deploy (Dockerfile from the private Gitea repository, built on A) is live
ok   watch-app answers v1 on 192.168.64.4:44651
push 1 (docs/notes.md): {"event":"push","outcome":"ignored","detail":"Skipped by watch paths: the one changed file matches no pattern."}
ok   push 1 is skipped by the watch path, with the reason
ok   push 1 started no deploy (1 deployments)
push 2 (app/index.html): {"event":"push","outcome":"deployed","detail":"Deploying 865a2f1 from main."}
push 2 deploy: live; log: Watch paths: app/index.html matches app/**.
ok   push 2 deployed (live)
ok   the deploy log names the file and the pattern
ok   watch-app now answers v2
push 3 ([skip ci]): {"event":"push","outcome":"ignored","detail":"Skipped: the head commit message says [skip ci]."}
ok   push 3 is skipped for [skip ci]
ok   push 3 started no deploy
ok   watch-app still answers v2
```

### 34. Scheduled cleanup on B: a disk line triggers a run that removes only labelled resources and reports them: PASS

```
made a labelled image and volume of a removed service, and an unlabeled stopped container, volume and image
schedule: {"schedule":{"enabled":true,"cron":null,"diskPercent":50,"kinds":{"images":true,"buildCache":false,"stoppedContainers":true,"unusedVolumes":true}},"supported":true}
ok   the schedule is saved and the node can run it
B's disk: 7% before, 6% after filling; the line is 50%
run: {"trigger":"disk","status":"succeeded","diskPercent":53,"removedCount":2,"bytesFreed":3059,"error":null}
it reported: ["image e2e34-labelled-img:1 (abc91fdea989) (3.0 KiB): service removed from this node","volume e2e34-labelled-vol: service removed from this node"]
ok   the disk line started a cleanup run on B by itself
ok   the run succeeded at 50% or more
ok   it reports the labelled image and volume
ok   it reports nothing unlabeled
ok   the labelled image is gone
ok   the labelled volume is gone
ok   the unlabeled container, volume and image survive
ok   running services are untouched (whoami answers)
```

### 35. Host shell on B: owner turns it on with re-auth, hostname through the panel's socket, audited, agent refuses when off: PASS

```
ok   an API key cannot turn host shells on
hostShell.setEnabled (owner session after auth.reauth): {"nodeId":"e6nzwjikjvlxzc3o","enabled":true}
ok   the owner turned host shells on for B
status: {"enabled":true,"available":true,"maxSessions":2,"idleTimeoutSeconds":900}
ok   a root shell on B through the panel's host-shell socket ran hostname: colima-seylo-e2e-b ("user":"root")
ok   hostShell.setEnabled is in the audit log
ok   hostShell.open is in the audit log
ok   the shell's close is in the audit log (hostShell.close)
ok   a security_change alert names the root shell
ok   host shells are off again
hostShell.open while off: {"code":"CONFLICT","message":"Host shells are off for this node. The owner can turn them on in the node's Shell tab."}
ok   the panel refuses to open one while off
with only the node saying no: T {"type":"ready","containerId":"","generation":0,"user":"","workdir":""} T {"type":"closed","reason":"host shells are turned off on this node: the owner has not allowed host shells for this node"} CLOSE 1011 closed 
ok   the agent refused the shell: nothing ran
ok   the refused shell is audited as refused by the node (hostShell.close)
```

### 36. Clone whoami with its data into another project on C; move a service between projects (impact list, keeps serving): PASS

```
ok   whoami on B has a data volume with /marker.txt (clone-marker-a12f806c)
clone preview: {"name":"whoami-copy","env":"copied","volumes":[{"name":"data","mountPath":"/data"}],"data":{"available":true,"blockedBy":null,"alwaysStops":false},"autoDomain":null}
ok   the preview offers a copy of the data volume
clone: {"copied":{"env":true,"fileMounts":false,"databaseLogins":false,"middlewares":false,"autoDomain":null},"dataCopy":{"status":"queued","volumes":["data"]}}
data copy: {"status":"done","bytesCopied":21,"error":null}
ok   the data copy finished
ok   whoami kept serving while it was cloned (483 requests, 0 failed)
ok   the clone runs on C in project e2e-clones
ok   the clone answers on C's IP:port (192.168.64.5:44431)
ok   the clone's volume has the copied marker (clone-marker-a12f806c)
move impact: {"blockers":[],"referencedBy":[{"serviceId":"d4ygbm6uyf0w4sua","name":"ref-app","keys":["WHO"]}],"switches":true,"grants":{"count":0,"names":[]},"sharedLost":{"count":0,"names":[]}}
ok   the impact lists ref-app (WHO) losing the reference and a running switch
ok   moving without confirm is refused when the impact lists something
moveProject: switch deployment 61o52x0qkizn6zoc
ok   the switch to the new project's network went live
ok   the clone kept serving through the move (705 requests, 0 failed)
ok   the clone now belongs to e2e-moved
ok   its container is on e2e-moved's network only
ok   whoami (the source) still answers on B
```

### 37. Valkey, ClickHouse, Postgres 18 + pgvector on B: app connects, TLS exposure, shell query, backup to MinIO, restore: PASS

```
engines: [{"engine":"postgres","versions":["18","17","16","15"],"variants":["pgvector"]},{"engine":"valkey","versions":["9.1","9.0","8.1"],"variants":[]},{"engine":"clickhouse","versions":["26.8","26.3"],"variants":[]}]
databases: {"name":"vk","engine":"valkey","version":"9.1","variant":null,"internal":{"host":"vk","port":6379,"database":"","user":"default","httpPort":null},"shellClient":"valkey-cli"} {"name":"ch","engine":"clickhouse","version":"26.8","variant":null,"internal":{"host":"ch","port":9000,"database":"e2e","user":"ch_06298dnjq7","httpPort":8123},"shellClient":"clickhouse-client"} {"name":"pg18","engine":"postgres","version":"18","variant":"pgvector","internal":{"host":"pg18","port":5432,"database":"app","user":"app","httpPort":null},"shellClient":"psql"} 
ok   Valkey 9.1, ClickHouse 26.8 and Postgres 18 (pgvector image) run on B
ok   psql shell: CREATE EXTENSION vector, and [1,2,3] <-> [1,2,5] = 2
ok   valkey-cli shell: SET and GET without a password
ok   clickhouse-client shell: SELECT concat('e2e-', toString(40 + 2)) -> e2e-42
probe: PROBE vk=[+OK +PONG ] ch=[42] pg=[0.8.7] DATA-PROBE-OK 
ok   an app of the project reaches Valkey (PONG), ClickHouse over HTTP (42) and pgvector by references
valkey exposed: {"host":"192.168.64.4","port":26380,"user":"default","tlsParams":""}
ok   valkey-cli --tls from A reaches Valkey through B's TLS port 26380 (PONG)
ok   Valkey's exposed port refuses plain TCP clients
clickhouse exposed: {"host":"192.168.64.4","port":29440,"user":"ch_06298dnjq7","tlsParams":"secure=true&skip_verify=true"}
ok   clickhouse-client --secure from A reaches ClickHouse's native port through B's TLS port 29440 (42)
ok   psql from the Mac reaches Postgres 18 over TLS (18.6)
ok   Postgres' exposed port uses the database's own user (app)
ok   Postgres' exposed port refuses a login without TLS, with the gate's message
ok   Valkey: backup to MinIO, then the restore brings back the value from before
ok   ClickHouse: backup to MinIO, the dropped table is back after the restore (before-backup)
ok   Postgres 18: backup to MinIO, the dropped vector table is back after the restore ([1,2,3])
ok   the backups are in MinIO
```

### 38. Upgrade: a 0.1.1 panel and node with real rows move to this build by the normal update; 0001 applies, data survives: PASS

```
ok   C left A's panel and was uninstalled
ok   C runs panel 0.1.1 ({"status":"ok","version":"0.1.1"})
ok   the 0.1.1 panel runs its release image by digest (127.0.0.1:15000/seylo:0.1.1@sha256:169a846f17f86ac4dbbf326985b208e0a7e8c1e8b7434253250643980c983a6e)
ok   owner, API key and C's own node on the 0.1.1 panel
on 0.1.1: cron job saved as {"schedule":"0 4 * * 7","nextRunAt":"2026-11-15T04:00:00.000Z"}; run now:   api cron.runNow {"serviceId":"pdt4nh45l7rlsup4","cronJobId":"v2c1xa670qrlqd1a"} -> 404 {"error":{"code":"NOT_FOUND","message":"no such cron job on this node: service pdt4nh45l7rlsup4 job \"v2c1xa670qrlqd1a\"","details":{"reason":"agent","nodeId":"52i1vlywlna7c28w","agentStatus":"NOT_FOUND"}}}
before: projects ["Panel","upgrade"]; services ["pg=running","web=running","worker=running"]; web deployments 1; migrations applied 1
ok   rows on 0.1.1: project upgrade, web (whoami with env) on 192.168.64.5:32963, Postgres 17 with a row, worker with a cron job saved as 0 4 * * 7
updates.status on 0.1.1: {"panel":{"currentVersion":"0.1.1","latestVersion":"0.2.0","updateAvailable":true,"changelogUrl":"http://192.168.64.1:18555/changelog-0.2.0"},"checkError":null}
ok   the 0.1.1 panel sees 0.2.0 as its update
ok   the panel on C runs 0.2.0
ok   C's agent runs 0.2.0
update run: {"targetVersion":"0.2.0","status":"succeeded","error":null,"steps":["panel:succeeded","agent:succeeded"]}
ok   the update run succeeded
ok   every migration of this build applied: 18 recorded (now 18)
ok   0001's tables exist (["cleanup_runs","git_providers","host_shell_sessions"])
ok   0002's update step columns exist (["retry","retry_at","retry_run_id"])
ok   0004's join_tokens.can_build column exists (["can_build"])
ok   C's node keeps its Can build through the update (true before, true after)
ok   the projects are the same (["Panel","upgrade"])
ok   the API key made on 0.1.1 still works
ok   the upgraded panel runs as the panel user, its folder and master.key moved to it (61000:61000 61000:61000:700 61000:61000:600)
ok   web still answers on 192.168.64.5:32963 with its env
ok   the Postgres row from 0.1.1 is there
cron job after the upgrade: {"schedule":"0 4 * * 0","nextRunAt":"2026-11-15T04:00:00.000Z"}
ok   the cron job saved with 7 now reads 0 4 * * 0 and has a next run
ok   the node schedules the job now and runs it ({"result":"succeeded","output":"cron-ran-42"})
ok   a redeploy of web after the upgrade goes live
ok   web answers after the redeploy
ok   the upgraded node runs scheduled cleanup (cleanup.getSchedule supported)
ok   the upgraded node runs host shells (hostShell.status available)
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.1' --pin 'sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf'
ok   installer join on seylo-e2e-c finished: ==> Docker;Docker 29.9.3 is running;==> Joining https://192.168.64.3:3443;Connected: the node shows up in the panel now.;
C joined A's panel again as 8f3cef8obxm0hzy9
```

### 39. Build default: Add node's box decides Can build, a refused join exits 3; Serve on IP address off over the domain, CLI and domain-death reopen: PASS

```
Can build now: [{"name":"colima-seylo-e2e-a","canBuild":true,"canBuildWarning":null,"buildx":null},{"name":"e2e-b","canBuild":true,"canBuildWarning":null,"buildx":null},{"name":"e2e-c","canBuild":true,"canBuildWarning":null,"buildx":null}]
ok   the buildx health check passes on B (pass: github.com/docker/buildx v0.34.1 e0b0e77d18d3379bc1e0d55f3b37de288d36fe47)
ok   C left the panel and was uninstalled (its services went first)
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.1' --pin 'sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf'
ok   installer join on seylo-e2e-c finished: ==> Docker;Docker 29.9.3 is running;==> Joining https://192.168.64.3:3443;Connected: the node shows up in the panel now.;
ok   nodes.createJoinToken {canBuild: false} made a token that says so ({"tokenId":"eahfzc5fdkot33ed","canBuild":false})
ok   the installer on C waited for the agent's first connection and says it is connected
ok   C, joined with the box unticked, does not build whatever its --can-build says (canBuild false)
C's config.yml says can_build: true, which the panel only reports
the used join command again: exit 3, warning: the panel refused this node: panel rejected the agent: HELLO_REJECT_REASON_INVALID_TOKEN: The join token is not valid. Create a new one with Add node. (retrying at 20:27:18) | Installed, but the panel refused this node. 
ok   a join the panel refuses exits 3 (exit 3)
ok   and its closing block says the panel refused this node
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.1' --pin 'sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf'
ok   installer join on seylo-e2e-c finished: ==> Docker;Docker 29.9.3 is running;==> Joining https://192.168.64.3:3443;Connected: the node shows up in the panel now.;
ok   a default join command made a token with canBuild true ({"tokenId":"96en7c2ayi6avmjq","canBuild":true})
ok   the installer on C waited for the agent's first connection and says it is connected
ok   C, joined with a default command, builds images (canBuild true)
ok   3 nodes online
ok   A, B and C trust Pebble's root (/CN=Pebble Root CA 302985); on the Mac only this check's curl and CLI calls do
B's and C's agents restarted to read the new trust store
A's agent restarted with Pebble (https://192.168.64.3:14000/dir) as its ACME CA
ok   panel domain panel222228.192-168-64-3.sslip.io set (sslip.io answers 192.168.64.3, A's address)
ok   https://panel222228.192-168-64-3.sslip.io answers with a certificate Pebble's root verifies: issuer= /CN=Pebble Intermediate CA 0a75e5 notAfter=Nov 17 20:22:28 2026 GMT 
the panel's domain check after 0s: {"state":"active","message":"","checkedAt":"2026-11-11T20:22:30.574Z","proxied":false}
ok   the panel's own probe found panel222228.192-168-64-3.sslip.io active (it trusts the test CA in a test build)
ok   settings.general reports the domain active
ok   the owner signed in over https://panel222228.192-168-64-3.sslip.io and over http://192.168.64.3:3000 (two browser sessions)
settings.panelAccess on the domain: {"serveOnIp":true,"agentPortOpen":true,"onFailure":"reopen","panelPort":3000,"agentPort":3443,"actual":{"ip":"open","agentPort":"open"},"privatePaths":[{"kind":"domain","url":"https://panel222228.192-168-64-3.sslip.io","working":true,"since":"2026-11-11T20:22:30.574Z","usingNow":true}],"blocked":[],"agentPortBlocked":[],"recovery":{"sshTunnel":"ssh -L 3000:127.0.0.1:3000 root@192.168.64.3","cli":"sudo seylo panel ip-access on"}}
ok   the domain is a working private path and this session is on it
what refuses closing IP access: []
addresses the panel sees the nodes dial: {"name":"colima-seylo-e2e-a","panelAddress":"http://127.0.0.1:3000"} {"name":"e2e-b","panelAddress":"https://panel222228.192-168-64-3.sslip.io"} {"name":"e2e-c","panelAddress":"https://panel222228.192-168-64-3.sslip.io"} 
ok   nothing refuses closing IP access for the owner on the domain
ok   the recovery SSH tunnel goes to 127.0.0.1:3000 (ssh -L 3000:127.0.0.1:3000 root@192.168.64.3)
ok   push: turning the app on from the IP:port session is refused (notOnDomain)
ok   push: an API key cannot turn the app on
ok   push: no manifest while the app is off
push.updateSettings over https://panel222228.192-168-64-3.sslip.io: {"enabled":true,"active":true,"domainUrl":"https://panel222228.192-168-64-3.sslip.io","onDomainNow":true,"blocks":[]}
ok   push: the app and push notifications turned on over https://panel222228.192-168-64-3.sslip.io
the manifest on https://panel222228.192-168-64-3.sslip.io: {"name":"Seylo","short_name":"Seylo","display":"standalone","start_url":"/","icons":["/pwa/icon-192.png","/pwa/icon-512.png","/pwa/maskable-512.png"]}
ok   push: https://panel222228.192-168-64-3.sslip.io serves the app manifest
ok   push: the service worker is served as JavaScript, not cached
ok   push: turned off again
ok   an API key cannot turn Serve on IP address off (notBrowserSession)
the IP:port session with Host: panel222228.192-168-64-3.sslip.io and X-Forwarded-Proto: https -> 401 {"error":{"code":"UNAUTHENTICATED","message":"Sign in or use a valid API key."}}
ok   an IP:port session with a forged Host and X-Forwarded-Proto is refused (401)
ok   Serve on IP address is still on and IP:port answers
ok   settings.panelAccess still says serveOnIp
ok   Serve on IP address turned off over https://panel222228.192-168-64-3.sslip.io: {"serveOnIp":false,"actual":{"ip":"unknown","agentPort":"unknown"},"lastChange":"Serve on IP address turned off in Settings"}
ok   the panel restarted with its port on 127.0.0.1 only after 3s
ok   http://192.168.64.3:3000 no longer answers from the Mac
ok   http://192.168.64.3:3000 no longer answers from B
ok   http://192.168.64.3:3000 no longer answers from C
ok   A's loopback still answers (the SSH tunnel's way in)
ok   Docker publishes the panel port on 127.0.0.1 only ({"3000/tcp":[{"HostIp":"127.0.0.1","HostPort":"3000"}],"3443/tcp":[{"HostIp":"","HostPort":"3443"}]})
ok   https://panel222228.192-168-64-3.sslip.io still answers
ok   the owner's session on the domain still works
ok   the panel node's own agent stays connected (Panel: http://127.0.0.1:3000 (connected, version 0.2.1))
ok   B and C stay online
seylo panel status on A: Panel running (running), version 0.2.1, http://127.0.0.1:3000 IP access: closed (127.0.0.1:3000); agents' port: open (0.0.0.0:3443)
ok   seylo panel status says IP access is closed on 127.0.0.1:3000
ok   a security_change alert says IP access closed
agents' port from the domain session: []
ok   the agents' port turned off over the domain (every node connects over the domain)
ok   C can no longer connect to A:3443
ok   B and C stay online over the domain
seylo panel ip-access on: The panel restarted and turns "Serve on IP address" and the agents' port back on. In a few seconds it restarts once more, with its port open on every address. Check with: seylo panel status
ok   seylo panel ip-access on opened http://192.168.64.3:3000 again: the Mac reaches it after 9s
ok   both switches are on and set to reopen again ({"serveOnIp":true,"agentPortOpen":true,"onFailure":"reopen"})
ok   C reaches A's agents' port again
ok   C reaches http://192.168.64.3:3000 again
ok   the audit log has the reopen from the server's command line
ok   IP access closed again from the domain session
the panel's domain status after a failing check: 
ok   with the domain down (2 failed checks in a row), IP access reopened by itself after 21s
settings.panelAccess: {"serveOnIp":false,"agentPortOpen":true,"onFailure":"reopen","actual":{"ip":"open","agentPort":"open"},"openReason":"the panel domain panel222228.192-168-64-3.sslip.io stopped working","reclosesAt":null,"paths":["domain working=false"],"blocked":["notBrowserSession","noPrivatePath"],"lastChange":{"at":"2026-11-11T20:23:10.720Z","reason":"the panel domain panel222228.192-168-64-3.sslip.io stopped working","by":"system"}}
ok   the domain counts as not working
ok   Serve on IP address stays off as the owner set it, and the card says why IP access is open (the panel domain panel222228.192-168-64-3.sslip.io stopped working)
ok   a security_change alert says IP access reopened
ok   with the domain working again, IP access stays open for an hour first (reclosesAt 2026-11-11T21:23:43.764Z)
ok   an hour (backdated) after the domain worked again, IP access closed again by itself after 47s
cleanup: IP access is open again (http://192.168.64.3:3000 answers)
cleanup: panel domain removed
cleanup: b dials https://192.168.64.3:3443 again
cleanup: c dials https://192.168.64.3:3443 again
cleanup: A's agent restarted without the Pebble ACME settings
ok   cleanup: b is back on the agents' TLS port with the pin, no fallback, connected (Panel: https://192.168.64.3:3443 (connected, version 0.2.1))
ok   cleanup: c is back on the agents' TLS port with the pin, no fallback, connected (Panel: https://192.168.64.3:3443 (connected, version 0.2.1))
ok   cleanup: 3 nodes online
```

### 40. Panel on Tailscale (Headscale): Serve over HTTP to the panel's socket, reached from C, Lock to Tailscale, automatic and CLI recovery: PASS

```
tailscale.get before Tailscale: {"detected":false,"agentSupported":true,"version":null,"backendState":null,"tailnet":null,"dnsName":null,"magicDns":false,"https":false,"acceptDns":false,"disabledOnServer":false,"serve":{"wanted":false,"state":"off","url":null,"panelAnswers":false,"message":""},"owned":null}
ok   tailscale.get: not detected
ok   turning Serve on is refused: notInstalled
ok   tailscaled 1.104.5 on A (kernel mode) and on C (userspace, SOCKS5 on 127.0.0.1:1055), sha256 checked
tailscale.get, not signed in: {"detected":true,"agentSupported":true,"version":"1.104.5","backendState":"NeedsLogin","tailnet":null,"dnsName":null,"magicDns":false,"https":false,"acceptDns":true,"disabledOnServer":false,"serve":{"wanted":false,"state":"off","url":null,"panelAnswers":false,"message":""},"owned":null}
ok   tailscale.get: detected, waiting for a sign-in
ok   turning Serve on is refused: notSignedIn
tailscale.get, signed in: {"detected":true,"agentSupported":true,"version":"1.104.5","backendState":"Running","tailnet":"192.168.64.3","dnsName":"e2e-a.ts.e2e.test","magicDns":true,"https":false,"acceptDns":false,"disabledOnServer":false,"serve":{"wanted":false,"state":"off","url":null,"panelAnswers":true,"message":""},"owned":null}
ok   A and C signed in to Headscale; A is e2e-a.ts.e2e.test (100.64.0.1) on tailnet 192.168.64.3
ok   tailscale.get: Running, MagicDNS on, no HTTPS certificates, Tailscale DNS off, version OK
the owner's own Serve entry: http://e2e-a.ts.e2e.test:8080 -> text:owner
ok   an API key cannot turn Serve on
ok   tailscale.setServe {serve: true} from the owner's session: {"wanted":true,"state":"off"}
ok   the panel's Serve entry is active after 0s: {"url":"http://e2e-a.ts.e2e.test","owned":{"hostPort":"e2e-a.ts.e2e.test:80","path":"/","proxy":"unix:/var/lib/seylo/panel/tailnet.sock"}}
ok   it serves http://e2e-a.ts.e2e.test (HTTP mode, the tailnet has no certificates)
ok   the entry is e2e-a.ts.e2e.test:80 / -> the panel's socket ({"hostPort":"e2e-a.ts.e2e.test:80","path":"/","proxy":"unix:/var/lib/seylo/panel/tailnet.sock"})
ok   tailscaled's Serve config has the same entry
ok   the owner's own 8080 entry is untouched
ok   the panel did not restart for it (StartedAt 2026-11-11T20:24:33.5556551Z)
ok   the panel's socket is the panel user's, mode 0600 (61000:600)
ok   another user on A cannot use the socket
ok   http://e2e-a.ts.e2e.test/api/health answers 200 from C over the tailnet
ok   http://e2e-a.ts.e2e.test/ serves the web app
ok   the short name e2e-a goes to the full name (308 http://e2e-a.ts.e2e.test/settings/general)
ok   the owner signed in from C over the tailnet, with a forged X-Forwarded-For and X-Forwarded-Host
ok   the sign-in's audit row has C's tailnet address, not the forged one (["100.64.0.2"])
ok   tailscale.get on the tailnet says this request came over it
ok   tailscale.get with the API key over IP:port does not
ok   closing IP access from the IP:port session is refused (notOnPrivatePath)
settings.panelAccess on the tailnet: {"privatePaths":[{"kind":"tailnet","url":"http://e2e-a.ts.e2e.test","working":true,"since":"2026-11-11T20:26:32.191Z","usingNow":true}],"blocked":[],"agentPortBlocked":["nodesOnAgentPort"]}
ok   the tailnet is a working private path and this session is on it
ok   nothing refuses closing IP access for the owner on the tailnet
ok   the agents' port has to stay open while B and C connect over it (nodesOnAgentPort)
ok   Lock to Tailscale: Serve on IP address turned off from the tailnet session
ok   IP access closed after 3s
ok   http://192.168.64.3:3000 no longer answers from the Mac
ok   http://192.168.64.3:3000 no longer answers from B
ok   http://192.168.64.3:3000 no longer answers from C (outside the tailnet)
ok   A's loopback still answers
ok   the panel answers over the tailnet
ok   the owner's tailnet session still works
ok   A's own agent stays connected
ok   B and C stay online over the agents' port
seylo panel status on A: Panel running (running), version 0.2.1, http://127.0.0.1:3000 IP access: closed (127.0.0.1:3000); agents' port: open (0.0.0.0:3443) Tailnet: active (http://e2e-a.ts.e2e.test)
ok   seylo panel status says IP access is closed
ok   seylo panel status names the tailnet address
ok   a security_change alert says IP access closed
ok   A's agent restarted during 60 requests over the tailnet, 0 of them not 200
ok   after tailscale serve reset, the agent put the panel's entry back within 5s
ok   after a panel container restart the tailnet answers again (the stale socket was replaced)
ok   with Tailscale stopped on A for 5 minutes (backdated), IP access reopened by itself after 14s
ok   the tailnet counts as not working and Serve on IP address stays off
ok   a security_change alert says IP access reopened
ok   with the tailnet back, IP access stays open for an hour first (reclosesAt 2026-11-11T21:28:14.530Z)
ok   an hour (backdated) after the tailnet worked again, IP access closed again by itself after 44s
seylo panel tailscale status with the agent stopped (exit 0): Tailscale 1.104.5 State Running Tailnet 192.168.64.3 Signed in as e2e Machine e2e-a.ts.e2e.test (100.64.0.1, fd7a:115c:a1e0::1) HTTPS off: the panel is served over http:// inside the tailnet MagicDNS on Key expiry disabled Tailscale DNS off Panel entry http://e2e-a.ts.e2e.test -> unix:/var/lib/seylo/panel/tailnet.sock
ok   seylo panel tailscale status works with the agent stopped
ok   it shows Tailscale running
ok   it shows the panel's entry (Panel entry http://e2e-a.ts.e2e.test -> unix:/var/lib/seylo/panel/tailnet.sock)
seylo panel ip-access on: The panel restarted and turns "Serve on IP address" and the agents' port back on. In a few seconds it restarts once more, with its port open on every address. Check with: seylo panel status
ok   seylo panel ip-access on opened http://192.168.64.3:3000 again after 2s
ok   Serve on IP address is on again
seylo panel tailscale off: config.yml: no_tailnet: true (/var/lib/seylo/config.yml) Restarted the agent. Removed the panel's Tailscale Serve entry. Tailscale itself keeps running. If the panel's IP address was closed, it opens again within about 5 minutes unless the panel is set to stay closed. sudo seylo panel ip-access on o
ok   seylo panel tailscale off removed the panel's entry
ok   tailscale.get says it is off on the server (disabledOnServer)
ok   seylo panel status says the tailnet is off on this server
ok   turning Serve on is refused while it is off on the server (disabledOnServer)
ok   seylo panel tailscale on: the agent put the panel's entry back after 0s
ok   tailscale.get: Serve active again and not off on the server ({"detected":true,"agentSupported":true,"version":"1.104.5","backendState":"Running","tailnet":"192.168.64.3","dnsName":"e2e-a.ts.e2e.test","magicDns":true,"https":false,"acceptDns":false,"disabledOnServer":false,"serve":{"wanted":true,"state":"active","url":"http://e2e-a.ts.e2e.test","panelAnswers":true,"message":""},"owned":{"hostPort":"e2e-a.ts.e2e.test:80","path":"/","proxy":"unix:/var/lib/seylo/panel/tailnet.sock"}})
ok   cleanup: tailscale.get shows no Tailscale on the panel server ({"detected":false,"agentSupported":true,"version":null,"backendState":null,"tailnet":null,"dnsName":null,"magicDns":false,"https":false,"acceptDns":false,"disabledOnServer":false,"serve":{"wanted":false,"state":"off","url":null,"panelAnswers":false,"message":""},"owned":null})
ok   cleanup: Serve is off in the panel
ok   cleanup: IP access is open (http://192.168.64.3:3000 answers)
ok   cleanup: 3 nodes online
```

### 41. Move the panel A -> B in the browser: data, keys, registry and sign-ins come along, every node follows; a failed move rolls back; back to A: PASS

```
before: facts 26|tv0uOH3uACRjzDuFpS2_0AV3|3, keys bc3f4999ab4f6ae97242f18598e4bd1d55b791d87a7f582c40be8fbf9d06808e eeb6081347045e039e5a7e3d1023500c348e95b48fb6a5c37e512bdf16ab73d9 , 5 registry repositories, a: panel_url: http://127.0.0.1:3000 ; b: panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://192.168.64.3:3443 ; c: panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://192.168.64.3:3443 
ok   an API key cannot start a move
panelMove.check on http://192.168.64.3:3000: {"blocks":[],"targets":[{"name":"colima-seylo-e2e-a","ready":false},{"name":"e2e-b","ready":true},{"name":"e2e-c","ready":true}],"defaultAddress":null,"nodesLeftBehind":[]}
panelMove.start to b: {"state":"running","side":null,"moveId":"c13neqrkdwvr87de","targetNodeId":"e6nzwjikjvlxzc3o","targetNodeName":"e2e-b","targetAddress":"192.168.64.4","newUrl":"http://192.168.64.4:3000","step":"pausing","bytesDone":0,"bytesTotal":0,"startedAt":"2026-11-11T20:29:40.955Z","error":null,"leftBehind":[],"doneAt":null,"fromNodeId":"pzy1aouwvqjcx9wm","fromNodeName":"colima-seylo-e2e-a","oldCopyRemoved":fa
ok   the panel moved from a to b in 7s (version 0.2.1)
ok   3 nodes online on the panel on b ([{"name":"e2e-b","status":"online"},{"name":"colima-seylo-e2e-a","status":"online"},{"name":"e2e-c","status":"online"}])
ok   b is the panel node
ok   the panel on a no longer answers
ok   no panel container runs on a
ok   the panel container on b runs as the panel user with a private folder
ok   every node dials the moved panel with the same pin (a: panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://192.168.64.4:3443 ; b: panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://127.0.0.1:3443 ; c: panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://192.168.64.4:3443 )
ok   the API key, projects, services, nodes and the install id came along (26|tv0uOH3uACRjzDuFpS2_0AV3|3)
ok   master.key and the agents' TLS key are the same files on b
ok   the image registry came along (5 repositories, 5 before)
ok   the owner signs in on the moved panel
ok   panelMove.status on the moved panel says done, from a
ok   Add node's command now names B with the same pin
panelMove.removeOldCopy: {"freedBytes":172494408,"status":{"state":"done","side":"new","moveId":"c13neqrkdwvr87de","targetNodeId":"e6nzwjikjvlxzc3o","targetNodeName":"e2e-b","targetAddress":"192.168.64.4","newUrl":"http://192.168.64.4:3000","step":null,"bytesDone":0,"bytesTotal":0,"startedAt":"2026-11-11T20:29:40.955Z","err
ok   the old copy on A is gone (no master.key, no panel container)
panelMove.start to C with its port held: {"state":"running","side":null,"moveId":"cxyo9epw74pkt2lx","targetNodeId":"6vo8mfuphn0zron1","targetNodeName":"e2e-c","targetAddress":"192.168.64.5","newUrl":"http://192.168.64.5:3000","step":"pausing","bytesDone":0,"bytesTotal":0,"startedAt":"2026-11-11T20:31:11.997Z","error":null,"leftBehind":[],"
status after the refused move: {"state":"failed","step":"starting","error":{"step":"starting","message":"the moved panel did not become healthy: the panel is SERVICE_PHASE_FAILED: deploy failed: starting seylo-panel00000000000-15: Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint seylo-panel00000000000-15 (2e7fa6104188bf310f75abbf581728cd55187e0473f0bc7ba15624d1835dc11b): failed to bind host port 0.0.0.0:3443/tcp: address already in use"}}
ok   the move to C failed and rolled back
ok   it failed starting the panel on C (the held port), not pulling its image
ok   the panel still answers on B
ok   C holds no copy of the panel (no master.key)
ok   every node still dials B with the same pin
ok   the panel on B takes changes again after the rollback
panelMove.check on http://192.168.64.4:3000: {"blocks":[],"targets":[{"name":"colima-seylo-e2e-a","ready":true},{"name":"e2e-b","ready":false},{"name":"e2e-c","ready":true}],"defaultAddress":null,"nodesLeftBehind":[]}
panelMove.start to a: {"state":"running","side":null,"moveId":"tie8zppvd1o0we6e","targetNodeId":"pzy1aouwvqjcx9wm","targetNodeName":"colima-seylo-e2e-a","targetAddress":"192.168.64.3","newUrl":"http://192.168.64.3:3000","step":"pausing","bytesDone":0,"bytesTotal":0,"startedAt":"2026-11-11T20:31:16.912Z","error":null,"leftBehind":[],"doneAt":null,"fromNodeId":"e6nzwjikjvlxzc3o","fromNodeName":"e2e-b","oldCopyRemoved":fa
ok   the panel moved from b to a in 7s (version 0.2.1)
ok   3 nodes online on the panel on a ([{"name":"colima-seylo-e2e-a","status":"online"},{"name":"e2e-b","status":"online"},{"name":"e2e-c","status":"online"}])
ok   a is the panel node
ok   the panel on b no longer answers
ok   no panel container runs on b
ok   the panel container on a runs as the panel user with a private folder
ok   every node dials the moved panel with the same pin (a: panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://127.0.0.1:3443 ; b: panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://192.168.64.3:3443 ; c: panel_pin: sha256:268828d047e7e1fbeab10b19c0ecabd000ced21c0fe7a362ee36e607955bd0bf panel_url: https://192.168.64.3:3443 )
ok   the API key, projects, services, nodes and the install id came along (26|tv0uOH3uACRjzDuFpS2_0AV3|3)
ok   master.key and the agents' TLS key are the same files on a
ok   the image registry came along (5 repositories, 5 before)
ok   the owner signs in on the moved panel
ok   panelMove.status on the moved panel says done, from b
ok   the old copy on B is gone
```

### 42. Export whoami with its volume and a Postgres with its data from e2e-exports on B, import both into e2e-imports on C: env, cron job, the volume's file, the rows, basic auth; refusals: PASS

```
ok   xfer runs on B with env, a volume with /marker.txt, basic auth on xfer.192-168-64-4.sslip.io and a cron job
ok   xferdb on B holds the marker row
ok   the export does not stop xfer (stopService off)
ok   the download answered 200 as xfer-20261111-2033.seylo.zip
ok   xfer answered every request while its data was read (  40 200 )
ok   unzip -t passes
ok   python's zipfile reads it
ok   every entry matches its sha256 in manifest.json
ok   the volume's data is in it with its counts
ok   and holds marker.txt (unzip -p | tar -tz)
ok   the secret value is nowhere in the zip, packed or unpacked
ok   with a passphrase the settings are not in clear either (no service.json, no host name)
ok   a second download of the same link is refused
ok   the database's export stops it
ok   xferdb's download answered 200
ok   unzip -t passes on xferdb's file
ok   the export says it held xferdb stopped and started it again
ok   its container started again after the export (2026-11-11T20:33:15.094559284Z -> 2026-11-11T20:33:33.790671536Z)
ok   the audit log has both finished downloads
ok   a wrong passphrase is refused (FORBIDDEN passphrase)
ok   an edited manifest is refused (tampered)
import preview: {"service":"xfer","blockers":[],"needs":[],"domains":[{"host":"xfer.192-168-64-4.sslip.io","status":"auto","action":"skip"}],"data":[{"name":"data","mountPath":"/data","inFile":true,"sizeBytes":212,"unpackedBytes":28,"include":true}],"samePanel":true}
ok   its old automatic domain is not recreated (auto, skip): C gets one of its own
ok   its volume's data is in the file and picked
ok   nothing blocks it on C
ok   C's automatic domain is offered (xfer.192-168-64-5.sslip.io)
ok   it is created stopped, waiting for the volume's data
ok   it cannot start before its data is in (importing)
ok   the volume's data went up ({"received":212,"done":true})
ok   the import is done
ok   the env came along as it was
ok   the cron job came along, off on the same panel
ok   the import's first deploy on C went live
ok   /marker.txt came along in the volume (xfer-marker-96a507473355b9d9)
ok   xfer.192-168-64-5.sslip.io answers 401 without the basic auth password
ok   and 200 with it (the hash came along)
ok   xferdb's data went up ({"received":7692578,"done":true})
ok   the marker row is in the imported xferdb on C
ok   the flipped data is refused (checksum: {"error":{"code":"BAD_REQUEST","message":"The volume's data does not match the file's manifest (sha256). Pick the file again.","details":{"reason":"checksum"}}})
ok   discarding it deletes the service it made
ok   no such service is left
ok   the source still answers on B
ok   its marker is still on B (xfer-marker-96a507473355b9d9)
ok   xferdb on B still has its row
```

### 43. Database version: patch update and a MongoDB major upgrade keep the data: PASS

```
ok   MongoDB 7.0 on B holds a document
versionChoices: {"version":"7.0","image":"mongo:7.0.45","backupFresh":false,"choices":[{"version":"9.0","kind":"major","allowed":false,"reason":"oneStep"},{"version":"8.0","kind":"major","allowed":true,"reason":null},{"version":"7.0","kind":"current","allowed":false,"reason":"current"}]}
ok   8.0 is offered as the next major; 9.0 waits for it (oneStep)
ok   a custom image by digest is refused (customImage)
ok   the patch update deployed (status live)
ok   the container runs mongo:7.0.45-jammy (mongo:7.0.45-jammy)
ok   8.0 without a backup is refused (backupRequired)
ok   the upgrade deployed (status live)
ok   the document survives the upgrade (e2e-43)
ok   8.0 runs with featureCompatibilityVersion 7.0 until the next step (7.0)
database: {"engine":"mongo","version":"8.0"}, choices now: {"image":"mongo:8.0.34","choices":[{"version":"9.0","allowed":true,"reason":null},{"version":"8.0","allowed":false,"reason":"current"},{"version":"7.0","allowed":false,"reason":"downgrade"}]}
ok   going back to 7.0 is refused (downgrade)
ok   a rollback to a 7.0 deployment is refused (databaseVersion)
```
