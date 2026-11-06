# E2E results

Written by `test/e2e-colima/checks.sh` from `~/.cache/seylo-e2e/state/results` (rerun one check with
`test/e2e-colima/checks.sh <N>`). VMs: seylo-e2e-a (panel + node, Colima), seylo-e2e-b (Colima), seylo-e2e-c (plain
Lima Ubuntu 24.04, Docker installed by install.sh). Release server and git server on the Mac.

| # | Check | Status | When |
|---|---|---|---|
| 1 | install.sh panel + node on A (signed manifest, image by digest); setup link; panel adopted as protected service | PASS | 50s, 2026-11-06 05:29, panel 0.1.0 |
| 2 | Owner through the setup link; API key; REST op routes | PASS | 0s, 2026-11-06 05:29, panel 0.1.0 |
| 3 | Join B and C (C gets Docker from install.sh); 3 nodes online; health checks | PASS | 23s, 2026-11-06 05:29, panel 0.1.0 |
| 4 | Image service on B with an auto domain; first-run IP:port -> 308 -> closed | PASS | 50s, 2026-11-06 05:30, panel 0.1.0 |
| 5 | Railpack git build on A, run on B through the 127.0.0.1:5755 relay | PASS | 10s, 2026-11-06 06:27, panel 0.1.1 |
| 6 | Dockerfile from git, inline Dockerfile and uploaded archive deploy | PASS | 20s, 2026-11-06 06:27, panel 0.1.1 |
| 7 | Zero downtime redeploy; failing health check keeps old; rollback | PASS | 122s, 2026-11-06 06:30, panel 0.1.1 |
| 8 | Crash policy: 5s restart, stop after N, crash report + one alert per streak | PASS | 112s, 2026-11-06 05:35, panel 0.1.0 |
| 9 | Env references across services; env.analyze flags cross-node address | PASS | 7s, 2026-11-06 05:35, panel 0.1.0 |
| 10 | Postgres: internal URL, project isolation, TLS exposure, web UI, DB shell | PASS | 62s, 2026-11-06 05:36, panel 0.1.0 |
| 11 | Backup Postgres and a volume to MinIO, restore both | PASS | 27s, 2026-11-06 05:37, panel 0.1.0 |
| 12 | Cron: schedule, run-now, history, keeps running while the panel is down | PASS | 242s, 2026-11-06 05:41, panel 0.1.0 |
| 13 | Logs search/follow across deploys; console stdin; shell PTY; files | PASS | 13s, 2026-11-06 06:30, panel 0.1.1 |
| 14 | Metrics: node and service series have samples | PASS | 0s, 2026-11-06 05:41, panel 0.1.0 |
| 15 | Move a service with a volume B -> C; data intact; domain follows | PASS | 22s, 2026-11-06 05:41, panel 0.1.0 |
| 16 | Replicas on B and C, entry on B; failover when one container dies | PASS | 34s, 2026-11-06 05:42, panel 0.1.0 |
| 17 | Compose stack from pasted YAML (two services, shared volume) | PASS | 20s, 2026-11-06 05:42, panel 0.1.0 |
| 18 | A template from the catalog creates and runs | PASS | 9s, 2026-11-06 05:42, panel 0.1.0 |
| 19 | Global and per-service maintenance pages; timed expose locked to an IP | PASS | 320s, 2026-11-06 05:48, panel 0.1.0 |
| 20 | Panel down: apps, routes, crash restarts, cron keep working; outbox delivers | PASS | 257s, 2026-11-06 05:52, panel 0.1.0 |
| 21 | Agent restart adopts running services without restarting them | PASS | 46s, 2026-11-06 05:53, panel 0.1.0 |
| 22 | Self-update N -> N+1 (panel first, then nodes); broken N+2 panel rolls back | PASS | 38s, 2026-11-06 05:53, panel 0.1.1 |
| 23 | Cleanup preview + run removes only seylo-labeled garbage | PASS | 17s, 2026-11-06 05:53, panel 0.1.1 |
| 24 | Laptop CLI: login, deploy, env set/list, logs -f | PASS | 49s, 2026-11-06 05:54, panel 0.1.1 |
| 25 | MCP: read-only token lists tools and runs a query; destructive call -> approval | PASS | 0s, 2026-11-06 05:54, panel 0.1.1 |
| 26 | seylo troubleshoot --dry-run redacts; seylo status shows the connection | PASS | 1s, 2026-11-06 06:27, panel 0.1.1 |
| 27 | Uninstall on C leaves nothing behind | PASS | 28s, 2026-11-06 05:55, panel 0.1.1 |
| 28 | C (systemd cgroup driver) runs containers under seylo.slice | PASS | 0s, 2026-11-06 05:55, panel 0.1.1 |
| 29 | (stretch) ACME certificate from a local Pebble CA | PASS | 10s, 2026-11-06 05:55, panel 0.1.1 |
| 30 | Web smoke with Playwright against the e2e panel | PASS | 2s, 2026-11-06 05:55, panel 0.1.1 |
| 31 | Panel domain: Pebble HTTPS, Secure cookie, HSTS, IP:port -> domain, nodes move to it, CLI | PASS | 412s, 2026-11-06 06:02, panel 0.1.1 |

