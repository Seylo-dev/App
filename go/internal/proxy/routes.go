package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// ErrInvalidRoute means the spec holds something that cannot go into a
// Traefik rule safely (bad id, host, path or upstream URL).
var ErrInvalidRoute = errors.New("invalid route")

// Priorities of the agent's own routers, above anything a rule length
// gives (Traefik's default priority is the rule's length).
const (
	priorityProbe   = 2_000_000_000
	priorityHandoff = 1_999_999_000
	// priorityOrigin puts the origin routers above every router of the
	// same hosts, owned ones included. Traefik's own ACME challenge router
	// (/.well-known/acme-challenge/ on web, priority MaxInt32 or more) never
	// matches the same path, so it keeps answering Let's Encrypt.
	priorityOrigin = 1_999_998_000
	// priorityAcmeChallenge puts the challenge routers on websecure
	// (addAcmeChallenge) above every router of the same hosts, owned ones
	// included. They never match the origin path, so below those is fine.
	priorityAcmeChallenge = 1_999_997_000
	// priorityOwned (plus the rule's length) lifts the routers of hosts
	// nobody else may serve: the panel's own routes, tool hosts and a
	// database's certificate host. A longer rule for the same host in
	// another service's file (Host(x) && PathPrefix(/api)) can then never
	// take part of them.
	priorityOwned = 1_000_000_000
)

// BuildInput is everything one route file is made from.
type BuildInput struct {
	Service *agentv1.ServiceSpec
	// Upstreams are this node's healthy replicas of the serving generation.
	// Empty means "nothing to route to": the routes serve the status page.
	Upstreams []Upstream
	// Settings carries the global maintenance page.
	Settings *agentv1.NodeSettings
	// Edge is the base URL of the agent's edge listener as Traefik reaches
	// it, for example "http://172.30.0.1:5756". Empty while unknown: pages
	// and tools are left out until the router re-renders.
	Edge string
	// ProbeSecret enables the rollout probe router (see Verify).
	ProbeSecret string
	// ProbeSource limits the probe router to this client IP when set.
	ProbeSource string
	// LBEntryPoint adds routers on EntryPointLB for traffic from other
	// nodes (own Traefik only).
	LBEntryPoint bool
	// LBOnly keeps only the routers on EntryPointLB (with the services and
	// middlewares they use) and no probe router: the file of the separate
	// LB Traefik next to the Wings fork, whose own Traefik has no LB entry
	// point. Implies LBEntryPoint.
	LBOnly bool
	// CertRetries renames the routers of ACME routes whose certificate was
	// retried: route id -> name suffix ("c2"). A new name is a changed
	// configuration, which makes Traefik run ACME again for the route's
	// hosts without a certificate (see certretry.go).
	CertRetries map[string]string
}

// Built is one rendered route file.
type Built struct {
	// Data is nil when the service needs no file.
	Data []byte
	// Version identifies the routing content (without the probe router);
	// the probe path carries it, so Verify knows which file Traefik serves.
	Version string
	// HasLocal is true when the probe goes to a local upstream rather than
	// the edge.
	HasLocal bool
}

// Build renders the route file of one service. It is pure, so golden
// tests cover every feature without Traefik.
func Build(in BuildInput) (Built, error) {
	spec := in.Service
	if spec == nil {
		return Built{}, fmt.Errorf("%w: no service", ErrInvalidRoute)
	}
	if in.LBOnly {
		in.LBEntryPoint, in.ProbeSecret = true, ""
	}
	if err := checkID("service", spec.GetId()); err != nil {
		return Built{}, err
	}
	for _, u := range in.Upstreams {
		if err := checkUpstream(u.URL); err != nil {
			return Built{}, err
		}
	}
	for _, r := range spec.GetLoadBalancer().GetRemoteUpstreams() {
		if err := checkUpstream(r.GetUrl()); err != nil {
			return Built{}, err
		}
	}

	b := &builder{in: in, n: newNamer(spec.GetId()), cfg: &dynamicConfig{HTTP: &httpConfig{
		Routers:     map[string]*router{},
		Middlewares: map[string]*middleware{},
		Services:    map[string]*service{},
	}}}
	b.remotes = b.remoteCopies()

	if err := b.build(); err != nil {
		return Built{}, err
	}
	if in.LBOnly {
		b.keepLBRouters()
	}
	if len(b.cfg.HTTP.Routers) == 0 {
		return Built{}, nil
	}
	b.raiseOwned()
	b.trim()

	header := fmt.Sprintf("# Written by the %s agent for service %s. Rewritten on every change; do not edit.\n", brand.DisplayName, spec.GetId())
	plain, err := render(b.cfg, header)
	if err != nil {
		return Built{}, err
	}
	sum := sha256.Sum256(plain)
	version := hex.EncodeToString(sum[:])[:16]
	if in.ProbeSecret != "" {
		b.addProbe(version)
	}
	data, err := render(b.cfg, header)
	if err != nil {
		return Built{}, err
	}
	return Built{Data: data, Version: version, HasLocal: len(in.Upstreams) > 0}, nil
}

type builder struct {
	in  BuildInput
	n   namer
	cfg *dynamicConfig
	// remotes are the copies on other nodes this node balances to.
	remotes []remoteCopy
}

// remoteCopy is a copy of the service on another node. Each has a Traefik
// service and serversTransport of its own (both named name), because the
// transport carries the name the peer is verified by and Traefik sets it
// per service, not per server.
type remoteCopy struct {
	url       string
	name      string
	transport *serversTransport
}

