# E2E results

Written by `test/e2e-colima/checks.sh` from `~/.cache/seylo-e2e/state/results` (rerun one check with
`test/e2e-colima/checks.sh <N>`). VMs: seylo-e2e-a (panel + node, Colima), seylo-e2e-b (Colima), seylo-e2e-c (plain
Lima Ubuntu 24.04, Docker installed by install.sh). Release server and git server on the Mac.

| # | Check | Status | When |
|---|---|---|---|
| 1 | install.sh panel + node on A (signed manifest, image by digest); setup link; panel adopted as protected service | PASS | 50s, 2026-11-08 18:16, panel 0.2.0 |
| 2 | Owner through the setup link; API key; REST op routes | PASS | 0s, 2026-11-08 18:16, panel 0.2.0 |
| 3 | Join B and C (C gets Docker from install.sh); 3 nodes online; health checks | PASS | 66s, 2026-11-08 18:17, panel 0.2.0 |
| 4 | Image service on B with an auto domain; first-run IP:port -> 308 -> closed | PASS | 56s, 2026-11-08 18:18, panel 0.2.0 |
| 5 | Railpack git build on A, run on B through the 127.0.0.1:5755 relay | PASS | 268s, 2026-11-08 18:23, panel 0.2.0 |
| 6 | Dockerfile from git, inline Dockerfile and uploaded archive deploy | PASS | 20s, 2026-11-08 18:23, panel 0.2.0 |
| 7 | Zero downtime redeploy; failing health check keeps old; rollback | PASS | 122s, 2026-11-08 18:25, panel 0.2.0 |
| 8 | Crash policy: 5s restart, stop after N, crash report + one alert per streak | PASS | 112s, 2026-11-08 18:27, panel 0.2.0 |
| 9 | Env references across services; env.analyze flags cross-node address | PASS | 8s, 2026-11-08 18:27, panel 0.2.0 |
| 10 | Postgres: internal URL, project isolation, TLS exposure, web UI, DB shell | PASS | 59s, 2026-11-08 18:28, panel 0.2.0 |
| 11 | Backup Postgres and a volume to MinIO, restore both | PASS | 30s, 2026-11-08 18:28, panel 0.2.0 |
| 12 | Cron: schedule, run-now, history, keeps running while the panel is down | PASS | 231s, 2026-11-08 18:32, panel 0.2.0 |
| 13 | Logs search/follow across deploys; console stdin; shell PTY; files | PASS | 10s, 2026-11-08 18:32, panel 0.2.0 |
| 14 | Metrics: node and service series have samples | PASS | 0s, 2026-11-08 18:32, panel 0.2.0 |
| 15 | Move a service with a volume B -> C; data intact; domain follows | PASS | 21s, 2026-11-08 18:33, panel 0.2.0 |
| 16 | Replicas on B and C, entry on B; failover when either container dies (round robin and sticky) | PASS | 155s, 2026-11-08 18:35, panel 0.2.0 |
| 17 | Compose stack from pasted YAML (two services, shared volume) | PASS | 18s, 2026-11-08 18:36, panel 0.2.0 |
| 18 | A template from the catalog creates and runs | PASS | 9s, 2026-11-08 18:36, panel 0.2.0 |
| 19 | Global and per-service maintenance pages; timed expose locked to an IP | PASS | 321s, 2026-11-08 18:41, panel 0.2.0 |
| 20 | Panel down: apps, routes, crash restarts, cron keep working; outbox delivers | PASS | 243s, 2026-11-08 18:45, panel 0.2.0 |
| 21 | Agent restart adopts running services without restarting them | PASS | 46s, 2026-11-08 18:46, panel 0.2.0 |
| 22 | Self-update N -> N+1 (panel first, then nodes); broken N+2 panel rolls back | PASS | 38s, 2026-11-08 18:47, panel 0.2.1 |
| 23 | Cleanup preview + run removes only seylo-labeled garbage | PASS | 17s, 2026-11-08 18:47, panel 0.2.1 |
| 24 | Laptop CLI: login, deploy, env set/list, logs -f | PASS | 50s, 2026-11-08 18:48, panel 0.2.1 |
| 25 | MCP: read-only token lists tools and runs a query; destructive call -> approval | PASS | 1s, 2026-11-08 18:48, panel 0.2.1 |
| 26 | seylo troubleshoot --dry-run redacts; seylo status shows the connection | PASS | 0s, 2026-11-08 18:48, panel 0.2.1 |
| 27 | Uninstall on C leaves nothing behind | PASS | 158s, 2026-11-08 18:50, panel 0.2.1 |
| 28 | C (systemd cgroup driver) runs containers under seylo.slice | PASS | 76s, 2026-11-08 18:52, panel 0.2.1 |
| 29 | (stretch) ACME certificate from a local Pebble CA | PASS | 10s, 2026-11-08 18:52, panel 0.2.1 |
| 30 | Web smoke with Playwright against the e2e panel | PASS | 4s, 2026-11-08 18:52, panel 0.2.1 |
| 31 | Panel domain: Pebble HTTPS, Secure cookie, HSTS, IP:port -> domain, nodes move to it, CLI | PASS | 900s, 2026-11-08 19:19, panel 0.2.1 |
| 32 | Docker Hub: search, tags, inspect traefik/whoami on the real Docker Hub; dockerHub.create on B live on its auto domain | PASS | 8s, 2026-11-08 18:52, panel 0.2.1 |
| 33 | Gitea provider on A: a push outside the watch path skips (reason logged), inside deploys, [skip ci] skips | PASS | 48s, 2026-11-08 18:53, panel 0.2.1 |
| 34 | Scheduled cleanup on B: a disk line triggers a run that removes only labelled resources and reports them | PASS | 15s, 2026-11-08 18:53, panel 0.2.1 |
| 35 | Host shell on B: owner turns it on with re-auth, hostname through the panel's socket, audited, agent refuses when off | PASS | 24s, 2026-11-08 18:54, panel 0.2.1 |
| 36 | Clone whoami with its data into another project on C; move a service between projects (impact list, keeps serving) | PASS | 162s, 2026-11-08 18:56, panel 0.2.1 |
| 37 | Valkey, ClickHouse, Postgres 18 + pgvector on B: app connects, TLS exposure, shell query, backup to MinIO, restore | PASS | 89s, 2026-11-08 18:58, panel 0.2.1 |
| 38 | Upgrade: a 0.1.1 panel and node with real rows move to this build by the normal update; 0001 applies, data survives | PASS | 369s, 2026-11-08 19:04, panel 0.2.1 |

