// Package nodecheck runs the node "Health check" (the heart icon in the
// panel, formerly called Doctor). Default(env) returns the checks, each
// with a stable id, an ok/warn/fail result and a fix hint:
//
//	system.kernel     Linux 5.6+ (openat2 for volume files), amd64 or arm64
//	system.os         tested distribution and release
//	system.memory     total and available memory
//	disk.space        free space on the data dir's file system
//	disk.inodes       free inodes there
//	disk.permissions  services/ and services/<id>/ open to root only (0700)
//	docker.engine     Docker reachable, version, storage driver
//	docker.cgroup     cgroup v2, cpu/memory/pids controllers, Docker's driver
//	network.ports     80 and 443 free or held by our Traefik or the Wings fork's proxy
//	proxy.running     the seylo-traefik container runs (or Wings' is shared)
//	proxy.routes      every seylo-*.yml route file parses
//	network.dns       public registries and the panel host resolve
//	network.firewall  ufw or firewalld allow 80 and 443
//	time.sync         NTP state and skew against the panel's clock
//	panel.reachable   GET <panel>/api/health and its latency
//	wings.detected    Wings next to us and whether its Traefik can be shared
//
// Named nodecheck (not doctor or health) because package health is the
// per-service health probe. Everything machine-specific comes in through
// Env, so tests run the checks against a fake /proc, /sys and /etc.
//
// Interfaces used by other packages:
//
//   - Check, Run, Default, Env: the RunHealthCheck RPC handler and
//     `seylo troubleshoot` call Run(ctx, Default(env)).
//   - DockerAPI / DockerSocket: a read-only Engine client (GET /info and
//     /containers/json) that troubleshoot reuses.
package nodecheck
