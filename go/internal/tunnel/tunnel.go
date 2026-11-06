package tunnel

import (
	"context"
	"io"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Relay connects a tunnel request to its target and copies bytes both
// ways until either side closes.
type Relay interface {
	Serve(ctx context.Context, req *agentv1.TunnelRequest, stream io.ReadWriter) error
}

// Cloudflare manages per-service cloudflared tunnels.
type Cloudflare interface {
	// Sync starts, reconfigures or stops the service's tunnel and returns
	// the public URL of a temporary tunnel (empty for permanent ones or
	// when disabled). target is "ip:port" of a running instance, or empty
	// when none runs right now.
	Sync(ctx context.Context, serviceID string, target string, spec *agentv1.CloudflareTunnel) (url string, err error)
	// URL is the current public URL of a temporary tunnel. It changes when
	// cloudflared restarts, so read it when building ServiceStatus instead
	// of keeping the one Sync returned.
	URL(serviceID string) string
}