38 passed, 0 failed, 0 blocked/skipped/not run.

## Evidence

### 1. install.sh panel + node on A (signed manifest, image by digest); setup link; panel adopted as protected service: PASS

```
ok   install.sh printed the setup link http://192.168.5.4:3000/setup?t=<redacted>
note: the link host is not A's vzNAT address 192.168.64.3 (the VM has two interfaces)
ok   panel answers on http://192.168.64.3:3000/api/health
ok   seylo.service is active on A
ok   A's agent joined its own panel: Panel: http://127.0.0.1:3000 (connected, version 0.2.0)
ok   install.sh checked the signed release manifest
ok   the panel runs the release's image pinned by digest (127.0.0.1:15000/seylo:0.2.0@sha256:27d2b6a7e24c4eb8dd551f23f8f2f4bc98fa4a423776d8f3a05f645e9c3d011b)
panel container 183618ad4323: {"seylo.generation":"1","seylo.kind":"app","seylo.managed":"true","seylo.project":"panelproject0000","seylo.protected":"true","seylo.replica":"0","seylo.service":"panel00000000000","seylo.user":"61000:61000"}
ok   panel container is in project panelproject0000
ok   panel container is protected
ok   the panel runs as the panel user with its folder closed to login users (61000:61000 61000:61000:700 61000:61000:600)
ok   no roll after the join: same container 183618ad4323 (now 183618ad4323)
seylo panel status: Panel running (running), version 0.2.0, http://127.0.0.1:3000 
ok   the agent manages the panel service
ok   panel container survives an agent restart (same id, StartedAt 2026-11-08T16:15:45.153987113Z)
ok   panel still answers after the agent restart
```

### 2. Owner through the setup link; API key; REST op routes: PASS

```
setup.status: {"ownerExists":false,"link":{"valid":true,"expiresAt":"2026-11-08T17:15:45.469Z"}}
ok   the setup link is valid
ok   owner owner@e2e.test created through setup.createOwner (session cookie)
ok   API key created with the owner session (prefix seylo_key_Kp...)
ok   auth.whoami with the API key: {"email":"owner@e2e.test","kind":null}
ok   Panel project: {"id":"panelproject0000","name":"Panel","protected":true,"serviceCount":1}
ok   Panel project is protected
ok   panel service: {"id":"panel00000000000","name":"panel","status":"running","protected":true,"placements":["colima-seylo-e2e-a"]}
```

### 3. Join B and C (C gets Docker from install.sh); 3 nodes online; health checks: PASS

```
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.0' --pin 'sha256:ecd6b1d49a6eba0abb220271d74998f455984307485038dbd3ae49caf303c1b5'
ok   the join command uses the agents' TLS port with --pin (insecureTransport false)
ok   the join command needs no --insecure
ok   installer join on seylo-e2e-b finished: ==> Docker;Docker 29.5.2 is running;Turning on Docker live-restore: containers keep running while Docker restarts;==> Joining https://192.168.64.3:3443;The agent is starting and joins the panel; the node shows up there in a few seconds.;
ok   C had no Docker before its first join
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.0' --pin 'sha256:ecd6b1d49a6eba0abb220271d74998f455984307485038dbd3ae49caf303c1b5'
ok   the join command uses the agents' TLS port with --pin (insecureTransport false)
ok   the join command needs no --insecure
ok   installer join on seylo-e2e-c finished: ==> Docker;Installing Docker with get.docker.com;Using systemd to manage Docker service;INFO: Docker daemon enabled and started;Client: Docker Engine - Community;Server: Docker Engine - Community;To run Docker as a non-privileged user, consider setting up the;Docker daemon in rootless mode for your 
ok   3 nodes online
node a: {"id":"kh8uuihi9a83uzgh","name":"colima-seylo-e2e-a","status":"online","publicIpv4":null,"agentVersion":"0.2.0","canBuild":true,"facts":{"hostname":"colima-seylo-e2e-a","os":"ubuntu 24.04","arch":"arm64","cpuCores":4,"dockerVersion":"29.5.2","cgroupVersion":2}}
ok   node a has facts
health a: {"pass":20,"warn":0,"fail":0,"skipped":0} not passing: []
ok   health check on a has no fail
node b: {"id":"wrwwri52kixfskj3","name":"e2e-b","status":"online","publicIpv4":null,"agentVersion":"0.2.0","canBuild":false,"facts":{"hostname":"colima-seylo-e2e-b","os":"ubuntu 24.04","arch":"arm64","cpuCores":2,"dockerVersion":"29.5.2","cgroupVersion":2}}
ok   node b has facts
health b: {"pass":18,"warn":1,"fail":0,"skipped":1} not passing: ["docker.buildx=skipped: builds are off on this node","network.publicAddress=warn: No public address is known, so IP:port links, exposed databases and load balancing use the"]
ok   health check on b has no fail
node c: {"id":"mbjvrxgzu53u5ooh","name":"e2e-c","status":"online","publicIpv4":null,"agentVersion":"0.2.0","canBuild":false,"facts":{"hostname":"lima-seylo-e2e-c","os":"ubuntu 24.04","arch":"arm64","cpuCores":2,"dockerVersion":"29.9.3","cgroupVersion":2}}
ok   node c has facts
health c: {"pass":17,"warn":2,"fail":0,"skipped":1} not passing: ["docker.buildx=skipped: builds are off on this node","proxy.running=warn: the proxy container does not exist yet","network.publicAddress=warn: No public address is known, so IP:port links, exposed databases and load balancing use the"]
ok   health check on c has no fail
b config.yml: panel_url: https://192.168.64.3:3443 panel_pin: sha256:ecd6b1d49a6eba0abb220271d74998f455984307485038dbd3ae49caf303c1b5 
ok   b joined over https:// with the panel's key pinned (panel_pin, no insecure_transport)
c config.yml: panel_url: https://192.168.64.3:3443 panel_pin: sha256:ecd6b1d49a6eba0abb220271d74998f455984307485038dbd3ae49caf303c1b5 
ok   c joined over https:// with the panel's key pinned (panel_pin, no insecure_transport)
plain join refused: time="2026-11-08T18:17:35+02:00" level=fatal msg="exit status 1"
ok   the agent refuses a plain-HTTP join to another server without --insecure (and writes nothing)
C Docker after install.sh: 29.9.3 cgroup driver systemd v2 
```