// remoteCopies returns the copies on other nodes, in the panel's order,
// leaving out nodes the LB TLS settings list no certificate for
// (lbTransport). Plain http:// URLs get no transport.
func (b *builder) remoteCopies() []remoteCopy {
	lb := lbTLSOf(b.in.Settings)
	var out []remoteCopy
	used := map[string]bool{}
	for _, r := range b.spec().GetLoadBalancer().GetRemoteUpstreams() {
		transport, ok := lbTransport(lb, r.GetNodeId())
		if !ok {
			continue
		}
		if !strings.HasPrefix(r.GetUrl(), "https://") {
			transport = nil
		}
		name := b.n.svc("node-" + nodeKey(r.GetNodeId()))
		for i := 2; used[name]; i++ {
			name = b.n.svc(fmt.Sprintf("node-%s-%d", nodeKey(r.GetNodeId()), i))
		}
		used[name] = true
		out = append(out, remoteCopy{url: r.GetUrl(), name: name, transport: transport})
	}
	return out
}

// raiseOwned gives the routers of owned hosts priorityOwned plus their
// usual priority (the probe and handoff routers stay above).
func (b *builder) raiseOwned() {
	spec := b.spec()
	panel := docker.IsPanelService(spec.GetId(), spec.GetProtected())
	tool := b.n.route(toolRouteID, "")
	for name, rt := range b.cfg.HTTP.Routers {
		if rt.Priority >= priorityOwned {
			continue
		}
		if !panel && name != tool && !strings.HasPrefix(name, tool+"-") && name != b.n.svc("dbcert") {
			continue
		}
		p := rt.Priority
		if p == 0 {
			p = len(rt.Rule)
		}
		rt.Priority = priorityOwned + p
	}
}

// toolRouteID is the route id of a Box's or database UI's tool host.
const toolRouteID = "edge-tool"

// Hosts returns the hosts a service's route file serves, lower case:
// all of them (routes, tool host under settings' wildcard domain,
// database certificate host) and the exclusive ones no other service may
// serve at all (the panel's own routes, tool hosts, certificate hosts).
// Other route hosts may be shared: another service can add paths under a
// host when the panel allowed it.
func Hosts(spec *agentv1.ServiceSpec, settings *agentv1.NodeSettings) (all, exclusive []string) {
	b := &builder{in: BuildInput{Service: spec, Settings: settings}, n: newNamer(spec.GetId())}
	panel := docker.IsPanelService(spec.GetId(), spec.GetProtected())
	for _, r := range spec.GetRouting().GetRoutes() {
		for _, h := range r.GetHosts() {
			all = append(all, strings.ToLower(h))
			if panel {
				exclusive = append(exclusive, strings.ToLower(h))
			}
		}
	}
	if b.toolSubject() != "" {
		if h := b.toolHost(); h != "" {
			all, exclusive = append(all, h), append(exclusive, h)
		}
	}
	if exp := spec.GetDatabase().GetExposure(); exp.GetEnabled() && exp.GetTlsHostname() != "" {
		h := strings.ToLower(exp.GetTlsHostname())
		all, exclusive = append(all, h), append(exclusive, h)
	}
	slices.Sort(all)
	slices.Sort(exclusive)
	return slices.Compact(all), slices.Compact(exclusive)
}

func (b *builder) spec() *agentv1.ServiceSpec { return b.in.Service }

func (b *builder) mw(name string, m *middleware) string {
	if b.cfg.HTTP.Middlewares == nil {
		b.cfg.HTTP.Middlewares = map[string]*middleware{}
	}
	b.cfg.HTTP.Middlewares[name] = m
	return name
}

// mode is what the routes of the service lead to.
type mode int

const (
	modeUpstream mode = iota
	modeStatus
	modeMaintenance
	modeTool
)

func (b *builder) mode() mode {
	spec := b.spec()
	if b.toolSubject() != "" {
		return modeTool
	}
	global := b.in.Settings.GetMaintenance().GetEnabled() && !spec.GetProtected()
	if global || spec.GetRouting().GetMaintenance().GetEnabled() {
		return modeMaintenance
	}
	if len(b.in.Upstreams) == 0 && len(b.remotes) == 0 {
		return modeStatus
	}
	return modeUpstream
}

// toolSubject is the edge tool a service's routes open, or "".
func (b *builder) toolSubject() string {
	spec := b.spec()
	switch {
	case spec.GetKind() == agentv1.ServiceKind_SERVICE_KIND_BOX:
		return ToolSubject(ToolBox, spec.GetId())
	case spec.GetKind() == agentv1.ServiceKind_SERVICE_KIND_DATABASE && spec.GetDatabase().GetTools().GetWebUi():
		return ToolSubject(ToolDatabaseUI, spec.GetId())
	}
	return ""
}

func (b *builder) build() error {
	spec := b.spec()
	// Validate every route up front, even those not rendered right now.
	for _, r := range spec.GetRouting().GetRoutes() {
		if err := checkID("route", r.GetId()); err != nil {
			return err
		}
		if _, err := rule(r); err != nil {
			return err
		}
	}
	m := b.mode()
	if (m == modeTool || m == modeStatus || m == modeMaintenance) && b.in.Edge == "" {
		// Nothing to send these requests to yet; no routers rather than
		// routers to a missing service. The router re-renders once the
		// edge address is known.
		return b.buildDatabaseCert()
	}
	if b.in.Edge != "" {
		// The visitor's Host goes along: tools check it (WebSocket origin)
		// and cookie handoffs are bound to it.
		b.cfg.HTTP.Services[b.n.svc("edge")] = &service{LoadBalancer: &loadBalancer{Servers: []lbServer{{URL: b.in.Edge}}}}
	}
	if m == modeUpstream {
		b.addUpstreamServices()
	}

	handoff := b.in.Edge != "" && hasRedirectPort(spec)
	for _, r := range spec.GetRouting().GetRoutes() {
		if err := b.addRoute(r, m, handoff); err != nil {
			return err
		}
	}
	if m == modeTool {
		if host := b.toolHost(); host != "" {
			// The host the panel's tool links point at: <slug>-box-<id> or
			// <slug>-db-<id> under the node's wildcard domain.
			tool := &agentv1.Route{Id: toolRouteID, Hosts: []string{host}, Https: agentv1.HttpsMode_HTTPS_MODE_ACME, RedirectToHttps: true}
			if err := b.addRoute(tool, m, false); err != nil {
				return err
			}
		}
	}
	return b.buildDatabaseCert()
}