31 passed, 0 failed, 0 blocked/skipped/not run.

## Evidence

### 1. install.sh panel + node on A (signed manifest, image by digest); setup link; panel adopted as protected service: PASS

```
ok   install.sh printed the setup link http://192.168.5.4:3000/setup?t=<redacted>
note: the link host is not A's vzNAT address 192.168.64.3 (the VM has two interfaces)
ok   panel answers on http://192.168.64.3:3000/api/health
ok   seylo.service is active on A
ok   A's agent joined its own panel: Panel: http://127.0.0.1:3000 (connected, version 0.1.0)
ok   install.sh checked the signed release manifest
ok   the panel runs the release's image pinned by digest (127.0.0.1:15000/seylo:0.1.0@sha256:57d0c0c4ef4a5080e0bc119bdd313e9c7505be745fb011ca348f5d2b44829621)
panel container 216622a91e8c: {"seylo.generation":"1","seylo.kind":"app","seylo.managed":"true","seylo.project":"panelproject0000","seylo.protected":"true","seylo.replica":"0","seylo.service":"panel00000000000"}
ok   panel container is in project panelproject0000
ok   panel container is protected
ok   no roll after the join: same container 216622a91e8c (now 216622a91e8c)
seylo panel status: Panel running (running), version 0.1.0, http://127.0.0.1:3000 
ok   the agent manages the panel service
ok   panel container survives an agent restart (same id, StartedAt 2026-11-06T03:28:19.552193433Z)
ok   panel still answers after the agent restart
```

### 2. Owner through the setup link; API key; REST op routes: PASS

```
setup.status: {"ownerExists":false,"link":{"valid":true,"expiresAt":"2026-11-06T04:28:19.765Z"}}
ok   the setup link is valid
ok   owner owner@e2e.test created through setup.createOwner (session cookie)
ok   API key created with the owner session (prefix seylo_key_X6...)
ok   auth.whoami with the API key: {"email":"owner@e2e.test","kind":null}
ok   Panel project: {"id":"panelproject0000","name":"Panel","protected":true,"serviceCount":1}
ok   Panel project is protected
ok   panel service: {"id":"panel00000000000","name":"panel","status":"running","protected":true,"placements":["colima-seylo-e2e-a"]}
```

### 3. Join B and C (C gets Docker from install.sh); 3 nodes online; health checks: PASS