### 4. Image service on B with an auto domain; first-run IP:port -> 308 -> closed: PASS

```
ok   B's wildcard domain: 192-168-64-4.sslip.io (sslip.io resolves it to B's address)
ok   whoami deployed on B (deployment live)
ok   first-run IP:port 192.168.64.4:36497 answers 200 before any domain
auto domain whoami.192-168-64-4.sslip.io (https acme)
ok   http://whoami.192-168-64-4.sslip.io answers through B's Traefik: Hostname: whoami
ok   first-run 192.168.64.4:36497 now redirects: 308 -> http://whoami.192-168-64-4.sslip.io/
firstRun after the domain went live: {"domainLiveAt":"2026-11-08T16:17:47.745Z","closeWhenDomainLive":true,"redirectToPrimary":true,"status":"redirecting","address":"192.168.64.4:36497","redirectTo":"http://whoami.192-168-64-4.sslip.io","closeAt":"2026-11-09T16:17:47.745Z","firewallHint":null}
the redirect closes by itself at 2026-11-09T16:17:47.745Z (too far to wait); moving that time 1 minute into the past in the panel database
ok   first-run 192.168.64.4:36497 closed by itself once closeAt passed (connection refused; exposures.get: {"status":"closed","address":null})
```

### 5. Railpack git build on A, run on B through the 127.0.0.1:5755 relay: PASS

```
deployment: {"status":"live","builder":"railpack","builtOn":"colima-seylo-e2e-a","shippedTo":["e2e-b"],"image":"127.0.0.1:5755/dfjgckaj61dc9w9b:1","digest":"sha256:2f330ddb0903e4ea2b2c352bffce5cbdd779132028a88418048de1ab7f4e1436","steps":["clone=ok","build=ok","ship=ok","health=ok","switch=ok"],"error":null}
ok   Railpack build from https://192.168.64.1:18556/git/node-app.git is live
ok   built on A (can-build): builtOn=colima-seylo-e2e-a
ok   shipped to B
deploy log says: Building on colima-seylo-e2e-a.|#1 pulling image moby/buildkit:buildx-stable-1 6.7s done|#1 creating container buildx_buildkit_seylo-builder-21o04oc93akwgxpq-2c-3g0 0.5s done|
container on B runs image 127.0.0.1:5755/dfjgckaj61dc9w9b:1@sha256:2f330ddb0903e4ea2b2c352bffce5cbdd779132028a88418048de1ab7f4e1436
ok   B pulled it through the 127.0.0.1:5755 relay by digest
ok   the app answers on its first-run address 192.168.64.4:38793
```

### 6. Dockerfile from git, inline Dockerfile and uploaded archive deploy: PASS

```
ok   Dockerfile build from git (go-app) is live
ok   go-app answers: go-app dockerfile on go-app
ok   inline Dockerfile service is live
ok   inline-app answers inline-ok
POST /api/uploads/services/<id> -> 200 {"uploadId":"0yax11tx97midnwo","sizeBytes":638,"deployment":{"id":"gmo479a22xqrz7v5","serviceId":"x8wji86jx9d0xi5v","generation":1,"status":"queued","live":false,"trigger":"api","actor":"owner@e2e.tes
ok   uploaded archive service is live
ok   upload-app answers upload-app ok
```

### 7. Zero downtime redeploy; failing health check keeps old; rollback: PASS