// toolHost is the tool's host under the node's wildcard domain, or "".
func (b *builder) toolHost() string {
	wildcard := strings.ToLower(strings.Trim(b.in.Settings.GetWildcardDomain(), "."))
	if wildcard == "" || checkHost(wildcard) != nil {
		return ""
	}
	kind, _, _ := strings.Cut(b.toolSubject(), ":")
	return ToolHost(kind, b.spec().GetId(), wildcard)
}

// ToolHost is where the panel's tool links point:
// "<slug>-box-<id>.<wildcard>" or "<slug>-db-<id>.<wildcard>".
func ToolHost(kind, serviceID, wildcard string) string {
	label := kind
	if kind == ToolDatabaseUI {
		label = "db"
	}
	return brand.Slug + "-" + label + "-" + serviceID + "." + wildcard
}

func (b *builder) addUpstreamServices() {
	spec := b.spec()
	local := make([]lbServer, 0, len(b.in.Upstreams))
	for _, u := range b.in.Upstreams {
		local = append(local, lbServer(u))
	}
	// The cookie of the main service picks a node's copy (or, without
	// copies elsewhere, a replica here); the local service's own picks a
	// replica here, so the two levels never overwrite each other, also on
	// the node that takes another node's forwarded traffic.
	var mainSticky, localSticky *sticky
	if spec.GetLoadBalancer().GetStickySessions() {
		// Browsers never send a Secure cookie over plain HTTP, so on a
		// domain without HTTPS such a cookie would pin nothing. It only
		// names a copy (a hash), so it may go without Secure there.
		secure := allHTTPS(spec.GetRouting().GetRoutes())
		cookie := func(name string) *sticky {
			return &sticky{Cookie: &stickyCookie{Name: name, Secure: secure, HTTPOnly: true, SameSite: "lax"}}
		}
		mainSticky, localSticky = cookie(brand.Slug+"_"+spec.GetId()), cookie(brand.Slug+"_"+spec.GetId()+"_r")
	}
	// Containers here get a short dial timeout: a copy that just died
	// answers 502 fast, so the failover (or the other node's) resends the
	// request to a live copy before the visitor gives up.
	localTransport := ""
	if len(local) > 0 || len(b.remotes) == 0 {
		localTransport = b.transport(b.n.svc("local"), &serversTransport{}, localDialTimeout)
	}
	if len(local) > 0 {
		b.cfg.HTTP.Services[b.n.svc("local")] = &service{LoadBalancer: &loadBalancer{Servers: local, Sticky: localSticky, ServersTransport: localTransport}}
	}
	if len(b.remotes) == 0 {
		b.cfg.HTTP.Services[b.n.svc("")] = &service{LoadBalancer: &loadBalancer{Servers: local, Sticky: mainSticky, ServersTransport: localTransport}}
		return
	}
	// Copies on other nodes answer on their LB entry point: each verified
	// by its own name against the panel's LB CA with this node's client
	// certificate (lbtls.go), or only encrypted without lb_tls. The weights
	// keep the old spread: one share per replica here, one per node.
	var children []weightedService
	if len(local) > 0 {
		children = append(children, weightedService{Name: b.n.svc("local"), Weight: len(local)})
	}
	for _, rc := range b.remotes {
		t := rc.transport
		if t == nil {
			t = &serversTransport{}
		}
		lb := &loadBalancer{Servers: []lbServer{{URL: rc.url}}, ServersTransport: b.transport(rc.name, t, nodeDialTimeout)}
		b.cfg.HTTP.Services[rc.name] = &service{LoadBalancer: lb}
		children = append(children, weightedService{Name: rc.name, Weight: 1})
	}
	b.cfg.HTTP.Services[b.n.svc("")] = &service{Weighted: &weighted{Services: children, Sticky: mainSticky}}
}

// Dial timeouts of the upstream transports. A container on this node
// connects in well under a millisecond; 2s still lets one lost SYN be
// resent (after 1s). Another node gets more room for its network.
const (
	localDialTimeout = "2s"
	nodeDialTimeout  = "3s"
)

// transport adds t under name with the given dial timeout and returns name.
func (b *builder) transport(name string, t *serversTransport, dial string) string {
	t.ForwardingTimeouts = &forwardingTimeouts{DialTimeout: dial}
	if b.cfg.HTTP.ServersTransports == nil {
		b.cfg.HTTP.ServersTransports = map[string]*serversTransport{}
	}
	b.cfg.HTTP.ServersTransports[name] = t
	return name
}

// allHTTPS reports whether every route serves HTTPS (unset means ACME).
func allHTTPS(routes []*agentv1.Route) bool {
	for _, r := range routes {
		if r.GetHttps() == agentv1.HttpsMode_HTTPS_MODE_OFF {
			return false
		}
	}
	return true
}

