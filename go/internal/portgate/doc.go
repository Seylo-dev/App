// Package portgate owns direct IP:port access. Instead of Docker published
// ports (which bypass UFW and similar firewalls), the agent listens itself
// and relays TCP to the container: first-run access before a domain
// exists, timed exposes locked to source addresses, and database exposure,
// TLS only with the database's own user (the gate terminates TLS for
// Mongo, ClickHouse and the Redis-like engines; Postgres, MySQL and
// MariaDB speak their own TLS through the relay, and the gate refuses
// their clients that do not ask for it, RequireTLS). Once a domain is
// live a public port becomes an HTTP redirector (308) to it, handing
// cookies over through the edge, until its close_at. Expiries run on local
// timers, so they hold while the panel is unreachable, and a listener past
// its expiry is never reopened after an agent restart.
//
// Anyone on the internet may reach a first-run port, so every listener
// caps its connections (Config.MaxConns, MaxConnsPerSource), cuts
// connections idle both ways (IdleTimeout; longer for databases), and
// shares one Resolve (Docker lookups) per container port for ResolveTTL
// instead of resolving per connection.
//
// Deploys move a service to new containers under its open connections. A
// new connection waits for the service (ConnectTimeout) instead of being
// closed at the first miss: a failed lookup or an address that refuses is
// tried again after a short pause (lookups stay shared, once per moment),
// and an address from an earlier lookup gets a second before it is looked
// up again, since a removed container's address may not answer at all.
// Reconcile calls Switched when a deploy moves the route (and when the old
// generation is gone), which drops the service's lookups, failed ones too.
//
// Interfaces used by other packages:
//
//   - Gate: the agent syncs it from the desired state (SyncAll), and
//     ServiceStatus.open_ports comes from Ports.
//   - Manager.Switched: reconcile finds it on its Gate with a type
//     assertion.
package portgate