```
redeploy v1 -> v2 ended live; 619 requests during it, 0 not 200 ( 619 200 )
ok   zero downtime: no failed request during the redeploy
ok   v2 serves after the redeploy (Name: v2)
deploy with a failing health check ended failed: {"error":"e2e-b: not healthy after 30s: health check never passed: http check GET /: status 200\nlast output:\n2026/11/08 16:24:44 Starting up on port 80 The previous version stayed live.","steps":["clone=skipped","build=skipped","ship=ok","health=failed","switch=skipped"]}
ok   the failing deploy is marked failed
ok   the old version keeps serving (Name: v2)
node-app redeploy of the new commit ended live: {"app":"node-app","version":"v2","host":"node-app","greeting":null,"upstream":null}
ok   node-app v2 is live
rollback to t6uej40p6mjq3c00 ended live ({"trigger":"rollback","rollbackOf":"t6uej40p6mjq3c00","image":"127.0.0.1:5755/dfjgckaj61dc9w9b:1"}): {"app":"node-app","version":"v1","host":"node-app","greeting":null,"upstream":null}
ok   rollback serves v1 again
```

### 8. Crash policy: 5s restart, stop after N, crash report + one alert per streak: PASS

```
restart on: 3 crashes in 45s; die -> next start gaps: 5 6 5 s
ok   the service is restarted after each crash
ok   the wait before a restart is the fixed 5s (gaps 5 6 5 )
crash reports in the panel: 3 ([{"streak":1,"action":"restarting","exit_code":3},{"streak":2,"action":"restarting","exit_code":3},{"streak":3,"action":"restarting","exit_code":3}])
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
ok   an app in ANOTHER project cannot reach it (PG-FAILED-11 PG-FAILED-12)
exposed: {"host":"192.168.64.4","port":25432,"user":"external","tlsParams":"sslmode=require"}
ok   psql from the Mac over TLS (sslmode=require): tls=true TLSv1.3
ok   the exposed user cannot log in without TLS
web UI ticket URL: https://seylo-db-vagiosbudle45job.192-168-64-4.sslip.io/_seylo/ticket?t=<redacted>
ok   the web UI ticket opens pgweb through B's edge (seylo-db-vagiosbudle45job.192-168-64-4.sslip.io, 200)
ok   the DB shell ran a query without a password (select 40+2 -> 42)
```

### 11. Backup Postgres and a volume to MinIO, restore both: PASS

```
ok   MinIO destination http://192.168.64.3:19000/e2e-backups
database backup run: {"kind":"backup","status":"succeeded","objectKey":"e2e/vagiosbudle45job/3urov6yjyviutlnj/20261108T162827Z-d7pk1qpva2g8zuhl.sql.gz","sizeBytes":1640,"error":null}
ok   the Postgres backup succeeded
ok   the backup object is in MinIO
restore run: {"kind":"restore","status":"succeeded","objectKey":"e2e/vagiosbudle45job/3urov6yjyviutlnj/20261108T162827Z-d7pk1qpva2g8zuhl.sql.gz","sizeBytes":1640,"error":null}
ok   the restored database has the marker row
volume backup run: {"kind":"backup","status":"succeeded","objectKey":"e2e/wq9uvey00vzm2d7y/bo9s6xn91s09td0t/20261108T162840Z-7e5iexln0b0sfg78.tar.gz","sizeBytes":260,"error":null}
volume restore run: {"kind":"restore","status":"succeeded","objectKey":"e2e/wq9uvey00vzm2d7y/bo9s6xn91s09td0t/20261108T162840Z-7e5iexln0b0sfg78.tar.gz","sizeBytes":260,"error":null}
ok   the restored volume has marker.txt
```

### 12. Cron: schedule, run-now, history, keeps running while the panel is down: PASS

```
ok   run-now result in the history ([{"result":"succeeded","exitCode":0}])
ok   a scheduled run in the history ([{"result":"succeeded","startedAt":"2026-11-08T16:29:00.000Z"}])
panel paused at 2026-11-08T16:29:06Z
panel back at 2026-11-08T16:31:37Z
runs that started while the panel was down: 2 ([{"startedAt":"2026-11-08T16:31:00.000Z","result":"succeeded"},{"startedAt":"2026-11-08T16:30:00.000Z","result":"succeeded"}])
ok   cron kept running while the panel was down (2 or more runs in 150s)
```

### 13. Logs search/follow across deploys; console stdin; shell PTY; files: PASS

```
logs.search 'listening': 3 lines across generations [1,2,3]
ok   search finds lines from two or more deploys
ok   logs.follow streamed lines (tail, then the restart's 'listening on')
ok   Console echoed stdin (echo:hello-e2e); ready: {"type":"ready","containerId":"7146b4971dcfd3bdc85c8c1da9ed19e826d53595c2c0ca86e52778b9912afe02","generation":1,"user":"root","workdir":"/"}
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
node a: {"points":16,"latest":{"cpuPercent":0.7015785517414219,"memoryUsedBytes":923394048}}
ok   node a has samples
node b: {"points":15,"latest":{"cpuPercent":1.6072325464590698,"memoryUsedBytes":629936128}}
ok   node b has samples
node c: {"points":13,"latest":{"cpuPercent":0.10015022533800266,"memoryUsedBytes":463683584}}
ok   node c has samples
service o6har8ri9c314qad: {"points":14,"current":[{"cpuPercent":0.01356425702811245,"memoryBytes":2736128}]}
ok   service o6har8ri9c314qad has samples
service dfjgckaj61dc9w9b: {"points":8,"current":[{"cpuPercent":0.006302057200200703,"memoryBytes":23212032}]}
ok   service dfjgckaj61dc9w9b has samples
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
30 requests to the entry node B answered from (traefik/replica):  15 776c5fe3fde8/172.19.0.4 15 970abe4cb177/172.19.0.14 
B's route for lb.e2e.test:  - url: http://172.18.0.1:5756 - url: http://seylo-pwngn3njvfaq972t-1:80 - url: https://192.168.64.5:5757 
ok   both replicas (B and C) answer through the entry node
killed the replica on C (3359b60cf598) during the load
186 requests during the failover, 0 not 200 ( 186 200 )
ok   requests keep succeeding when one replica dies
killed the replica on b (6a849f5e450b) during the load
179 requests during the failover, 0 not 200 ( 179 200 )
ok   requests keep succeeding when the entry node's own replica dies
cookie jar pinned to b's copy (172.19.0.14): 6 of 6 requests answered by it
ok   the sticky cookie pins a client to one copy
killed the replica on b (6a849f5e450b) during the load (sticky)
170 requests during the failover, 0 not 200 ( 170 200 )
ok   a client pinned to the copy on B keeps being answered when it dies
cookie jar pinned to c's copy (172.19.0.4): 6 of 6 requests answered by it
ok   the sticky cookie pins a client to one copy
killed the replica on c (3359b60cf598) during the load (sticky)
157 requests during the failover, 0 not 200 ( 157 200 )
ok   a client pinned to the copy on C keeps being answered when it dies
```