// upstreamService returns the Traefik service a route sends to: the main
// one, or a copy whose local servers use the route's own target port
// (upstreams carry the service's first route port). Copies on other nodes
// keep their URL: their LB entry point routes by host. local picks the
// local-only variant (LB routers).
func (b *builder) upstreamService(r *agentv1.Route, local bool) string {
	port := r.GetTargetPort()
	if port == 0 || b.localPortsAre(port) {
		if local {
			return b.n.svc("local")
		}
		return b.n.svc("")
	}
	if local {
		return b.localPortService(port)
	}
	name := b.n.svc(fmt.Sprintf("p%d", port))
	if _, ok := b.cfg.HTTP.Services[name]; ok {
		return name
	}
	main := b.cfg.HTTP.Services[b.n.svc("")]
	if main.Weighted != nil {
		w := *main.Weighted
		w.Services = slices.Clone(w.Services)
		for i := range w.Services {
			if w.Services[i].Name == b.n.svc("local") {
				w.Services[i].Name = b.localPortService(port)
			}
		}
		b.cfg.HTTP.Services[name] = &service{Weighted: &w}
		return name
	}
	lb := *main.LoadBalancer
	lb.Servers = withPorts(main.LoadBalancer.Servers, port)
	b.cfg.HTTP.Services[name] = &service{LoadBalancer: &lb}
	return name
}

// localPortService is the local service with every server on port.
func (b *builder) localPortService(port uint32) string {
	name := b.n.svc(fmt.Sprintf("local-p%d", port))
	if _, ok := b.cfg.HTTP.Services[name]; ok {
		return name
	}
	src := b.cfg.HTTP.Services[b.n.svc("local")].LoadBalancer
	lb := *src
	lb.Servers = withPorts(src.Servers, port)
	b.cfg.HTTP.Services[name] = &service{LoadBalancer: &lb}
	return name
}

func withPorts(servers []lbServer, port uint32) []lbServer {
	out := make([]lbServer, len(servers))
	for i, srv := range servers {
		out[i] = lbServer{URL: withPort(srv.URL, port)}
	}
	return out
}

// localPortsAre reports whether every local upstream URL uses port.
func (b *builder) localPortsAre(port uint32) bool {
	for _, u := range b.in.Upstreams {
		parsed, err := url.Parse(u.URL)
		if err != nil || parsed.Port() != strconv.FormatUint(uint64(port), 10) {
			return false
		}
	}
	return true
}

func withPort(raw string, port uint32) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	u.Host = net.JoinHostPort(u.Hostname(), strconv.FormatUint(uint64(port), 10))
	return u.String()
}

func hasRedirectPort(spec *agentv1.ServiceSpec) bool {
	for _, p := range spec.GetPorts() {
		if p.GetPublic().GetMode() == agentv1.PublicPortMode_PUBLIC_PORT_MODE_REDIRECT {
			return true
		}
	}
	return false
}

// rule is the Traefik rule for a route's hosts and path.
func rule(r *agentv1.Route) (string, error) {
	if len(r.GetHosts()) == 0 {
		return "", fmt.Errorf("%w: route %q has no host", ErrInvalidRoute, r.GetId())
	}
	hosts := make([]string, 0, len(r.GetHosts()))
	for _, h := range r.GetHosts() {
		h = strings.ToLower(strings.TrimSuffix(h, "."))
		if err := checkHost(h); err != nil {
			return "", err
		}
		hosts = append(hosts, fmt.Sprintf("Host(`%s`)", h))
	}
	out := strings.Join(hosts, " || ")
	if len(hosts) > 1 {
		out = "(" + out + ")"
	}
	if p := r.GetPathPrefix(); p != "" && p != "/" {
		if err := checkPath(p); err != nil {
			return "", err
		}
		out += fmt.Sprintf(" && PathPrefix(`%s`)", p)
	}
	return out, nil
}

