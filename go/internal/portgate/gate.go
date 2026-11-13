package portgate

import (
	"context"
	"net/http"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Mode is what a listener does with a connection.
type Mode int

const (
	// ModeForward relays TCP to the container.
	ModeForward Mode = iota
	// ModeRedirect answers HTTP with a 308 to RedirectURL + the path.
	ModeRedirect
)

// Listener is one wanted IP:port listener.
type Listener struct {
	// ID is stable across syncs and unique within the service:
	// "public-<container port>", "expose-<TimedExpose id>" or "database".
	ID        string
	ServiceID string
	// HostPort 0 lets the gate pick a free port (kept across restarts).
	HostPort      uint32
	ContainerPort uint32
	Mode          Mode
	// RedirectURL for ModeRedirect, for example "https://app.example.com".
	RedirectURL string
	// AllowedSourceCIDRs empty means anyone, unless RequireAllowList.
	AllowedSourceCIDRs []string
	// RequireAllowList refuses to open without a source list (timed
	// exposes must be locked to the requester).
	RequireAllowList bool
	// ExpiresAt zero means no expiry. At that time the listener and its
	// connections close, even while the panel is unreachable.
	ExpiresAt time.Time
	// Timed marks a timed expose (reported with its expiry).
	Timed bool
	// ExposeID is a timed expose's TimedExpose.id, reported in
	// OpenPort.timed_expose_id.
	ExposeID string
	// IdleTimeout cuts a relayed connection idle that long; zero is
	// DefaultIdleTimeout (Config.IdleTimeout overrides both). A
	// database's listeners, exposed and timed alike, use
	// DatabaseIdleTimeout: connection pools keep idle connections open.
	IdleTimeout time.Duration
	// TerminateTLS makes the gate speak TLS to clients and relay plain TCP
	// to the container (exposed Mongo and Redis, which use TLS from the
	// first byte). TLSHost names the certificate (Config.Certificate).
	TerminateTLS bool
	TLSHost      string
	// AgentCertificate: the port serves the agent's certificate for
	// TLSHost (Config.Certificate), terminated here or installed in the
	// database by dbtools.ExposedTLS (exposed Postgres and MySQL), so
	// Ports reports it. MariaDB serves its own.
	AgentCertificate bool
	// RequireTLS checks the first bytes of each connection to a database
	// that negotiates TLS inside its protocol (exposed Postgres, MySQL and
	// MariaDB) and refuses a client that does not ask for TLS, with the
	// protocol's own error. What it read goes to the container unchanged.
	RequireTLS TLSCheck
	// AllowPlain (DatabaseExposure.allow_plain) relays database clients
	// that do not ask for TLS too: RequireTLS passes them on instead of
	// refusing them, and a TerminateTLS port tells a ClientHello from a
	// plain client by its first bytes (clientHello) and relays the plain
	// one as it is. TLS clients connect as before. It changes in place on
	// a sync, without closing the socket or any TLS session; turned off,
	// the plain sessions still open are closed.
	AllowPlain bool
}

// Resolver returns the address ("10.0.3.4:5432") to relay a connection for
// a service's container port to. It runs per connection, so container
// restarts and new generations are followed without a resync.
type Resolver func(ctx context.Context, serviceID string, containerPort uint32) (string, error)

// Handoff returns the Location for a redirect: redirectURL plus the path,
// or a cookie handoff link when the request carries cookies. Nil sends a
// plain redirect.
type Handoff func(r *http.Request, redirectURL string) string

// Gate opens and closes listeners to match what is wanted.
type Gate interface {
	// Sync makes the open listeners equal to wanted for one service and
	// returns the host ports actually bound, by listener id.
	Sync(ctx context.Context, serviceID string, wanted []Listener) (map[string]uint32, error)
	// SyncAll does Sync for every service of a desired state (listeners
	// from ListenersFor) and closes those of services not in it.
	SyncAll(ctx context.Context, desired *agentv1.DesiredState) error
	// CloseService closes every listener of a service.
	CloseService(serviceID string) error
	// Ports reports a service's open ports for ServiceStatus.open_ports.
	Ports(serviceID string) []*agentv1.OpenPort
}