```
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --pin 'sha256:ab238044dae0b70fa591941608008191e632ff436150de6022a8f922cf5565ee'
ok   the join command uses the agents' TLS port with --pin (insecureTransport false)
ok   the join command needs no --insecure
ok   installer join on seylo-e2e-b finished: ==> Docker;Docker 29.5.2 is running;Turning on Docker live-restore: containers keep running while Docker restarts;==> Joining https://192.168.64.3:3443;The agent is starting and joins the panel; the node shows up there in a few seconds.;
ok   C had no Docker before its first join
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --pin 'sha256:ab238044dae0b70fa591941608008191e632ff436150de6022a8f922cf5565ee'
ok   the join command uses the agents' TLS port with --pin (insecureTransport false)
ok   the join command needs no --insecure
ok   installer join on seylo-e2e-c finished: ==> Docker;Installing Docker with get.docker.com;Using systemd to manage Docker service;INFO: Docker daemon enabled and started;Client: Docker Engine - Community;Server: Docker Engine - Community;To run Docker as a non-privileged user, consider setting up the;Docker daemon in rootless mode for your 
ok   3 nodes online
node a: {"id":"i2dl2avkl2vbwh4p","name":"colima-seylo-e2e-a","status":"online","publicIpv4":null,"agentVersion":"0.1.0","canBuild":true,"facts":{"hostname":"colima-seylo-e2e-a","os":"ubuntu 24.04","arch":"arm64","cpuCores":4,"dockerVersion":"29.5.2","cgroupVersion":2}}
ok   node a has facts
health a: {"pass":17,"warn":0,"fail":0,"skipped":0} not passing: []
ok   health check on a has no fail
node b: {"id":"rah38c6q7fmmhbst","name":"e2e-b","status":"online","publicIpv4":null,"agentVersion":"0.1.0","canBuild":false,"facts":{"hostname":"colima-seylo-e2e-b","os":"ubuntu 24.04","arch":"arm64","cpuCores":2,"dockerVersion":"29.5.2","cgroupVersion":2}}
ok   node b has facts
health b: {"pass":16,"warn":1,"fail":0,"skipped":0} not passing: ["network.publicAddress=warn: No public address is known, so IP:port links, exposed databases and load balancing use the"]
ok   health check on b has no fail
node c: {"id":"e9vnzjv4ewfpxzqh","name":"e2e-c","status":"online","publicIpv4":null,"agentVersion":"0.1.0","canBuild":false,"facts":{"hostname":"lima-seylo-e2e-c","os":"ubuntu 24.04","arch":"arm64","cpuCores":2,"dockerVersion":"29.9.3","cgroupVersion":2}}
ok   node c has facts
health c: {"pass":15,"warn":2,"fail":0,"skipped":0} not passing: ["proxy.running=warn: the proxy container does not exist yet","network.publicAddress=warn: No public address is known, so IP:port links, exposed databases and load balancing use the"]
ok   health check on c has no fail
b config.yml: panel_url: https://192.168.64.3:3443 panel_pin: sha256:ab238044dae0b70fa591941608008191e632ff436150de6022a8f922cf5565ee 
ok   b joined over https:// with the panel's key pinned (panel_pin, no insecure_transport)
c config.yml: panel_url: https://192.168.64.3:3443 panel_pin: sha256:ab238044dae0b70fa591941608008191e632ff436150de6022a8f922cf5565ee 
ok   c joined over https:// with the panel's key pinned (panel_pin, no insecure_transport)
plain join refused: time="2026-11-06T05:29:31+02:00" level=fatal msg="exit status 1"
ok   the agent refuses a plain-HTTP join to another server without --insecure (and writes nothing)
C Docker after install.sh: 29.9.3 cgroup driver systemd v2 
```

### 4. Image service on B with an auto domain; first-run IP:port -> 308 -> closed: PASS

```
ok   B's wildcard domain: 192-168-64-4.sslip.io (sslip.io resolves it to B's address)
ok   whoami deployed on B (deployment live)
ok   first-run IP:port 192.168.64.4:39369 answers 200 before any domain
auto domain whoami.192-168-64-4.sslip.io (https acme)
ok   http://whoami.192-168-64-4.sslip.io answers through B's Traefik: Hostname: whoami
ok   first-run 192.168.64.4:39369 now redirects: 308 -> http://whoami.192-168-64-4.sslip.io/
firstRun after the domain went live: {"domainLiveAt":"2026-11-06T03:29:38.479Z","closeWhenDomainLive":true,"redirectToPrimary":true,"status":"redirecting","address":"192.168.64.4:39369","redirectTo":"http://whoami.192-168-64-4.sslip.io","closeAt":"2026-11-07T03:29:38.479Z","firewallHint":null}
the redirect closes by itself at 2026-11-07T03:29:38.479Z (too far to wait); moving that time 1 minute into the past in the panel database
ok   first-run 192.168.64.4:39369 closed by itself once closeAt passed (connection refused; exposures.get: {"status":"closed","address":null})
```