func (b *builder) addRoute(r *agentv1.Route, m mode, handoff bool) error {
	if err := checkID("route", r.GetId()); err != nil {
		return err
	}
	ruleText, err := rule(r)
	if err != nil {
		return err
	}
	https := r.GetHttps()
	if https == agentv1.HttpsMode_HTTPS_MODE_UNSPECIFIED {
		https = agentv1.HttpsMode_HTTPS_MODE_ACME
	}
	var tls *routerTLS
	// The panel holds the certificate back until the host reaches this
	// node (Route.acme_hold): HTTPS with Traefik's default certificate and
	// no resolver, so the origin routers answer on 443 too, and plain HTTP
	// without the redirect.
	held := https == agentv1.HttpsMode_HTTPS_MODE_ACME && r.GetAcmeHold()
	switch https {
	case agentv1.HttpsMode_HTTPS_MODE_ACME:
		tls = &routerTLS{CertResolver: CertResolver}
		if held {
			tls = &routerTLS{}
		}
	case agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE:
		cert := r.GetCertificate()
		if cert.GetCertPem() == "" || cert.GetKeyPem() == "" {
			return fmt.Errorf("%w: route %q has no custom certificate", ErrInvalidRoute, r.GetId())
		}
		if b.cfg.TLS == nil {
			b.cfg.TLS = &tlsConfig{}
		}
		b.cfg.TLS.Certificates = append(b.cfg.TLS.Certificates, tlsCertificate{CertFile: cert.GetCertPem(), KeyFile: cert.GetKeyPem()})
		tls = &routerTLS{}
	}

	name := b.n.route(r.GetId(), "")
	if suffix := b.in.CertRetries[r.GetId()]; suffix != "" && https == agentv1.HttpsMode_HTTPS_MODE_ACME {
		name = b.n.route(r.GetId(), suffix)
	}
	target, chain, err := b.chain(r, m)
	if err != nil {
		return err
	}
	var retry *resendPlan
	if m == modeUpstream {
		retry = b.resendPlan(r, target)
	}

	if tls == nil {
		b.putRouter(name, &router{EntryPoints: []string{EntryPointWeb}, Rule: ruleText, Middlewares: chain, Service: target}, retry)
	} else {
		b.putRouter(name, &router{EntryPoints: []string{EntryPointSecure}, Rule: ruleText, Middlewares: chain, Service: target, TLS: tls}, retry)
		httpRouter := &router{EntryPoints: []string{EntryPointWeb}, Rule: ruleText, Middlewares: chain, Service: target}
		if r.GetRedirectToHttps() && !held {
			// Plain HTTP only redirects (after the route's own redirects);
			// the service is never reached.
			redirect := b.mw(b.n.svc("https"), &middleware{RedirectScheme: &redirectScheme{Scheme: "https", Permanent: true}})
			httpRouter.Middlewares = append(b.redirects(r), redirect)
			retry = nil
		}
		b.putRouter(name+"-http", httpRouter, retry)
	}

	if handoff {
		h := &router{
			EntryPoints: []string{EntryPointWeb},
			Rule:        fmt.Sprintf("%s && Path(`%s`)", hostsOnly(ruleText), HandoffPath),
			Priority:    priorityHandoff,
			Service:     b.n.svc("edge"),
		}
		if tls != nil {
			h.EntryPoints = []string{EntryPointSecure}
			h.TLS = tls
		}
		b.cfg.HTTP.Routers[b.n.route(r.GetId(), "handoff")] = h
	}
	if b.in.Edge != "" && r.GetId() != toolRouteID {
		b.addOrigin(r.GetId(), ruleText, tls)
	}
	if https == agentv1.HttpsMode_HTTPS_MODE_ACME {
		b.addAcmeChallenge(r.GetId(), ruleText)
	}

	if b.lbRouters() && len(r.GetAllowedSourceCidrs()) == 0 && (m != modeUpstream || len(b.in.Upstreams) == 0) && m != modeTool {
		// No copy here right now (stopped, between restarts, maintenance):
		// answer the forwarding node 503, so it retries on its own copies,
		// rather than 404 (no router) or a page.
		b.cfg.HTTP.Services[b.n.svc("none")] = &service{LoadBalancer: &loadBalancer{Servers: []lbServer{}}}
		b.cfg.HTTP.Routers[b.n.route(r.GetId(), "lb")] = &router{
			EntryPoints: []string{EntryPointLB},
			Rule:        ruleText,
			Service:     b.n.svc("none"),
			TLS:         &routerTLS{Options: LBTLSOptions},
		}
	}
	if b.lbRouters() && m == modeUpstream && len(b.in.Upstreams) > 0 && len(r.GetAllowedSourceCidrs()) == 0 {
		// Traffic another node forwards here goes to local replicas only.
		// The entry node already applied the rate limit and redirects, and
		// only sibling nodes (a client certificate the panel issued to a
		// current node, see lbtls.go) get here, so those middlewares are left out (here the
		// client is the other node, so they would throttle everyone as
		// one). Routes with an IP allowlist are left out too: the list
		// could not be checked against the other node.
		lbChain := []string{}
		for _, mwName := range chain {
			if strings.HasSuffix(mwName, "-auth") || strings.HasSuffix(mwName, "-strip") || strings.HasSuffix(mwName, "-unreachable") {
				lbChain = append(lbChain, mwName)
			}
		}
		b.cfg.HTTP.Routers[b.n.route(r.GetId(), "lb")] = &router{
			EntryPoints: []string{EntryPointLB},
			Rule:        ruleText,
			Middlewares: lbChain,
			Service:     b.upstreamService(r, true),
			TLS:         &routerTLS{Options: LBTLSOptions},
		}
	}
	return nil
}

// addOrigin sends OriginPath on a route's hosts to the edge, which answers
// the panel's challenge with a proof signed by the node's key
// (edge/origin.go): how the panel tells that a custom domain reaches this
// node, also behind Cloudflare's proxy. In every mode (the app running,
// stopped or in maintenance), on plain HTTP without the HTTPS redirect (the
// panel asks over http://, Cloudflare may forward either way) and on HTTPS
// with the route's certificate, above every other router of the hosts. A
// route with HTTPS off gets the HTTPS one too, with Traefik's default
// certificate: behind Cloudflare's proxy with Always Use HTTPS and SSL/TLS
// Full the check is redirected to https and reaches port 443 whatever the
// route serves, and Traefik's 404 there would read as another server
// answering. The route's middlewares stay off: an allowlist or a password
// would hide the node from the check, and the answer reveals nothing else.
// Next to the Wings fork the routers go to its Traefik like the rest of the
// file; the LB file (LBOnly) keeps none. Routes of the service on the same
// hosts (other paths) share the routers of the first.
func (b *builder) addOrigin(routeID, ruleText string, tls *routerTLS) {
	ruleText = fmt.Sprintf("%s && PathPrefix(`%s`)", hostsOnly(ruleText), OriginPath)
	edge := b.n.svc("edge")
	if b.findRouter(EntryPointWeb, priorityOrigin, ruleText) == nil {
		b.cfg.HTTP.Routers[b.n.route(routeID, "origin-http")] = &router{
			EntryPoints: []string{EntryPointWeb}, Rule: ruleText, Priority: priorityOrigin, Service: edge,
		}
	}
	t := routerTLS{}
	if tls != nil {
		t = *tls
	}
	if rt := b.findRouter(EntryPointSecure, priorityOrigin, ruleText); rt != nil {
		// The first route was plain HTTP: the certificate of one that is not wins.
		if *rt.TLS == (routerTLS{}) {
			rt.TLS = &t
		}
		return
	}
	b.cfg.HTTP.Routers[b.n.route(routeID, "origin")] = &router{
		EntryPoints: []string{EntryPointSecure}, Rule: ruleText, Priority: priorityOrigin, Service: edge, TLS: &t,
	}
}

