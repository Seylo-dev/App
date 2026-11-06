package proxy

import (
	"context"
	"errors"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Upstream is one backend a route sends traffic to.
type Upstream struct {
	// URL such as "http://seylo-abc-7:3000": a local replica by its
	// container name on the edge network (Traefik resolves it through
	// Docker's DNS). Copies on other nodes come from the spec's
	// LoadBalancer.remote_upstreams, not from here.
	URL string
}

// Router owns the route files.
type Router interface {
	// Apply writes the routes of a service pointing at upstreams,
	// replacing the previous file atomically (temp file + rename). Empty
	// upstreams route to the status page. It returns once the file is
	// written; Verify waits for Traefik to serve it.
	Apply(ctx context.Context, service *agentv1.ServiceSpec, upstreams []Upstream) error
	// Verify waits until Traefik serves the file the last Apply wrote and
	// reaches its first-choice target (a local upstream, or the edge for
	// pages), probing through Traefik itself. It returns ErrNotVerified
	// (wrapped) when that does not happen before ctx ends (or 15s without
	// a deadline), and nil when the service has no routes. Reconcile calls
	// it after the switch and before stopping the old generation.
	Verify(ctx context.Context, serviceID string) error
	// Remove deletes the service's route file.
	Remove(ctx context.Context, serviceID string) error
	// Status reports per-route state (certificates, DNS) for ServiceStatus.
	Status(ctx context.Context, serviceID string) ([]*agentv1.RouteStatus, error)
}

// Certificates gives the TLS certificate Traefik obtained for a host (the
// exposed database's tls_hostname, see DatabaseExposure).
type Certificates interface {
	// Certificate returns the PEM certificate chain and key, or
	// ErrNoCertificate while Traefik has none for host.
	Certificate(host string) (certPEM, keyPEM []byte, err error)
}

var (
	// ErrNotVerified means Traefik did not serve the new route file (or
	// could not reach its upstream) in time.
	ErrNotVerified = errors.New("route not verified through Traefik")
	// ErrNoProbe means the Traefik address is not known yet, so nothing
	// can be verified.
	ErrNoProbe = errors.New("traefik address unknown")
	// ErrNoCertificate means Traefik has not obtained a certificate for
	// the host (yet).
	ErrNoCertificate = errors.New("no certificate for host")
)