### 5. Railpack git build on A, run on B through the 127.0.0.1:5755 relay: PASS

```
deployment: {"status":"live","builder":"railpack","builtOn":"colima-seylo-e2e-a","shippedTo":["e2e-b"],"image":"127.0.0.1:5755/jkr6x5ecpgi786mi:1","digest":"sha256:0d1d76a33a43afd26f72109b0791ee21ca1d00c9ca9da0966929ced84e9b7ed1","steps":["clone=ok","build=ok","ship=ok","health=ok","switch=ok"],"error":null}
ok   Railpack build from https://192.168.64.1:18556/git/node-app.git is live
ok   built on A (can-build): builtOn=colima-seylo-e2e-a
ok   shipped to B
deploy log says: Building on colima-seylo-e2e-a.|#0 building with "seylo-builder-risem1nieqwxbh3l-2c-3g" instance using docker-container driver|#3 load build definition from railpack-plan.json|
container on B runs image 127.0.0.1:5755/jkr6x5ecpgi786mi@sha256:0d1d76a33a43afd26f72109b0791ee21ca1d00c9ca9da0966929ced84e9b7ed1
ok   B pulled it through the 127.0.0.1:5755 relay by digest
ok   the app answers on its first-run address 192.168.64.4:36281
```

### 6. Dockerfile from git, inline Dockerfile and uploaded archive deploy: PASS

```
ok   Dockerfile build from git (go-app) is live
ok   go-app answers: go-app dockerfile on go-app
ok   inline Dockerfile service is live
ok   inline-app answers inline-ok
POST /api/uploads/services/<id> -> 200 {"uploadId":"e9bqkh78kkj2tvq8","sizeBytes":638,"deployment":{"id":"vqsnrxosp050pu18","serviceId":"4aj4q3gyo1cndiik","generation":1,"status":"queued","live":false,"trigger":"api","actor":"owner@e2e.tes
ok   uploaded archive service is live
ok   upload-app answers upload-app ok
```

### 7. Zero downtime redeploy; failing health check keeps old; rollback: PASS

```
redeploy v1 -> v2 ended live; 589 requests during it, 0 not 200 ( 589 200 )
ok   zero downtime: no failed request during the redeploy
ok   v2 serves after the redeploy (Name: v2)
deploy with a failing health check ended failed: {"error":"e2e-b: not healthy after 30s: health check never passed: http check GET /: status 200\nlast output:\n2026/11/06 04:29:22 Starting up on port 80 The previous version stayed live.","steps":["clone=skipped","build=skipped","ship=ok","health=failed","switch=skipped"]}
ok   the failing deploy is marked failed
ok   the old version keeps serving (Name: v2)
node-app redeploy of the new commit ended live: {"app":"node-app","version":"v2","host":"node-app","greeting":null,"upstream":null}
ok   node-app v2 is live
rollback to j1s5fu087whrvqp9 ended live ({"trigger":"rollback","rollbackOf":"j1s5fu087whrvqp9","image":"127.0.0.1:5755/jkr6x5ecpgi786mi:1"}): {"app":"node-app","version":"v1","host":"node-app","greeting":null,"upstream":null}
ok   rollback serves v1 again
```

### 8. Crash policy: 5s restart, stop after N, crash report + one alert per streak: PASS

```
restart on: 3 crashes in 45s; die -> next start gaps: 6 6 5 s
ok   the service is restarted after each crash
ok   the wait before a restart is the fixed 5s (gaps 6 6 5 )
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
ok   an app in ANOTHER project cannot reach it (PG-FAILED-11 PG-FAILED-12)
exposed: {"host":"192.168.64.4","port":25432,"user":"external","tlsParams":"sslmode=require"}
ok   psql from the Mac over TLS (sslmode=require): tls=true TLSv1.3
ok   the exposed user cannot log in without TLS
web UI ticket URL: https://seylo-db-i543c0w92b2ocfqw.192-168-64-4.sslip.io/_seylo/ticket?t=<redacted>
ok   the web UI ticket opens pgweb through B's edge (seylo-db-i543c0w92b2ocfqw.192-168-64-4.sslip.io, 200)
ok   the DB shell ran a query without a password (select 40+2 -> 42)
```

