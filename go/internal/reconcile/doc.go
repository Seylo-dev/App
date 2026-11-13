// Package reconcile drives a node toward its desired state. It owns the
// service containers: one worker goroutine per service creates, adopts,
// rolls, restarts and removes them, writes the service's route file
// (proxy.Router) and Cloudflare tunnel (tunnel.Cloudflare), and reports
// ServiceStatus to the state store. It keeps working from the last stored
// desired state while the panel is unreachable.
//
// A deploy of generation N: pull, start seylo-<svc>-<N> (all replicas),
// wait for the health check, switch the route file, verify through Traefik
// (Router.Verify), then stop the old generation. If N never becomes
// healthy within DeployStrategy.health_timeout (or a new container exits
// first) it is removed, the old generation keeps serving and a FAILED
// DeployProgress goes out durably: the reason in message, the new
// container's last output lines in last_output (since 0.2.16; in the
// message before), and, when the default check was refused all along, the
// ports it listens on instead (not_listening, read from its
// /proc/<pid>/net/tcp before it is removed). The same
// failed generation is not retried until the panel sends another. A
// rollback is an apply with an older image digest. DEPLOY_MODE_RECREATE
// stops the old generation first and starts it again on failure.
//
// SpecHash decides whether a change needs new containers: route, health,
// crash policy, replica or cron changes keep the running containers (a new
// generation is then reported as succeeded at once). Containers carry the
// hash in the seylo.spec-hash label, so an agent restart adopts them by
// labels without touching them. Crashes go through crash.Tracker (Docker
// restart policy is off); a stop decided by the policy is remembered in
// services/<id>/runtime.json so it survives agent restarts.
//
// Networks: service containers join only seylo-p-<project>; Traefik is
// connected to the project networks of routed services (ProxyContainers),
// so projects cannot reach each other. Volumes are bind-backed named
// volumes under services/<owner>/volumes/<name>.
//
// Moving to another project (reattach.go): a spec whose only change is
// project_id moves the running containers instead of rolling new ones:
// they join the new seylo-p-<project> with the same aliases, are health
// checked on the new address, the route switches to it and is verified,
// and after a short drain (Options.ReattachDrain) they leave the old
// network. runtime.json records the container's new project and spec
// hash, since its labels keep the old ones. A failed health check leaves
// them on the old network and reports the generation FAILED. Networks our
// containers still use are never removed or left by the proxy.
//
// Interfaces used by other packages:
//
//   - Engine (Runtime): SyncDesired, ApplyService, RemoveService and
//     RestartService handlers; SetSleeping for idle Boxes; Resolve for
//     portgate, tunnels and the Tunnel RPC.
//   - ProxyContainers: optionally implemented by the proxy.Router.
//
// It depends on docker.Engine, health.Prober, crash.Tracker,
// state.DesiredStore/Store/Reporter, proxy.Router, tunnel.Cloudflare and a
// LogSource (logs.Store); the last three may be nil.
package reconcile