### 17. Compose stack from pasted YAML (two services, shared volume): PASS

```
stack atambcwmcaa9vi1s with members ["stack-reader","stack-writer"]
member 1ozknp5y8cm9y7so container e5e825c717b8: read-1794155766 read-1794155768 
member uewyq9sdb0j2r802 container f14997827aa6: wrote wrote 
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
timed expose: {"host":"192.168.64.4","port":null,"allowedCidrs":["192.168.64.1/32"],"expiresAt":"2026-11-08T16:41:22.104Z"}
ok   the Mac (192.168.64.1) reaches 192.168.64.4:33641
ok   VM A (192.168.64.3) is refused (got 000)
ok   global maintenance page on whoami.192-168-64-4.sslip.io (HTTP )
ok   per-service maintenance page on whoami.192-168-64-4.sslip.io
ok   another service (lb.e2e.test) is not in maintenance
waiting 307s for the expose to expire at 2026-11-08T16:41:22.104Z
ok   the timed expose closed by itself on time (got 000)
```

### 20. Panel down: apps, routes, crash restarts, cron keep working; outbox delivers: PASS

```
panel paused at 2026-11-08T16:42:03Z
ok   the app and its route kept serving while the panel was down (30 ok, 0 failed)
ok   crash restarts kept working while the panel was down (11 crashes, 11 restarts)
panel back at 2026-11-08T16:44:34Z
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
panel container image now: 127.0.0.1:15000/seylo:0.2.1@sha256:22dd04241f0b67b65ad5cb43a41b4ee2f4682b6c389321baf6e8f58b060c20b7
broken update run: {"targetVersion":"0.2.2","status":"failed","error":"the new panel did not become healthy: the panel is SERVICE_PHASE_FAILED: deploy failed: seylo-panel00000000000-3 exited right after starting","steps":["panel:rolledBack:the new panel did not become healthy: the panel is SERVICE_PHASE_FAILED: deploy "]}
ok   the 0.2.2 run is marked failed or rolled back
ok   the panel still runs 0.2.1 after the rollback (now 0.2.1)
ok   the restored database is intact (the API key works, projects are there)
ok   the old image runs again (127.0.0.1:15000/seylo:0.2.1@sha256:22dd04241f0b67b65ad5cb43a41b4ee2f4682b6c389321baf6e8f58b060c20b7)
```

### 23. Cleanup preview + run removes only seylo-labeled garbage: PASS

```
made an unlabeled stopped container, volume and image, plus a labelled image, volume and data folder of a removed service
preview: {"bytes":3070,"count":3,"items":["image e2e-seylo-garbage-img:1 (b54daf2a620b) (3.0 KiB): service removed from this node","volume e2e-seylo-garbage-vol: service removed from this node","data deadbeefdeadbeef (8 B): service removed from this node"]}
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
read-only token sees 97 tools, destructive ones: []
ok   the read-only token lists tools
ok   the read-only token sees no destructive tool
ok   a query tool (nodes_list) runs and returns the nodes
destructive call (services_delete) answered: This action needs a person's approval before it runs. Approval ymkpfapncetk44j7 is waiting in the panel's Approvals page (it expires at 2026-11-09T16:48:18.113Z). Call approvals_get with {"approvalId":"ymkpfapncetk44j7"}
ok   the destructive call created a pending approval ([{"id":"ymkpfapncetk44j7","status":"pending"}])
ok   the service still exists while the approval waits
```

### 26. seylo troubleshoot --dry-run redacts; seylo status shows the connection: PASS

```
troubleshoot --dry-run on B: 289 lines, 1 redaction markers
ok   the report is redacted (markers present)
ok   no join token, API key or private key in the report
seylo status on B: Node: e2e-b (wrwwri52kixfskj3) Agent: 0.2.1 (commit e2e, built unknown) Panel: https://192.168.64.3:3443 (connected, version 0.2.1) PROJECT SERVICE PHASE 21o04oc93akwgxpq go-app running 
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
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.1' --pin 'sha256:ecd6b1d49a6eba0abb220271d74998f455984307485038dbd3ae49caf303c1b5'
ok   installer join on seylo-e2e-c finished: ==> Docker;Docker 29.9.3 is running;==> Joining https://192.168.64.3:3443;The agent is starting and joins the panel; the node shows up there in a few seconds.;
C joined again as jxoptiv010ajg7f1
```