### 11. Backup Postgres and a volume to MinIO, restore both: PASS

```
ok   MinIO destination http://192.168.64.3:19000/e2e-backups
database backup run: {"kind":"backup","status":"succeeded","objectKey":"e2e/i543c0w92b2ocfqw/ob2dw1kq53ujgiva/20261106T033638Z-c8hpseo30th8xlj0.sql.gz","sizeBytes":1638,"error":null}
ok   the Postgres backup succeeded
ok   the backup object is in MinIO
restore run: {"kind":"restore","status":"succeeded","objectKey":"e2e/i543c0w92b2ocfqw/ob2dw1kq53ujgiva/20261106T033638Z-c8hpseo30th8xlj0.sql.gz","sizeBytes":1638,"error":null}
ok   the restored database has the marker row
volume backup run: {"kind":"backup","status":"succeeded","objectKey":"e2e/2by1uv4up90epsxq/cl3jwhgcqh65iiap/20261106T033651Z-5qkee611nshdqf4r.tar.gz","sizeBytes":262,"error":null}
volume restore run: {"kind":"restore","status":"succeeded","objectKey":"e2e/2by1uv4up90epsxq/cl3jwhgcqh65iiap/20261106T033651Z-5qkee611nshdqf4r.tar.gz","sizeBytes":262,"error":null}
ok   the restored volume has marker.txt
```

### 12. Cron: schedule, run-now, history, keeps running while the panel is down: PASS

```
ok   run-now result in the history ([{"result":"succeeded","exitCode":0}])
ok   a scheduled run in the history ([{"result":"succeeded","startedAt":"2026-11-06T03:38:00.006Z"}])
panel paused at 2026-11-06T03:38:01Z
panel back at 2026-11-06T03:40:31Z
runs that started while the panel was down: 2 ([{"startedAt":"2026-11-06T03:40:00.003Z","result":"succeeded"},{"startedAt":"2026-11-06T03:39:00.000Z","result":"succeeded"}])
ok   cron kept running while the panel was down (2 or more runs in 150s)
```

### 13. Logs search/follow across deploys; console stdin; shell PTY; files: PASS

```
logs.search 'listening': 4 lines across generations [1,2,3]
ok   search finds lines from two or more deploys
ok   logs.follow streamed lines (tail, then the restart's 'listening on')
ok   Console echoed stdin (echo:hello-e2e); ready: {"type":"ready","containerId":"971a870a82edbcf38c025663d1f04153126838cc35d74831f57496fd286dc9fc","generation":1,"user":"root","workdir":"/"}
ok   Shell PTY ran a command (shell-42; tty: )
ok   files.write created /e2e/hello.txt
ok   files.list shows it (["hello.txt:22","upload.bin:4096"])
ok   upload through the ticket
ok   download returns the uploaded bytes
ok   files.read returns the edit (edited by the e2e)
ok   the container sees the edited file
```

### 14. Metrics: node and service series have samples: PASS

