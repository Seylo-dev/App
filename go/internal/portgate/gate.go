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