### 28. C (systemd cgroup driver) runs containers under seylo.slice: PASS

```
C Docker cgroup driver: systemd
ok   C uses the systemd cgroup driver
container 230b0502d5cc: CgroupParent=seylo.slice, /proc cgroup=0::/seylo.slice/docker-230b0502d5cc61d965cf9f056dbcb3c031f4fbce2c96b870f117cbca57d60d4f.scope
ok   the container's cgroup parent is seylo.slice
ok   the process runs under seylo.slice
ok   systemd shows it in seylo.slice
```

### 29. (stretch) ACME certificate from a local Pebble CA: PASS

```
ok   acme.192-168-64-4.sslip.io serves a certificate issued by Pebble
```

### 30. Web smoke with Playwright against the e2e panel: PASS

```
service tabs visited: deployments, source, environment, domains, logs, console, shell, metrics, storage, settings
 1 passed (2.7s)
ok   Playwright: dashboard shows the nodes, services and every tab load, console echoes, no page errors
```

### 31. Panel domain: Pebble HTTPS, Secure cookie, HSTS, IP:port -> domain, nodes move to it, CLI: PASS

```
ok   A, B and C trust Pebble's root (/CN=Pebble Root CA 47de12); on the Mac only this check's curl and CLI calls do
B's and C's agents restarted to read the new trust store
A's agent restarted with Pebble (https://192.168.64.3:14000/dir) as its ACME CA
ok   panel domain panel190529.192-168-64-3.sslip.io set (sslip.io answers 192.168.64.3, A's address)
ok   https://panel190529.192-168-64-3.sslip.io answers with a certificate Pebble's root verifies: issuer= /CN=Pebble Intermediate CA 045c00 notAfter=Nov 14 17:05:30 2026 GMT 
ok   http://panel190529.192-168-64-3.sslip.io goes to HTTPS (301 https://panel190529.192-168-64-3.sslip.io/)
the panel's domain check after 3s: {"state":"active","message":""}
ok   the panel's own probe found panel190529.192-168-64-3.sslip.io active (it trusts the test CA in a test build)
ok   settings.general reports the domain active
ok   HTTPS answers carry HSTS (strict-transport-security: max-age=31536000)
ok   plain HTTP on IP:port carries no HSTS
auth.login over https://panel190529.192-168-64-3.sslip.io: HTTP/2 200 ; set-cookie: __Host-seylo_session=<redacted>; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax
ok   the session cookie set over HTTPS is Secure
ok   the session cookie is HttpOnly
ok   the session cookie over HTTPS is __Host- prefixed
ok   the session cookie names no Domain
ok   the HTTPS cookie alone is no session
ok   the HTTPS session works (auth.whoami with the session key)
ok   a page load on IP:port answers 302 to the domain (302 https://panel190529.192-168-64-3.sslip.io/settings/general?e2e=31)
ok   the panel's pages answer on the domain
ok   the API on IP:port is not redirected (scripts, CLI and agents keep working)
ok   pages on A's loopback are not redirected (the way back in over SSH)
ok   seylo login https://panel190529.192-168-64-3.sslip.io (macOS CLI, API key): Signed in to https://panel190529.192-168-64-3.sslip.io as owner@e2e.test (profile "default").
ok   seylo env set e2e/whoami over the domain: Saved. The new values apply on the next deploy.
ok   seylo env list over the domain shows E2E_DOMAIN_CLI
ok   the panel asked B and C to reconnect and both moved without a restart
ok   b moved to the domain: panel_url: https://panel190529.192-168-64-3.sslip.io 
ok   c moved to the domain: panel_url: https://panel190529.192-168-64-3.sslip.io 
ok   A (the panel's node) keeps dialing loopback
ok   b has no panel_pin (the domain's certificate is checked with system roots)
ok   b dropped insecure_transport
ok   b keeps the old address as a fallback for one cycle (fallback: panel_url: https://192.168.64.3:3443 panel_pin: sha256:...f303c1b5 )
b agent log: time=2026-11-08T19:05:33.313+02:00 level=INFO msg="moved to the panel's new address; the old one stays as a fallback until a reconnect there works" panel_url=https://panel190529.192-168-64-3.sslip.io fallback=https://192.168.64.3:3443
ok   b is connected through the domain: Panel: https://panel190529.192-168-64-3.sslip.io (connected, version 0.2.1)
ok   b's agent talks to A:443, not to the agents' TLS port 3443 (ports on A it holds: 443 )
ok   c has no panel_pin (the domain's certificate is checked with system roots)
ok   c dropped insecure_transport
ok   c keeps the old address as a fallback for one cycle (fallback: panel_url: https://192.168.64.3:3443 panel_pin: sha256:...f303c1b5 )
c agent log: time=2026-11-08T17:05:33.529Z level=INFO msg="moved to the panel's new address; the old one stays as a fallback until a reconnect there works" panel_url=https://panel190529.192-168-64-3.sslip.io fallback=https://192.168.64.3:3443
ok   c is connected through the domain: Panel: https://panel190529.192-168-64-3.sslip.io (connected, version 0.2.1)
ok   c's agent talks to A:443, not to the agents' TLS port 3443 (ports on A it holds: 443 )
ok   3 nodes online after the move
ok   b reconnects through the domain after an agent restart: Panel: https://panel190529.192-168-64-3.sslip.io (connected, version 0.2.1)
ok   b still dials the domain
ok   b keeps its pinned old address as a standing fallback ("the panel's new address works after a reconnect; keeping the previous pinned one for when it stops answering" panel_url=https://panel190529.192-168-64-3.sslip.)
ok   b holds no connection to the agents' TLS port (ports on A: 443 )
ok   c reconnects through the domain after an agent restart: Panel: https://panel190529.192-168-64-3.sslip.io (connected, version 0.2.1)
ok   c still dials the domain
ok   c keeps its pinned old address as a standing fallback ("the panel's new address works after a reconnect; keeping the previous pinned one for when it stops answering" panel_url=https://panel190529.192-168-64-3.sslip.)
ok   c holds no connection to the agents' TLS port (ports on A: 443 )
ok   3 nodes online after restarting B's and C's agents
ok   panel domain removed (settings.updateGeneral {domain: null})
ok   IP:port pages are served again
ok   B and C came back to https://192.168.64.3:3443 by themselves 393s after the restart: b panel_pin: sha256:ecd6b1d49a6eba0abb220271d74998f455984307485038dbd3ae49caf303c1b5 panel_url: https://192.168.64.3:3443 , c panel_pin: sha256:ecd6b1d49a6eba0abb220271d74998f455984307485038dbd3ae49caf303c1b5 panel_url: https://192.168.64.3:3443 
cleanup: A's agent restarted without the Pebble ACME settings
ok   cleanup: b is back on the agents' TLS port with the pin, no fallback, connected (Panel: https://192.168.64.3:3443 (connected, version 0.2.1))
ok   cleanup: c is back on the agents' TLS port with the pin, no fallback, connected (Panel: https://192.168.64.3:3443 (connected, version 0.2.1))
ok   cleanup: 3 nodes online
```

