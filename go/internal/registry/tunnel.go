package registry

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/build"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// Dialer opens the TCP connection behind a Tunnel target.
type Dialer interface {
	DialRegistry(ctx context.Context) (net.Conn, error)
	DialService(ctx context.Context, serviceID string, port uint32) (net.Conn, error)
}

// Tunnel serves AgentService.Tunnel: it connects to the requested target
// on this node and relays bytes both ways until the target closes.
type Tunnel struct {
	Dial   Dialer
	Logger *slog.Logger
}

// Serve is the raw bidi handler.
func (t *Tunnel) Serve(ctx context.Context, req *agentv1.TunnelRequest, s rpc.RawStream) (*agentv1.TunnelResponse, error) {
	var conn net.Conn
	var err error
	switch target := req.GetTarget().(type) {
	case *agentv1.TunnelRequest_Registry:
		if scope := target.Registry.GetScope(); scope != nil {
			// A node's connection the panel relays: HTTP-aware, checked
			// per request. Without a scope the panel itself is talking.
			if err := t.serveScoped(ctx, scope, s); err != nil {
				return nil, err
			}
			return &agentv1.TunnelResponse{}, nil
		}
		conn, err = t.Dial.DialRegistry(ctx)
	case *agentv1.TunnelRequest_ServicePort:
		sp := target.ServicePort
		if sp.GetPort() == 0 || sp.GetPort() > 65535 {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "the port must be between 1 and 65535")
		}
		conn, err = t.Dial.DialService(ctx, sp.GetServiceId(), sp.GetPort())
	default:
		return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "the tunnel has no target")
	}
	if err != nil {
		var rerr *rpc.Error
		if errors.As(err, &rerr) || ctx.Err() != nil {
			return nil, err
		}
		if t.Logger != nil {
			t.Logger.Warn("tunnel target unreachable", "err", err)
		}
		return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "the tunnel target is not reachable")
	}
	if err := pipeServer(ctx, s, conn); err != nil {
		return nil, err
	}
	return &agentv1.TunnelResponse{}, nil
}

// NodeDialer reaches targets on this node: the registry through Server,
// service ports on the newest running container of the service (by its
// address on its project network, which the agent reaches from the host).
type NodeDialer struct {
	Registry *Server
	Runner   build.Runner
}

// DialRegistry implements Dialer.
func (n *NodeDialer) DialRegistry(ctx context.Context) (net.Conn, error) {
	return n.Registry.Dial(ctx)
}

// DialService implements Dialer.
func (n *NodeDialer) DialService(ctx context.Context, serviceID string, port uint32) (net.Conn, error) {
	ip, err := n.serviceIP(ctx, serviceID)
	if err != nil {
		return nil, err
	}
	var d net.Dialer
	return d.DialContext(ctx, "tcp", net.JoinHostPort(ip, strconv.FormatUint(uint64(port), 10)))
}

func (n *NodeDialer) docker(ctx context.Context, args ...string) (string, error) {
	r := n.Runner
	if r == nil {
		r = build.ExecRunner{}
	}
	var out strings.Builder
	if err := r.Run(ctx, build.Cmd{Name: "docker", Args: args, Stdout: &out}); err != nil {
		return "", err
	}
	return strings.TrimSpace(out.String()), nil
}

func (n *NodeDialer) serviceIP(ctx context.Context, serviceID string) (string, error) {
	out, err := n.docker(ctx, "ps", "--no-trunc",
		"--filter", "label="+docker.LabelManaged+"=true",
		"--filter", "label="+docker.LabelService+"="+serviceID,
		"--format", `{{.ID}}	{{.Label "`+docker.LabelGeneration+`"}}`)
	if err != nil {
		return "", fmt.Errorf("listing the service's containers: %w", err)
	}
	id := newestContainer(out)
	if id == "" {
		return "", rpc.NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "the service has no running container on this node")
	}
	ips, err := n.docker(ctx, "container", "inspect", "--format", `{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}`, id)
	if err != nil {
		return "", fmt.Errorf("reading the container's address: %w", err)
	}
	for _, ip := range strings.Fields(ips) {
		return ip, nil
	}
	return "", rpc.NewError(agentv1.StatusCode_STATUS_CODE_UNAVAILABLE, "the service's container has no network address")
}

// newestContainer picks the container with the highest generation from
// `docker ps` lines of "<id>\t<generation>".
func newestContainer(out string) string {
	best, bestGen := "", int64(-1)
	for _, line := range strings.Split(out, "\n") {
		id, gen, ok := strings.Cut(strings.TrimSpace(line), "\t")
		if !ok || id == "" {
			continue
		}
		g, err := strconv.ParseInt(gen, 10, 64)
		if err != nil {
			g = 0
		}
		if g > bestGen {
			best, bestGen = id, g
		}
	}
	return best
}