// addAcmeChallenge answers Let's Encrypt's HTTP-01 challenge for an ACME
// route's hosts on websecure as well, with Traefik's own handler
// (AcmeChallengeService, the one its router on web uses). Let's Encrypt
// asks http://<host>/.well-known/acme-challenge/<token> and follows a
// redirect to https without checking the certificate there. Behind
// Cloudflare's proxy with Always Use HTTPS that is where it ends up:
// Cloudflare answers 301, and with SSL/TLS Full sends the https request to
// port 443, where without this router the app (or Traefik's 404) answered
// and the certificate was never issued. The router has the default
// certificate and no resolver (it asks the CA for nothing), no middlewares
// (an allowlist or a password would refuse the CA), and sits above every
// other router of the hosts. Held routes (Route.acme_hold) get it too, so
// the first order after the release finds it in place. The handler answers
// only the tokens of a challenge in progress (404 otherwise). Routes of the
// service on the same hosts share the router of the first; the LB file
// keeps none.
func (b *builder) addAcmeChallenge(routeID, ruleText string) {
	ruleText = fmt.Sprintf("%s && PathPrefix(`%s`)", hostsOnly(ruleText), AcmeChallengePath)
	if b.findRouter(EntryPointSecure, priorityAcmeChallenge, ruleText) != nil {
		return
	}
	b.cfg.HTTP.Routers[b.n.route(routeID, "acme-challenge")] = &router{
		EntryPoints: []string{EntryPointSecure}, Rule: ruleText, Priority: priorityAcmeChallenge,
		Service: AcmeChallengeService, TLS: &routerTLS{},
	}
}

// findRouter returns the file's router with this priority and rule on this
// entry point (the origin and challenge routers), or nil.
func (b *builder) findRouter(entryPoint string, priority int, ruleText string) *router {
	for _, rt := range b.cfg.HTTP.Routers {
		if rt.Priority == priority && rt.Rule == ruleText && slices.Equal(rt.EntryPoints, []string{entryPoint}) {
			return rt
		}
	}
	return nil
}

// lbRouters reports whether the route file gets routers on the LB entry
// point: only on a Traefik that has one, and only with the panel's LB
// mutual TLS (NodeSettings.lb_tls). The entry point is published on every
// interface (Docker ports bypass the firewall) and its routers skip the
// rate limit and redirects, so without lb_tls it routes nothing (Traefik
// answers 404) rather than taking any client (runtime-2).
func (b *builder) lbRouters() bool {
	return b.in.LBEntryPoint && lbTLSOf(b.in.Settings) != nil
}

// idempotentMethods matches the requests a failover may replay.
const idempotentMethods = "(Method(`GET`) || Method(`HEAD`) || Method(`OPTIONS`))"

// putRouter adds a router. With a resend plan (more than one copy), GET,
// HEAD and OPTIONS go to the plan's service under name+"-retry" and the
// other methods stay on the plain service, each half with its own retry
// middleware last in the chain: a request is sent to another copy after a
// 502-504 only when it is safe to send twice, and after a copy that could
// not be reached at all (nothing was sent) for every method. Both halves
// keep the priority Traefik would give the original rule (its length), so
// the order against other routes does not change.
func (b *builder) putRouter(name string, rt *router, plan *resendPlan) {
	if plan == nil {
		b.cfg.HTTP.Routers[name] = rt
		return
	}
	priority := len(rt.Rule)
	idem := *rt
	idem.Rule = "(" + rt.Rule + ") && " + idempotentMethods
	idem.Service = plan.idemService
	idem.Middlewares = append(slices.Clone(rt.Middlewares), plan.idemMW)
	idem.Priority = priority
	rt.Rule = "(" + rt.Rule + ") && !" + idempotentMethods
	rt.Middlewares = append(slices.Clone(rt.Middlewares), plan.otherMW)
	rt.Priority = priority
	b.cfg.HTTP.Routers[name] = rt
	b.cfg.HTTP.Routers[name+"-retry"] = &idem
}

// resendPlan is how a route's requests reach another copy when the one
// the balancer picked failed.
type resendPlan struct {
	// idemService serves GET, HEAD and OPTIONS.
	idemService string
	// idemMW and otherMW are the retry middlewares of the two halves.
	idemMW, otherMW string
}

// maxResendAttempts caps the tries of one request (the first included).
const maxResendAttempts = 4

// resendPlan returns, for a route to the service's copies when there is
// more than one (replicas here or copies on other nodes), how failed
// requests are sent again; nil otherwise. Each try goes through the
// balancer again and so to the next copy: a copy here that died fails to
// connect (sent again, any method), one on another node answers 502-504
// (sent again for GET, HEAD and OPTIONS). With sticky sessions the cookie
// would pick the same copy every time, so GET, HEAD and OPTIONS go to a
// failover service instead that resends to this node's own copies when
// the pool answered 502-504 (a copy on another node went away: that node
// answers 503, see the LB routers, or is unreachable).
func (b *builder) resendPlan(r *agentv1.Route, target string) *resendPlan {
	copies := len(b.in.Upstreams) + len(b.remotes)
	if b.in.LBOnly || copies < 2 || target != b.upstreamService(r, false) {
		return nil
	}
	attempts := min(copies+1, maxResendAttempts)
	plan := &resendPlan{idemService: target, otherMW: b.mw(b.n.svc("resend"), &middleware{Retry: &retryMW{Attempts: attempts}})}
	if !b.spec().GetLoadBalancer().GetStickySessions() || len(b.in.Upstreams) == 0 || len(b.remotes) == 0 {
		maxBody := int64(retryMaxBodyBytes)
		plan.idemMW = b.mw(b.n.svc("resend-idem"), &middleware{Retry: &retryMW{
			Attempts: attempts, Status: []string{"502-504"}, MaxRequestBodyBytes: &maxBody,
		}})
		return plan
	}
	name := target + "-retry"
	if _, ok := b.cfg.HTTP.Services[name]; !ok {
		errs := &failoverErrors{Status: []string{"502-504"}, MaxRequestBodyBytes: retryMaxBodyBytes}
		// This node's copies, then (when those fail too: the pinned copy
		// was the one here that died) the copies on other nodes.
		fallback := b.upstreamService(r, true)
		if others := b.othersService(target); others != "" {
			chain := target + "-fallback"
			b.cfg.HTTP.Services[chain] = &service{Failover: &failover{Service: fallback, Fallback: others, Errors: errs}}
			fallback = chain
		}
		b.cfg.HTTP.Services[name] = &service{Failover: &failover{Service: target, Fallback: fallback, Errors: errs}}
	}
	plan.idemService, plan.idemMW = name, plan.otherMW
	return plan
}

