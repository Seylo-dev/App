// Package jobrun is the Docker access of the jobs packages (cron, backup,
// dbtools, box, tunnel, cleanup): one-off containers that run to
// completion with streamed stdin/stdout/stderr (cron runs, database dumps
// and restores), long-running helper containers (database web UIs, Boxes,
// cloudflared) and the inventory cleanup needs.
//
// Every container it creates follows the on-node contract in
// internal/docker: seylo.managed=true plus identifying labels,
// traefik.enable=false, cgroup parent seylo.slice and Docker restart
// policy "no". Labels must come from Labels so none is ever missed.
//
// Interfaces used by other packages: none outside the jobs packages, which
// declare the narrow interface they need (for example cron.ContainerRunner)
// so they can be tested with fakes; *Docker satisfies all of them.
package jobrun