### 32. Docker Hub: search, tags, inspect traefik/whoami on the real Docker Hub; dockerHub.create on B live on its auto domain: PASS

```
search traefik/whoami: [{"repository":"traefik/whoami","publisher":"traefik","badge":"none","pullCount":46647336},{"repository":"traefik","publisher":"Docker","badge":"official","pullCount":3597346669},{"repository":"rancher/library-traefik","publisher":"Rancher by SUSE","badge":"verified","pullCount":22521617}]
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
webhook: {"created":true,"url":"http://192.168.64.3:3000/api/hooks/gitea/n9sd8auky1g854v0","error":null,"insecure":true}
ok   the panel created the webhook on the Gitea repository
ok   the first deploy (Dockerfile from the private Gitea repository, built on A) is live
ok   watch-app answers v1 on 192.168.64.4:42639
push 1 (docs/notes.md): {"event":"push","outcome":"ignored","detail":"Skipped by watch paths: the one changed file matches no pattern."}
ok   push 1 is skipped by the watch path, with the reason
ok   push 1 started no deploy (1 deployments)
push 2 (app/index.html): {"event":"push","outcome":"deployed","detail":"Deploying 648083e from main."}
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
B's disk: 7% before, 54% after filling; the line is 50%
run: {"trigger":"disk","status":"succeeded","diskPercent":53,"removedCount":2,"bytesFreed":3059,"error":null}
it reported: ["image e2e34-labelled-img:1 (a69d359def50) (3.0 KiB): service removed from this node","volume e2e34-labelled-vol: service removed from this node"]
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
hostShell.setEnabled (owner session after auth.reauth): {"nodeId":"wrwwri52kixfskj3","enabled":true}
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
ok   whoami on B has a data volume with /marker.txt (clone-marker-6f17f5b4)
clone preview: {"name":"whoami-copy","env":"copied","volumes":[{"name":"data","mountPath":"/data"}],"data":{"available":true,"blockedBy":null,"alwaysStops":false},"autoDomain":null}
ok   the preview offers a copy of the data volume
clone: {"copied":{"env":true,"fileMounts":false,"databaseLogins":false,"middlewares":false,"autoDomain":null},"dataCopy":{"status":"queued","volumes":["data"]}}
data copy: {"status":"done","bytesCopied":21,"error":null}
ok   the data copy finished
ok   whoami kept serving while it was cloned (506 requests, 0 failed)
ok   the clone runs on C in project e2e-clones
ok   the clone answers on C's IP:port (192.168.64.5:34757)
ok   the clone's volume has the copied marker (clone-marker-6f17f5b4)
move impact: {"blockers":[],"referencedBy":[{"serviceId":"3pubo5neg2zmmudo","name":"ref-app","keys":["WHO"]}],"switches":true,"grants":{"count":0,"names":[]},"sharedLost":{"count":0,"names":[]}}
ok   the impact lists ref-app (WHO) losing the reference and a running switch
ok   moving without confirm is refused when the impact lists something
moveProject: switch deployment nnbbxs0dcejfajmo
ok   the switch to the new project's network went live
ok   the clone kept serving through the move (765 requests, 0 failed)
ok   the clone now belongs to e2e-moved
ok   its container is on e2e-moved's network only
ok   whoami (the source) still answers on B
```

### 37. Valkey, ClickHouse, Postgres 18 + pgvector on B: app connects, TLS exposure, shell query, backup to MinIO, restore: PASS