// othersService returns a service over the copies on other nodes of the
// weighted service target, without its sticky cookie: the one copy's
// service, or a weighted one; "" when there are none.
func (b *builder) othersService(target string) string {
	main := b.cfg.HTTP.Services[target]
	if main == nil || main.Weighted == nil {
		return ""
	}
	var others []weightedService
	for _, c := range main.Weighted.Services {
		if c.Name != b.n.svc("local") && !strings.HasPrefix(c.Name, b.n.svc("local-")) {
			others = append(others, c)
		}
	}
	switch len(others) {
	case 0:
		return ""
	case 1:
		return others[0].Name
	}
	name := target + "-others"
	b.cfg.HTTP.Services[name] = &service{Weighted: &weighted{Services: others}}
	return name
}

// retryMaxBodyBytes caps what Traefik buffers to replay a GET/HEAD/OPTIONS.
const retryMaxBodyBytes = 1 << 20

// hostsOnly drops the PathPrefix part of a rule.
func hostsOnly(ruleText string) string {
	if i := strings.Index(ruleText, " && PathPrefix("); i >= 0 {
		return ruleText[:i]
	}
	return ruleText
}

func (b *builder) redirects(r *agentv1.Route) []string {
	var out []string
	for i, rd := range r.GetRedirects() {
		out = append(out, b.mw(b.n.route(r.GetId(), fmt.Sprintf("redirect-%d", i)), &middleware{RedirectRegex: &redirectRegex{
			Regex: rd.GetFrom(), Replacement: rd.GetTo(), Permanent: rd.GetPermanent(),
		}}))
	}
	return out
}

// chain returns the Traefik service a route's requests go to and the
// middlewares on the way, in order: redirects, IP allowlist, rate limit,
// basic auth, then what depends on the mode.
func (b *builder) chain(r *agentv1.Route, m mode) (string, []string, error) {
	spec := b.spec()
	chain := b.redirects(r)
	if cidrs := r.GetAllowedSourceCidrs(); len(cidrs) > 0 {
		for _, c := range cidrs {
			if strings.ContainsAny(c, "`\n ") {
				return "", nil, fmt.Errorf("%w: source range %q", ErrInvalidRoute, c)
			}
		}
		chain = append(chain, b.mw(b.n.route(r.GetId(), "allow"), &middleware{IPAllowList: &ipAllowList{SourceRange: cidrs}}))
	}
	if rl := r.GetRateLimit(); rl.GetAverage() > 0 {
		period := ""
		if d := rl.GetPeriod().AsDuration(); d > 0 && rl.GetPeriod() != nil {
			period = d.String()
		}
		chain = append(chain, b.mw(b.n.route(r.GetId(), "ratelimit"), &middleware{RateLimit: &rateLimit{Average: rl.GetAverage(), Burst: rl.GetBurst(), Period: period}}))
	}
	if users := r.GetBasicAuth().GetUsers(); len(users) > 0 {
		list := make([]string, 0, len(users))
		for _, u := range users {
			if u.GetUsername() == "" || strings.ContainsAny(u.GetUsername(), ":\n") || !strings.HasPrefix(u.GetPasswordHash(), "$2") {
				return "", nil, fmt.Errorf("%w: basic auth user %q needs a bcrypt hash", ErrInvalidRoute, u.GetUsername())
			}
			list = append(list, u.GetUsername()+":"+u.GetPasswordHash())
		}
		chain = append(chain, b.mw(b.n.route(r.GetId(), "auth"), &middleware{BasicAuth: &basicAuth{Users: list, Realm: brand.DisplayName}}))
	}

	edge := b.n.svc("edge")
	switch m {
	case modeTool:
		tool := b.mw(b.n.svc("tool"), &middleware{Headers: &headers{CustomRequestHeaders: map[string]string{HeaderTool: b.toolSubject()}}})
		return edge, append(chain, tool), nil
	case modeMaintenance:
		page := b.mw(b.n.svc("maintenance"), &middleware{ReplacePath: &replacePath{Path: MaintenancePath + "/" + spec.GetId()}})
		return edge, append(chain, page), nil
	case modeStatus:
		page := b.mw(b.n.svc("down"), &middleware{ReplacePath: &replacePath{Path: StatusPath + "/" + spec.GetId()}})
		return edge, append(chain, page), nil
	}
	if b.in.Edge != "" {
		// The status page replaces a gateway error: the replica went away
		// or does not answer.
		chain = append(chain, b.mw(b.n.svc("unreachable"), &middleware{Errors: &errorPage{
			Status: []string{"502", "504"}, Service: edge, Query: StatusPath + "/" + spec.GetId(),
		}}))
	}
	if r.GetStripPrefix() && r.GetPathPrefix() != "" && r.GetPathPrefix() != "/" {
		chain = append(chain, b.mw(b.n.route(r.GetId(), "strip"), &middleware{StripPrefix: &stripPrefix{Prefixes: []string{r.GetPathPrefix()}}}))
	}
	return b.upstreamService(r, false), chain, nil
}