```
node a: {"points":12,"latest":{"cpuPercent":0.6012024048096198,"memoryUsedBytes":925069312}}
ok   node a has samples
node b: {"points":11,"latest":{"cpuPercent":2.1126760563380254,"memoryUsedBytes":623869952}}
ok   node b has samples
node c: {"points":11,"latest":{"cpuPercent":0.10015022533800266,"memoryUsedBytes":463290368}}
ok   node c has samples
service t72bcwycl8kf3pso: {"points":11,"current":[{"cpuPercent":0.011796678409662809,"memoryBytes":3014656}]}
ok   service t72bcwycl8kf3pso has samples
service 2nsi2a27zgsci5br: {"points":9,"current":[{"cpuPercent":0.007226975339708103,"memoryBytes":23896064}]}
ok   service 2nsi2a27zgsci5br has samples
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

### 16. Replicas on B and C, entry on B; failover when one container dies: PASS

```
30 requests to the entry node B answered from (traefik/replica):  15 4bc1eda6f6ad/172.19.0.4 15 a9aa9a03c641/172.19.0.14 
B's route for lb.e2e.test:  - url: http://seylo-vjzglodt1s0vu8uc-1:80 - url: https://192.168.64.5:5757 - url: http://172.18.0.1:5756 - url: http://seylo-vjzglodt1s0vu8uc-1:80 
ok   both replicas (B and C) answer through the entry node
killed the replica on C (e56e2897783f) during the load
195 requests during the failover, 0 not 200 ( 195 200 )
ok   requests keep succeeding when one replica dies
```

### 17. Compose stack from pasted YAML (two services, shared volume): PASS

```
stack 7iuqu5171l7kwhvs with members ["stack-reader","stack-writer"]
member m8lmozirvt6aduyh container f800e3aced84: read-1793936546 read-1793936550 
member 2s94o4q6e0yl8k63 container 73ad945805eb: wrote wrote 
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
timed expose: {"host":"192.168.64.4","port":null,"allowedCidrs":["192.168.64.1/32"],"expiresAt":"2026-11-06T03:47:41.396Z"}
ok   the Mac (192.168.64.1) reaches 192.168.64.4:36895
ok   VM A (192.168.64.3) is refused (got 000)
ok   global maintenance page on whoami.192-168-64-4.sslip.io (HTTP )
ok   per-service maintenance page on whoami.192-168-64-4.sslip.io
ok   another service (lb.e2e.test) is not in maintenance
waiting 306s for the expose to expire at 2026-11-06T03:47:41.396Z
ok   the timed expose closed by itself on time (got 000)
```

### 20. Panel down: apps, routes, crash restarts, cron keep working; outbox delivers: PASS

```
panel paused at 2026-11-06T03:48:21Z
ok   the app and its route kept serving while the panel was down (30 ok, 0 failed)
ok   crash restarts kept working while the panel was down (11 crashes, 11 restarts)
panel back at 2026-11-06T03:50:53Z
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
updates.status after publishing 0.1.1: {"panel":{"currentVersion":"0.1.0","latestVersion":"0.1.1","updateAvailable":true,"changelogUrl":"http://192.168.64.1:18555/changelog-0.1.1"},"checkError":null,"nodes":["colima-seylo-e2e-a=0.1.0","e2e-b=0.1.0","e2e-c=0.1.0"]}
ok   the panel sees 0.1.1 on the local release server (signed with the test key)
auto-update had not started within 20s; started the run with updates.updatePanel
ok   the panel runs 0.1.1 (system.version)
ok   every node runs 0.1.1: ["colima-seylo-e2e-a=0.1.1","e2e-b=0.1.1","e2e-c=0.1.1"]
update run: {"targetVersion":"0.1.1","trigger":"manual","status":"succeeded","error":null,"steps":["0:panel:panel:succeeded","1:agent:colima-seylo-e2e-a:succeeded","2:agent:e2e-b:succeeded","3:agent:e2e-c:succeeded"]}
ok   the panel step comes first, then the nodes one by one
ok   the update run succeeded
panel container image now: 127.0.0.1:15000/seylo@sha256:4d1d0b040c3cc32a68594a0792347918a1452d8a89c1fc9ed2aa093d688d414f
broken update run: {"targetVersion":"0.1.2","status":"failed","error":"the new panel did not become healthy: the panel is SERVICE_PHASE_FAILED: deploy failed: seylo-panel00000000000-3 exited right after starting","steps":["panel:rolledBack:the new panel did not become healthy: the panel is SERVICE_PHASE_FAILED: deploy "]}
ok   the 0.1.2 run is marked failed or rolled back
ok   the panel still runs 0.1.1 after the rollback (now 0.1.1)
ok   the restored database is intact (the API key works, projects are there)
ok   the old image runs again (127.0.0.1:15000/seylo@sha256:4d1d0b040c3cc32a68594a0792347918a1452d8a89c1fc9ed2aa093d688d414f)
```

### 23. Cleanup preview + run removes only seylo-labeled garbage: PASS

```
made an unlabeled stopped container, volume and image, plus a labelled image, volume and data folder of a removed service
preview: {"bytes":3070,"count":3,"items":["image e2e-seylo-garbage-img:1 (5108638cfb83) (3.0 KiB): service removed from this node","volume e2e-seylo-garbage-vol: service removed from this node","data deadbeefdeadbeef (8 B): service removed from this node"]}
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
initialize: {"protocolVersion":"2025-06-18","serverInfo":{"name":"seylo","title":"Seylo","version":"0.1.1"}}
read-only token sees 82 tools, destructive ones: []
ok   the read-only token lists tools
ok   the read-only token sees no destructive tool
ok   a query tool (nodes_list) runs and returns the nodes
destructive call (services_delete) answered: This action needs a person's approval before it runs. Approval 79c5pixqsft8mceh is waiting in the panel's Approvals page (it expires at 2026-11-07T03:54:48.805Z). Call approvals_get with {"approvalId":"79c5pixqsft8mceh"}
ok   the destructive call created a pending approval ([{"id":"79c5pixqsft8mceh","status":"pending"}])
ok   the service still exists while the approval waits
```

### 26. seylo troubleshoot --dry-run redacts; seylo status shows the connection: PASS

```
troubleshoot --dry-run on B: 310 lines, 1 redaction markers
ok   the report is redacted (markers present)
ok   no join token, API key or private key in the report
seylo status on B: Node: e2e-b (rah38c6q7fmmhbst) Agent: 0.1.1 (commit e2e, built unknown) Panel: https://192.168.64.3:3443 (connected, version 0.1.1) Desired: revision 84, applied 81 PROJECT SERVICE PHASE 
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
join command from the panel: curl -fsSL https://install.seylo.dev | sudo sh -s -- join --panel 'https://192.168.64.3:3443' --token <redacted> --pin 'sha256:ab238044dae0b70fa591941608008191e632ff436150de6022a8f922cf5565ee'
ok   installer join on seylo-e2e-c finished: ==> Docker;Docker 29.9.3 is running;==> Joining https://192.168.64.3:3443;The agent is starting and joins the panel; the node shows up there in a few seconds.;
C joined again as nkn0j9yx1ugmgmw9
```

### 28. C (systemd cgroup driver) runs containers under seylo.slice: PASS

```
C Docker cgroup driver: systemd
ok   C uses the systemd cgroup driver
container d45fe4f759b1: CgroupParent=seylo.slice, /proc cgroup=0::/seylo.slice/docker-d45fe4f759b1f576383ce643749d30a063419bc88e920a4f990363a9834831ef.scope
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
 1 passed (2.2s)
