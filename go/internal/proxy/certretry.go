package proxy

// Certificate retries: making Traefik run ACME again for one route's hosts
// without restarting it. Traefik's ACME provider asks the CA for the hosts
// of every router that have no certificate each time its dynamic
// configuration changes, and skips a configuration equal to the last one.
// So a retry gives the route's routers a new name (a generation in
// BuildInput.CertRetries), writes the file atomically and forgets the
// hosts' last failure. Every other router keeps its name, so the rest of
// the node serves on as before. Later renders keep the name, so a
// redeploy does not make Traefik try again by itself for nothing (every
// failed attempt counts against the CA's limits: Let's Encrypt allows 5
// failed validations per host name per hour). The generations live in
// memory: an agent restart rewrites every route file anyway (a new probe
// secret), and Traefik tries again then.

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

var (
	// ErrUnknownRoute means the service or route has no route file here.
	ErrUnknownRoute = errors.New("the route is not on this node")
	// ErrNotACME means the route does not get its certificate over ACME.
	ErrNotACME = errors.New("the route does not use Let's Encrypt certificates")
	// ErrHasCertificate means every host of the route has a certificate:
	// Traefik renews those on its own.
	ErrHasCertificate = errors.New("every host of the route already has a certificate")
)

// RetryCertificate makes Traefik ask the CA again for the hosts of an ACME
// route that have no certificate. It returns the route's state right
// after (pending) and those hosts.
func (r *FileRouter) RetryCertificate(ctx context.Context, serviceID, routeID string) (*agentv1.RouteStatus, []string, error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	a, ok := r.services[serviceID]
	if !ok || a.built.Data == nil {
		return nil, nil, fmt.Errorf("%w: service %s", ErrUnknownRoute, serviceID)
	}
	var route *agentv1.Route
	for _, rt := range a.spec.GetRouting().GetRoutes() {
		if rt.GetId() == routeID {
			route = rt
			break
		}
	}
	if route == nil {
		return nil, nil, fmt.Errorf("%w: route %s of service %s", ErrUnknownRoute, routeID, serviceID)
	}
	if !usesACME(route) {
		return nil, nil, ErrNotACME
	}
	var hosts []string
	for _, h := range route.GetHosts() {
		h = strings.ToLower(strings.TrimSuffix(h, "."))
		if !r.acme.has(h) {
			hosts = append(hosts, h)
		}
	}
	if len(hosts) == 0 {
		return nil, nil, ErrHasCertificate
	}

	routes := r.retries[serviceID]
	if routes == nil {
		routes = map[string]uint64{}
		r.retries[serviceID] = routes
	}
	prev := routes[routeID]
	routes[routeID] = prev + 1
	next, err := r.render(a.spec, a.upstreams)
	if err == nil {
		err = r.writeBoth(serviceID, next)
	}
	if err != nil {
		if prev == 0 {
			delete(routes, routeID)
		} else {
			routes[routeID] = prev
		}
		return nil, nil, err
	}
	r.services[serviceID] = next
	r.cfg.CertFailures.Retried(hosts, time.Now())
	st := &agentv1.RouteStatus{RouteId: routeID, State: agentv1.RouteState_ROUTE_STATE_ACTIVE}
	r.acmeStatus(st, route.GetHosts())
	return st, hosts, nil
}

func usesACME(route *agentv1.Route) bool {
	switch route.GetHttps() {
	case agentv1.HttpsMode_HTTPS_MODE_ACME, agentv1.HttpsMode_HTTPS_MODE_UNSPECIFIED:
		return true
	}
	return false
}

// retryNames returns the router name suffix of every retried route of a
// service ("c<generation>"), for BuildInput. Callers hold r.mu.
func (r *FileRouter) retryNames(serviceID string) map[string]string {
	routes := r.retries[serviceID]
	if len(routes) == 0 {
		return nil
	}
	out := make(map[string]string, len(routes))
	for id, gen := range routes {
		out[id] = "c" + strconv.FormatUint(gen, 10)
	}
	return out
}

// pruneRetriesLocked forgets the retries of routes a service no longer has
// as ACME routes (spec nil: the service is gone). Callers hold r.mu.
func (r *FileRouter) pruneRetriesLocked(serviceID string, spec *agentv1.ServiceSpec) {
	routes := r.retries[serviceID]
	if len(routes) == 0 {
		return
	}
	keep := map[string]bool{}
	for _, rt := range spec.GetRouting().GetRoutes() {
		if usesACME(rt) {
			keep[rt.GetId()] = true
		}
	}
	for id := range routes {
		if !keep[id] {
			delete(routes, id)
		}
	}
	if len(routes) == 0 {
		delete(r.retries, serviceID)
	}
}