```
engines: [{"engine":"postgres","versions":["18","17","16","15"],"variants":["pgvector"]},{"engine":"valkey","versions":["9.1","9.0","8.1"],"variants":[]},{"engine":"clickhouse","versions":["26.8","26.3"],"variants":[]}]
databases: {"name":"vk","engine":"valkey","version":"9.1","variant":null,"internal":{"host":"vk","port":6379,"database":"","user":"default","httpPort":null},"shellClient":"valkey-cli"} {"name":"ch","engine":"clickhouse","version":"26.8","variant":null,"internal":{"host":"ch","port":9000,"database":"e2e","user":"ch_xtz0igz3bc","httpPort":8123},"shellClient":"clickhouse-client"} {"name":"pg18","engine":"postgres","version":"18","variant":"pgvector","internal":{"host":"pg18","port":5432,"database":"app","user":"app","httpPort":null},"shellClient":"psql"} 
ok   Valkey 9.1, ClickHouse 26.8 and Postgres 18 (pgvector image) run on B
ok   psql shell: CREATE EXTENSION vector, and [1,2,3] <-> [1,2,5] = 2
ok   valkey-cli shell: SET and GET without a password
ok   clickhouse-client shell: SELECT concat('e2e-', toString(40 + 2)) -> e2e-42
probe: PROBE vk=[+OK +PONG ] ch=[42] pg=[0.8.7] DATA-PROBE-OK 
ok   an app of the project reaches Valkey (PONG), ClickHouse over HTTP (42) and pgvector by references
valkey exposed: {"host":"192.168.64.4","port":26380,"user":"default","tlsParams":""}
ok   valkey-cli --tls from A reaches Valkey through B's TLS port 26380 (PONG)
ok   Valkey's exposed port refuses plain TCP clients
clickhouse exposed: {"host":"192.168.64.4","port":29440,"user":"external","tlsParams":"secure=true&skip_verify=true"}
ok   clickhouse-client --secure from A reaches ClickHouse's native port through B's TLS port 29440 (42)
ok   psql from the Mac reaches Postgres 18 over TLS (18.6)
ok   Postgres' exposed user cannot log in without TLS
ok   Valkey: backup to MinIO, then the restore brings back the value from before
ok   ClickHouse: backup to MinIO, the dropped table is back after the restore (before-backup)
ok   Postgres 18: backup to MinIO, the dropped vector table is back after the restore ([1,2,3])
ok   the backups are in MinIO
```

### 38. Upgrade: a 0.1.1 panel and node with real rows move to this build by the normal update; 0001 applies, data survives: PASS

```
ok   C left A's panel and was uninstalled
ok   C runs panel 0.1.1 ({"status":"ok","version":"0.1.1"})
ok   the 0.1.1 panel runs its release image by digest (127.0.0.1:15000/seylo:0.1.1@sha256:0b2cb1a069a8a4edbeceacc58ca6e5d55def58fcad8eab25a321e31aa77e7fe4)
ok   owner, API key and C's own node on the 0.1.1 panel
on 0.1.1: cron job saved as {"schedule":"0 4 * * 7","nextRunAt":"2026-11-15T04:00:00.000Z"}; run now:   api cron.runNow {"serviceId":"pqx680x5cyohyvjk","cronJobId":"0teakxp3g0ki1wl0"} -> 404 {"error":{"code":"NOT_FOUND","message":"no such cron job on this node: service pqx680x5cyohyvjk job \"0teakxp3g0ki1wl0\"","details":{"reason":"agent","nodeId":"7nrardd61fjl5id0","agentStatus":"NOT_FOUND"}}}
before: projects ["Panel","upgrade"]; services ["pg=running","web=running","worker=running"]; web deployments 1; migrations applied 1
ok   rows on 0.1.1: project upgrade, web (whoami with env) on 192.168.64.5:33045, Postgres 17 with a row, worker with a cron job saved as 0 4 * * 7
updates.status on 0.1.1: {"panel":{"currentVersion":"0.1.1","latestVersion":"0.2.0","updateAvailable":true,"changelogUrl":"http://192.168.64.1:18555/changelog-0.2.0"},"checkError":null}
ok   the 0.1.1 panel sees 0.2.0 as its update
ok   the panel on C runs 0.2.0
ok   C's agent runs 0.2.0
update run: {"targetVersion":"0.2.0","status":"succeeded","error":null,"steps":["panel:succeeded","agent:succeeded"]}
ok   the update run succeeded
ok   every migration of this build applied: 4 recorded (now 4)
ok   0001's tables exist (["cleanup_runs","git_providers","host_shell_sessions"])
ok   0002's update step columns exist (["retry","retry_at","retry_run_id"])
ok   the projects are the same (["Panel","upgrade"])
ok   the API key made on 0.1.1 still works
ok   the upgraded panel runs as the panel user, its folder and master.key moved to it (61000:61000 61000:61000:700 61000:61000:600)
ok   web still answers on 192.168.64.5:33045 with its env
ok   the Postgres row from 0.1.1 is there
cron job after the upgrade: {"schedule":"0 4 * * 0","nextRunAt":"2026-11-15T04:00:00.000Z"}
ok   the cron job saved with 7 now reads 0 4 * * 0 and has a next run
ok   the node schedules the job now and runs it ({"result":"succeeded","output":"cron-ran-42"})
ok   a redeploy of web after the upgrade goes live
ok   web answers after the redeploy
ok   the upgraded node runs scheduled cleanup (cleanup.getSchedule supported)
ok   the upgraded node runs host shells (hostShell.status available)
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --version '0.2.1' --pin 'sha256:ecd6b1d49a6eba0abb220271d74998f455984307485038dbd3ae49caf303c1b5'
ok   installer join on seylo-e2e-c finished: ==> Docker;Docker 29.9.3 is running;==> Joining https://192.168.64.3:3443;The agent is starting and joins the panel; the node shows up there in a few seconds.;
C joined A's panel again as 0o88degr7p6xskcr
```