ok   Playwright: dashboard shows the nodes, services and every tab load, console echoes, no page errors
```

### 31. Panel domain: Pebble HTTPS, Secure cookie, HSTS, IP:port -> domain, nodes move to it, CLI: PASS

```
ok   A, B and C trust Pebble's root (/CN=Pebble Root CA 48aee1); on the Mac only this check's curl and CLI calls do
B's and C's agents restarted to read the new trust store
A's agent restarted with Pebble (https://192.168.64.3:14000/dir) as its ACME CA
ok   panel domain panel055534.192-168-64-3.sslip.io set (sslip.io answers 192.168.64.3, A's address)
ok   https://panel055534.192-168-64-3.sslip.io answers with a certificate Pebble's root verifies: issuer= /CN=Pebble Intermediate CA 4eb6d8 notAfter=Nov 12 03:55:41 2026 GMT 
ok   http://panel055534.192-168-64-3.sslip.io goes to HTTPS (301 https://panel055534.192-168-64-3.sslip.io/)
the panel's domain check after 1s: {"state":"active","message":""}
ok   the panel's own probe found panel055534.192-168-64-3.sslip.io active (it trusts the test CA in a test build)
ok   settings.general reports the domain active
ok   HTTPS answers carry HSTS (strict-transport-security: max-age=31536000)
ok   plain HTTP on IP:port carries no HSTS
auth.login over https://panel055534.192-168-64-3.sslip.io: HTTP/2 200 ; set-cookie: seylo_session=<redacted>; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=Lax
ok   the session cookie set over HTTPS is Secure
ok   the session cookie is HttpOnly
ok   the HTTPS session works (auth.whoami)
ok   a page load on IP:port answers 302 to the domain (302 https://panel055534.192-168-64-3.sslip.io/settings/general?e2e=31)
ok   the panel's pages answer on the domain
ok   the API on IP:port is not redirected (scripts, CLI and agents keep working)
ok   pages on A's loopback are not redirected (the way back in over SSH)
ok   seylo login https://panel055534.192-168-64-3.sslip.io (macOS CLI, API key): Signed in to https://panel055534.192-168-64-3.sslip.io as owner@e2e.test (profile "default").
ok   seylo env set e2e/whoami over the domain: Saved. The new values apply on the next deploy.
ok   seylo env list over the domain shows E2E_DOMAIN_CLI
ok   the panel asked B and C to reconnect and both moved without a restart
ok   b moved to the domain: panel_url: https://panel055534.192-168-64-3.sslip.io 
ok   c moved to the domain: panel_url: https://panel055534.192-168-64-3.sslip.io 
ok   A (the panel's node) keeps dialing loopback
ok   b has no panel_pin (the domain's certificate is checked with system roots)
ok   b dropped insecure_transport
ok   b keeps the old address as a fallback for one cycle (fallback: panel_url: https://192.168.64.3:3443 panel_pin: sha256:...cf5565ee )
b agent log: time=2026-11-06T05:55:44.813+02:00 level=INFO msg="moved to the panel's new address; the old one stays as a fallback until a reconnect there works" panel_url=https://panel055534.192-168-64-3.sslip.io fallback=https://192.168.64.3:3443
ok   b is connected through the domain: Panel: https://panel055534.192-168-64-3.sslip.io (connected, version 0.1.1)
ok   b's agent talks to A:443, not to the agents' TLS port 3443 (ports on A it holds: 443 )
ok   c has no panel_pin (the domain's certificate is checked with system roots)
ok   c dropped insecure_transport
ok   c keeps the old address as a fallback for one cycle (fallback: panel_url: https://192.168.64.3:3443 panel_pin: sha256:...cf5565ee )
c agent log: time=2026-11-06T03:55:44.568Z level=INFO msg="moved to the panel's new address; the old one stays as a fallback until a reconnect there works" panel_url=https://panel055534.192-168-64-3.sslip.io fallback=https://192.168.64.3:3443
ok   c is connected through the domain: Panel: https://panel055534.192-168-64-3.sslip.io (connected, version 0.1.1)
ok   c's agent talks to A:443, not to the agents' TLS port 3443 (ports on A it holds: 443 )
ok   3 nodes online after the move
ok   b reconnects through the domain after an agent restart: Panel: https://panel055534.192-168-64-3.sslip.io (connected, version 0.1.1)
ok   b still dials the domain
ok   b keeps its pinned old address as a standing fallback ("the panel's new address works after a reconnect; keeping the previous pinned one for when it stops answering" panel_url=https://panel055534.192-168-64-3.sslip.)
ok   b holds no connection to the agents' TLS port (ports on A: 443 )
ok   c reconnects through the domain after an agent restart: Panel: https://panel055534.192-168-64-3.sslip.io (connected, version 0.1.1)
ok   c still dials the domain
ok   c keeps its pinned old address as a standing fallback ("the panel's new address works after a reconnect; keeping the previous pinned one for when it stops answering" panel_url=https://panel055534.192-168-64-3.sslip.)
ok   c holds no connection to the agents' TLS port (ports on A: 443 )
ok   3 nodes online after restarting B's and C's agents
ok   panel domain removed (settings.updateGeneral {domain: null})
ok   IP:port pages are served again
ok   B and C came back to https://192.168.64.3:3443 by themselves 383s after the restart: b panel_pin: sha256:ab238044dae0b70fa591941608008191e632ff436150de6022a8f922cf5565ee panel_url: https://192.168.64.3:3443 , c panel_pin: sha256:ab238044dae0b70fa591941608008191e632ff436150de6022a8f922cf5565ee panel_url: https://192.168.64.3:3443 
cleanup: A's agent restarted without the Pebble ACME settings
ok   cleanup: b is back on the agents' TLS port with the pin, no fallback, connected (Panel: https://192.168.64.3:3443 (connected, version 0.1.1))
ok   cleanup: c is back on the agents' TLS port with the pin, no fallback, connected (Panel: https://192.168.64.3:3443 (connected, version 0.1.1))
ok   cleanup: 3 nodes online
```
