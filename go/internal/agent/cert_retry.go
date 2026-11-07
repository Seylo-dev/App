package agent

// RetryCertificate (network area): Traefik asks the CA again for a route
// whose certificate is missing or failed, without a restart. The router
// does the work (proxy.FileRouter.RetryCertificate); here the errors become
// statuses the panel shows, and the service's status is published right
// away so the panel sees the route turn pending.

import (
	"context"
	"errors"
	"log/slog"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// certRetrier is the part of the router RetryCertificate needs
// (proxy.FileRouter).
type certRetrier interface {
	RetryCertificate(ctx context.Context, serviceID, routeID string) (*agentv1.RouteStatus, []string, error)
}

// statusRefresher republishes a service's status (reconcile.Runtime).
type statusRefresher interface {
	Refresh(serviceID string)
}

// registerCertRetry registers RetryCertificate when the router supports it.
func registerCertRetry(reg *Registry, d *Deps, log *slog.Logger) {
	router, ok := d.Router.(certRetrier)
	if !ok {
		return
	}
	rpc.HandleUnary(reg, "RetryCertificate", func(ctx context.Context, req *agentv1.RetryCertificateRequest) (*agentv1.RetryCertificateResponse, error) {
		if req.GetServiceId() == "" || req.GetRouteId() == "" {
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_INVALID_ARGUMENT, "service_id and route_id are required")
		}
		st, hosts, err := router.RetryCertificate(ctx, req.GetServiceId(), req.GetRouteId())
		switch {
		case errors.Is(err, proxy.ErrUnknownRoute):
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_NOT_FOUND, "This node does not route that domain yet. Wait for the deploy to finish and try again.")
		case errors.Is(err, proxy.ErrNotACME):
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, "This domain does not use a Let's Encrypt certificate on this node.")
		case errors.Is(err, proxy.ErrHasCertificate):
			return nil, rpc.NewError(agentv1.StatusCode_STATUS_CODE_FAILED_PRECONDITION, "This domain already has a certificate on this node. It is renewed on its own before it expires.")
		case err != nil:
			return nil, err
		}
		actor := ""
		if info, ok := rpc.CallInfoFrom(ctx); ok {
			actor = info.Metadata["actor"]
		}
		log.Info("asking the certificate authority again", "service_id", req.GetServiceId(), "route_id", req.GetRouteId(), "hosts", hosts, "actor", actor)
		if r, ok := d.Reconcile.(statusRefresher); ok {
			r.Refresh(req.GetServiceId())
		}
		return &agentv1.RetryCertificateResponse{Status: st, Hosts: hosts}, nil
	})
}