// buildDatabaseCert adds a router for an exposed database's TLS host name
// so Traefik obtains (and renews) its certificate over HTTP-01; the agent
// then reads it from acme.json (Certificate).
func (b *builder) buildDatabaseCert() error {
	exp := b.spec().GetDatabase().GetExposure()
	host := strings.ToLower(exp.GetTlsHostname())
	if !exp.GetEnabled() || host == "" {
		return nil
	}
	if err := checkHost(host); err != nil {
		return err
	}
	b.cfg.HTTP.Routers[b.n.svc("dbcert")] = &router{
		EntryPoints: []string{EntryPointSecure},
		Rule:        fmt.Sprintf("Host(`%s`)", host),
		Service:     "noop@internal",
		TLS:         &routerTLS{CertResolver: CertResolver},
	}
	return nil
}

// addProbe adds the rollout probe router: only the agent (secret header,
// optionally its source address) reaches it, and every answer through it
// carries the file version, so Verify can tell that Traefik loaded this
// file and reaches its upstreams.
func (b *builder) addProbe(version string) {
	spec := b.spec()
	ruleText := fmt.Sprintf("PathPrefix(`%s/%s/%s`) && Header(`%s`, `%s`)", ProbePath, spec.GetId(), version, HeaderProbe, b.in.ProbeSecret)
	if b.in.ProbeSource != "" {
		ruleText += fmt.Sprintf(" && ClientIP(`%s`)", b.in.ProbeSource)
	}
	mark := b.mw(b.n.svc("probe-mark"), &middleware{Headers: &headers{CustomResponseHeaders: map[string]string{HeaderRoute: version}}})
	target := "noop@internal"
	path := ProbePath
	switch {
	case len(b.in.Upstreams) > 0 && b.mode() == modeUpstream:
		target, path = b.n.svc("local"), "/"
	case b.in.Edge != "":
		target = b.n.svc("edge")
	}
	rewrite := b.mw(b.n.svc("probe-path"), &middleware{ReplacePath: &replacePath{Path: path}})
	b.cfg.HTTP.Routers[b.n.svc("probe")] = &router{
		EntryPoints: []string{EntryPointWeb},
		Rule:        ruleText,
		Priority:    priorityProbe,
		Middlewares: []string{mark, rewrite},
		Service:     target,
	}
}

// trim drops empty sections so the file stays readable.
// keepLBRouters drops every router that is not on the LB entry point, then
// the services and middlewares nothing uses any more.
func (b *builder) keepLBRouters() {
	usedSvc, usedMW := map[string]bool{}, map[string]bool{}
	for name, r := range b.cfg.HTTP.Routers {
		if !slices.Equal(r.EntryPoints, []string{EntryPointLB}) {
			delete(b.cfg.HTTP.Routers, name)
			continue
		}
		usedSvc[r.Service] = true
		for _, m := range r.Middlewares {
			usedMW[m] = true
		}
	}
	for name, m := range b.cfg.HTTP.Middlewares {
		if !usedMW[name] {
			delete(b.cfg.HTTP.Middlewares, name)
		} else if m.Errors != nil {
			// The error page is served by another service of this file.
			usedSvc[m.Errors.Service] = true
		}
	}
	for name := range b.cfg.HTTP.Services {
		if !usedSvc[name] {
			delete(b.cfg.HTTP.Services, name)
		}
	}
	b.cfg.TLS = nil
	// Only the transports the kept services use (the local one).
	usedTransport := map[string]bool{}
	for _, s := range b.cfg.HTTP.Services {
		if s.LoadBalancer != nil && s.LoadBalancer.ServersTransport != "" {
			usedTransport[s.LoadBalancer.ServersTransport] = true
		}
	}
	for name := range b.cfg.HTTP.ServersTransports {
		if !usedTransport[name] {
			delete(b.cfg.HTTP.ServersTransports, name)
		}
	}
	if len(b.cfg.HTTP.ServersTransports) == 0 {
		b.cfg.HTTP.ServersTransports = nil
	}
}

func (b *builder) trim() {
	if len(b.cfg.HTTP.Middlewares) == 0 {
		b.cfg.HTTP.Middlewares = nil
	}
	if len(b.cfg.HTTP.Services) == 0 {
		b.cfg.HTTP.Services = nil
	}
}

// Tool kinds the edge opens with a ticket.
const (
	ToolBox        = "box"
	ToolDatabaseUI = "db-ui"
)

// HasRouteFile reports whether a service needs a route file even without
// routes of its own: a Box, a database with its web UI on (the tool host)
// or an exposed database with a TLS host name (its certificate router).
func HasRouteFile(spec *agentv1.ServiceSpec) bool {
	if len(spec.GetRouting().GetRoutes()) > 0 || spec.GetKind() == agentv1.ServiceKind_SERVICE_KIND_BOX {
		return true
	}
	if spec.GetKind() != agentv1.ServiceKind_SERVICE_KIND_DATABASE {
		return false
	}
	exp := spec.GetDatabase().GetExposure()
	return spec.GetDatabase().GetTools().GetWebUi() || (exp.GetEnabled() && exp.GetTlsHostname() != "")
}

// ToolSubject is the ticket subject of a tool, for example "box:<id>".
func ToolSubject(kind, serviceID string) string { return kind + ":" + serviceID }

// defaultVerifyTimeout bounds Verify when ctx has no deadline.
const defaultVerifyTimeout = 15 * time.Second
