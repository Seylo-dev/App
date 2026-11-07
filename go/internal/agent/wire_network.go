package agent

// Network wiring: proxy, edge, portgate and Wings.

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dbtools"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/edge"
	"github.com/seylo-dev/app/go/internal/portgate"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/systemd"
	"github.com/seylo-dev/app/go/internal/wings"
)

// acmeCACertsEnv overrides config.yml's acme_ca_certificates (a PEM file
// of extra roots for a test ACME CA).
var acmeCACertsEnv = strings.ToUpper(brand.Slug) + "_ACME_CA_CERTIFICATES"

// acmeCAServerNameEnv overrides config.yml's acme_ca_server_name.
var acmeCAServerNameEnv = strings.ToUpper(brand.Slug) + "_ACME_CA_SERVER_NAME"

// acmeCAEnv overrides config.yml's acme_ca (the ACME directory of the
// agent's own Traefik): "staging" for Let's Encrypt staging, or a
// directory URL (test CAs).
var acmeCAEnv = strings.ToUpper(brand.Slug) + "_ACME_CA"

// networkParts holds the network components between provide and wire. It is
// d.Gate (the embedded portgate), so wireNetwork finds the rest through a
// type assertion instead of new Deps fields.
type networkParts struct {
	*portgate.Manager

	log     *slog.Logger
	docker  proxy.Docker
	moby    *proxy.MobyDocker
	router  *proxy.FileRouter
	edge    *edge.HTTPServer
	cpu     *wings.SliceCPU
	wings   *wings.Installation
	shared  bool
	traefik proxy.TraefikConfig
	// lbTraefik is the LB-only Traefik next to the Wings fork.
	lbTraefik proxy.TraefikConfig
	certs     *proxy.CertFailures
	reassert  time.Duration
	// edgeNet and edgePort are where the edge listener binds (the gateway
	// of edgeNet); tests use their own.
	edgeNet  string
	edgePort int

	mu          sync.Mutex
	gateway     string
	acmeEmail   string
	traefikWake chan struct{}
	// traefikDown raises TRAEFIK_DOWN while Traefik keeps failing to start
	// (port 80/443 taken), which the supervisor alone only logs.
	traefikDown failureAlert
}

// Tools is the edge tool registry (Box, database web UI). Until Deps has
// an edge field, other areas reach it with
// d.Gate.(interface{ Tools() edge.Tools }).
func (p *networkParts) Tools() edge.Tools { return p.edge }

// provideNetwork: set d.Router, d.Gate, d.Tickets, d.Wings and d.CPU.
func provideNetwork(d *Deps) error {
	log := d.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	log = log.With("component", "network")
	p := &networkParts{log: log, reassert: 15 * time.Second, traefikWake: make(chan struct{}, 1), edgeNet: docker.EdgeNetwork, edgePort: edge.DefaultPort}
	p.traefikDown.kind, p.traefikDown.title, p.traefikDown.hint = agentv1.NodeAlertKind_NODE_ALERT_KIND_TRAEFIK_DOWN, "Traefik (ports 80 and 443) cannot start", traefikHint

	if moby, err := proxy.NewMobyDocker(); err != nil {
		log.Warn("docker client unavailable; Traefik, edge and Wings attach stay off", "err", err)
	} else {
		p.moby, p.docker = moby, moby
	}

	detector := wings.NewDetector()
	inst, err := detector.Find()
	if err != nil {
		log.Warn("reading the Wings installation", "err", err)
	}
	p.wings = inst
	p.shared = inst != nil && inst.Proxy != nil

	traefikDir := d.Layout.TraefikDir()
	p.traefik = proxy.TraefikConfig{
		Name:         docker.TraefikContainer,
		Network:      docker.EdgeNetwork,
		DynamicDir:   filepath.Join(traefikDir, "dynamic"),
		DataDir:      filepath.Join(traefikDir, "acme"),
		HTTPPort:     80,
		HTTPSPort:    443,
		LBPort:       proxy.DefaultLBPort,
		AcmeCAServer: acmeCA(cmp.Or(os.Getenv(acmeCAEnv), d.Config.AcmeCA)),
		CACertFile:   acmeCACertFile(log, cmp.Or(os.Getenv(acmeCACertsEnv), d.Config.AcmeCACertificates)),
		CAServerName: cmp.Or(os.Getenv(acmeCAServerNameEnv), d.Config.AcmeCAServerName),
		CgroupParent: docker.CgroupParent,
	}
	p.certs = proxy.NewCertFailures()
	routerCfg := proxy.FileConfig{
		Dir:           p.traefik.DynamicDir,
		AcmeFile:      p.traefik.AcmeFile(),
		LBEntryPoint:  true,
		Containers:    []string{docker.TraefikContainer},
		NodeAddresses: nodeAddresses(d.Facts),
		CertFailures:  p.certs,
		Logger:        log,
	}
	if p.shared {
		// Next to the Wings fork: its Traefik owns 80/443 and reads our files
		// from its dynamic folder. It has no LB entry point, so a small
		// LB-only Traefik of ours takes traffic other nodes forward here.
		routerCfg.Dir = inst.Proxy.DynamicDir
		routerCfg.AcmeFile = inst.Proxy.AcmeFile()
		routerCfg.LBEntryPoint = false
		p.lbTraefik = proxy.TraefikConfig{
			Name:         proxy.LBTraefikContainer,
			Network:      docker.EdgeNetwork,
			DynamicDir:   filepath.Join(traefikDir, "lb-dynamic"),
			DataDir:      filepath.Join(traefikDir, "lb-data"),
			LBPort:       proxy.DefaultLBPort,
			LBOnly:       true,
			CgroupParent: docker.CgroupParent,
		}
		routerCfg.LBDir = p.lbTraefik.DynamicDir
		routerCfg.Containers = []string{inst.Proxy.Container, proxy.LBTraefikContainer}
	}
	p.router = proxy.NewFileRouter(routerCfg)

	verifier := edge.NewVerifier(d.Config.NodeID)
	handoffs := edge.NewHandoffs()
	// A kept key means an agent restart does not sign people out of Boxes
	// and database UIs.
	sessionKey, err := edge.LoadSessionKey(filepath.Join(d.Layout.NetworkDir(), "edge-session.key"))
	if err != nil {
		log.Warn("edge session key not kept; tool sessions end on restart", "err", err)
	}
	p.edge = edge.NewHTTPServer(edge.Config{Tickets: verifier, Handoffs: handoffs, SessionKey: sessionKey, Logger: log})

	p.Manager = portgate.New(portgate.Config{
		Resolve: func(ctx context.Context, serviceID string, port uint32) (string, error) {
			// Reconcile is set in phase 2; connections only come later.
			if d.Reconcile == nil {
				return "", errors.New("runtime not ready")
			}
			return d.Reconcile.Resolve(ctx, serviceID, port)
		},
		Handoff:   handoffLocation(handoffs),
		PortsFile: filepath.Join(d.Layout.NetworkDir(), "portgate.json"),
		// Exposed Mongo and Redis: the gate terminates TLS with the
		// database's certificate (ACME for tls_hostname, else self-signed).
		Certificate: func(serviceID, host string) ([]byte, []byte, error) {
			return dbtools.Certificate(p.router.Certificate, filepath.Join(d.Layout.StateDir(), "db-tls"), serviceID, host)
		},
		Logger: log,
	})

	var detect func(context.Context) (bool, error)
	if p.moby != nil {
		detect = p.moby.SystemdCgroupDriver
	}
	p.cpu = wings.NewSliceCPU(docker.CgroupParent, detect)

	d.Router = p.router
	d.Gate = p
	d.Tickets = verifier
	d.Wings = detector
	d.CPU = p.cpu
	return nil
}

// acmeCACertFile returns path when it is a readable file. A missing file
// would make Docker refuse the bind mount and leave the node without
// Traefik, so it is left out with a warning instead.
func acmeCACertFile(log *slog.Logger, path string) string {
	if path == "" {
		return ""
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		log.Warn("acme_ca_certificates is not a readable file; Traefik trusts the system roots only", "path", path, "err", err)
		return ""
	}
	return path
}

// acmeCA maps the env value to a directory URL.
func acmeCA(v string) string {
	if strings.EqualFold(v, "staging") {
		return proxy.LetsEncryptStaging
	}
	return v
}

func nodeAddresses(facts *Facts) func() []string {
	return func() []string {
		if facts == nil {
			return nil
		}
		f := facts.Get()
		var out []string
		for _, a := range []string{f.GetPublicIpv4(), f.GetPublicIpv6()} {
			if a != "" {
				out = append(out, a)
			}
		}
		return out
	}
}

// handoffLocation sends a browser with cookies through the edge's cookie
// handoff on the domain; one without cookies straight to the same path.
func handoffLocation(h *edge.Handoffs) portgate.Handoff {
	return func(r *http.Request, target string) string {
		u, err := url.Parse(target)
		if err != nil || len(r.Cookies()) == 0 || u.Hostname() == "" {
			return target + r.URL.RequestURI()
		}
		token := h.Put(u.Hostname(), r.URL.RequestURI(), r.Cookies())
		return target + proxy.HandoffPath + "?t=" + url.QueryEscape(token)
	}
}

// wireNetwork: RetryCertificate (cert_retry.go) is the area's only
// AgentService method (routes and ports arrive in ServiceSpec); the edge
// listener, Traefik (own or the Wings fork's) and the desired-state
// follower run as components, the edge ticket key comes from each
// handshake, and Wings is reported in d.Facts.
func wireNetwork(reg *Registry, d *Deps) error {
	log := d.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	registerCertRetry(reg, d, log.With("component", "network"))
	p, ok := d.Gate.(*networkParts)
	if !ok {
		// Tests replaced the components; nothing of ours to run.
		return nil
	}
	d.Components.OnConnect(func(_ context.Context, info ConnInfo) {
		if v, ok := d.Tickets.(*edge.Verifier); ok && info.NodeID != "" {
			v.SetNodeID(info.NodeID)
		}
		d.Tickets.SetKey(info.EdgeTicketPublicKey)
	})
	d.Components.Add("network-follow", func(ctx context.Context) error { return p.follow(ctx, d) })
	d.Components.Add("wings-facts", func(ctx context.Context) error { return p.wingsFacts(ctx, d) })
	if p.docker == nil {
		return nil
	}
	d.Components.Add("edge-listener", p.runEdge)
	d.Components.Add("certificate-failures", func(ctx context.Context) error {
		return proxy.WatchCertFailures(ctx, p.moby, func(context.Context) ([]string, error) {
			if p.shared {
				return []string{p.wings.Proxy.Container}, nil
			}
			return []string{p.traefik.Name}, nil
		}, p.certs)
	})
	if p.shared {
		d.Components.Add("wings-traefik", func(ctx context.Context) error { return p.runWingsTraefik(ctx, d) })
		d.Components.Add("route-reassert", p.runReassert)
		d.Components.Add("lb-traefik", func(ctx context.Context) error { return p.runLBTraefik(ctx, d) })
	} else {
		d.Components.Add("traefik", func(ctx context.Context) error { return p.runTraefik(ctx, d) })
	}
	return nil
}

func (p *networkParts) setGateway(gw string) {
	p.mu.Lock()
	p.gateway = gw
	p.mu.Unlock()
}

func (p *networkParts) getGateway() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.gateway
}

// runEdge binds the edge listener on the edge network's gateway, so only
// containers on that network (Traefik) reach it, and points the route
// files at it.
func (p *networkParts) runEdge(ctx context.Context) error {
	info, err := p.docker.EnsureNetwork(ctx, p.edgeNet, map[string]string{docker.LabelManaged: "true", docker.LabelRole: "edge"})
	if err != nil {
		return err
	}
	p.setGateway(info.Gateway)
	if msg := edgeBridgeProblem(p.edgeNet, info); msg != "" {
		p.log.Warn(msg)
	}
	l, err := net.Listen("tcp", net.JoinHostPort(info.Gateway, strconv.Itoa(p.edgePort)))
	if err != nil {
		return fmt.Errorf("edge listener on %s: %w", info.Gateway, err)
	}
	addr := l.Addr().String()
	p.router.SetEdge("http://" + addr)
	p.log.Info("edge listener up", "addr", addr)
	return p.edge.Serve(ctx, l)
}

// edgeBridgeProblem explains how to repair an edge network whose bridge
// is not named after it: a node that created it before every creator
// passed docker.NetworkOptions has a br-<id> interface, so the
// installer's "ufw allow in on <edge network>" rule never matches and
// Traefik cannot reach the edge listener behind ufw. Empty when fine.
func edgeBridgeProblem(network string, info proxy.NetworkInfo) string {
	want := docker.NetworkOptions(network)[docker.BridgeNameOption]
	if want == "" || info.BridgeName == want {
		return ""
	}
	return fmt.Sprintf("the %s network's bridge is not named %s, so a firewall rule for that interface (ufw allow in on %s) does not match it. "+
		"To repair: stop Traefik (docker stop %s), run docker network rm %s, then restart the agent (systemctl restart %s)",
		network, want, want, docker.TraefikContainer, network, systemd.AgentUnit)
}

// projectNetworks are the project networks of services with routes on this
// node: Traefik must be on them to reach the containers by name.
func projectNetworks(desired *agentv1.DesiredState) []string {
	var out []string
	for _, s := range desired.GetServices() {
		if len(s.GetRouting().GetRoutes()) == 0 || s.GetProjectId() == "" {
			continue
		}
		n := docker.ProjectNetwork(s.GetProjectId())
		if !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	return out
}

func (p *networkParts) attacher(d *Deps, container string) *wings.Attacher {
	return &wings.Attacher{
		Docker:    p.docker,
		Container: container,
		Network:   p.edgeNet,
		Extra: func() []string {
			if d.Feed == nil {
				return nil
			}
			return projectNetworks(d.Feed.Current())
		},
		OnAttached: func(ip string) {
			if gw := p.getGateway(); gw != "" {
				p.router.SetProbe(net.JoinHostPort(ip, "80"), gw)
			}
		},
		Logger: p.log,
	}
}

// runTraefik keeps the agent's own Traefik running and matching its
// config (the ACME email comes from the node settings), every 30s and
// whenever the settings change.
func (p *networkParts) runTraefik(ctx context.Context, d *Deps) error {
	att := p.attacher(d, p.traefik.Name)
	// Start from the stored settings: an empty ACME email here would change
	// the config hash and recreate a running Traefik on every agent start
	// (and again once the settings arrive).
	if d.Feed != nil {
		p.mu.Lock()
		if p.acmeEmail == "" {
			p.acmeEmail = d.Feed.Settings().GetAcmeEmail()
		}
		p.mu.Unlock()
	}
	for {
		cfg := p.traefik
		p.mu.Lock()
		cfg.AcmeEmail = p.acmeEmail
		p.mu.Unlock()
		t := &proxy.Traefik{Docker: p.docker, Config: cfg}
		st, err := t.Ensure(ctx)
		if err != nil {
			if ctx.Err() == nil {
				p.traefikDown.failed(ctx, d.Reports, p.log, err)
			}
			return fmt.Errorf("traefik: %w", err)
		}
		p.traefikDown.ok(ctx, d.Reports, p.log)
		p.setGateway(st.Gateway)
		if st.IP != "" {
			p.router.SetProbe(net.JoinHostPort(st.IP, "80"), st.Gateway)
		}
		if err := att.Attach(ctx); err != nil {
			p.log.Warn("attaching Traefik to project networks", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-p.traefikWake:
		case <-time.After(30 * time.Second):
		}
	}
}

// runLBTraefik keeps the LB-only Traefik running next to the Wings fork
// and on the project networks of routed services.
func (p *networkParts) runLBTraefik(ctx context.Context, d *Deps) error {
	att := p.attacher(d, p.lbTraefik.Name)
	att.OnAttached = nil // probes go through the fork's Traefik
	for {
		t := &proxy.Traefik{Docker: p.docker, Config: p.lbTraefik}
		if _, err := t.Ensure(ctx); err != nil {
			return fmt.Errorf("LB traefik: %w", err)
		}
		if err := att.Attach(ctx); err != nil {
			p.log.Warn("attaching the LB Traefik to project networks", "err", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(30 * time.Second):
		}
	}
}

// runWingsTraefik keeps the Wings fork's Traefik on our networks.
func (p *networkParts) runWingsTraefik(ctx context.Context, d *Deps) error {
	info, err := p.docker.EnsureNetwork(ctx, p.edgeNet, map[string]string{docker.LabelManaged: "true", docker.LabelRole: "edge"})
	if err != nil {
		return err
	}
	p.setGateway(info.Gateway)
	return p.attacher(d, p.wings.Proxy.Container).Run(ctx)
}

// runReassert rewrites route files a Wings build without foreign-routes
// support pruned.
func (p *networkParts) runReassert(ctx context.Context) error {
	t := time.NewTicker(p.reassert)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			if n, err := p.router.Reassert(); err != nil {
				p.log.Warn("rewriting route files", "err", err)
			} else if n > 0 {
				p.log.Warn("route files were removed by someone else and rewritten; update the Wings fork to a build with foreign-routes", "files", n)
			}
		}
	}
}

// follow applies every accepted desired state to the network components:
// maintenance pages, ports, games-first CPU, the ACME email, and removes
// route files of services that are gone.
func (p *networkParts) follow(ctx context.Context, d *Deps) error {
	if d.Feed == nil {
		<-ctx.Done()
		return nil
	}
	var mu sync.Mutex
	var latest *agentv1.DesiredState
	wake := make(chan struct{}, 1)
	cancel := d.Feed.Subscribe(func(s *agentv1.DesiredState) {
		mu.Lock()
		latest = s
		mu.Unlock()
		select {
		case wake <- struct{}{}:
		default:
		}
	})
	defer cancel()
	lastErr := ""
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-wake:
		}
		mu.Lock()
		s := latest
		mu.Unlock()
		if msg := p.applyDesired(ctx, s); msg != lastErr {
			if msg != "" {
				p.log.Warn("applying network settings", "err", msg)
			}
			lastErr = msg
		}
	}
}

// applyDesired returns the joined error text ("" when all went well).
func (p *networkParts) applyDesired(ctx context.Context, s *agentv1.DesiredState) string {
	var errs []error
	settings := s.GetSettings()
	p.router.SetSettings(settings)
	p.edge.SetDesired(s)
	if err := p.Manager.SyncAll(ctx, s); err != nil {
		errs = append(errs, err)
	}
	if err := p.cpu.SetGamesFirst(ctx, settings.GetGamesFirstCpu()); err != nil {
		errs = append(errs, err)
	}
	p.mu.Lock()
	emailChanged := p.acmeEmail != settings.GetAcmeEmail()
	p.acmeEmail = settings.GetAcmeEmail()
	p.mu.Unlock()
	if emailChanged {
		select {
		case p.traefikWake <- struct{}{}:
		default:
		}
	}
	if s.GetRevision() > 0 {
		// Only once a real desired state arrived: an empty one at start
		// must not wipe the files of a node that keeps routing offline.
		keep := make([]string, 0, len(s.GetServices()))
		for _, svc := range s.GetServices() {
			keep = append(keep, svc.GetId())
		}
		if _, err := p.router.Prune(keep); err != nil {
			errs = append(errs, err)
		}
	}
	if err := errors.Join(errs...); err != nil {
		return err.Error()
	}
	return ""
}

// wingsFacts reports Wings in NodeFacts at start and every 10 minutes.
func (p *networkParts) wingsFacts(ctx context.Context, d *Deps) error {
	for {
		dctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		info, err := d.Wings.Detect(dctx)
		cancel()
		if err != nil {
			p.log.Warn("detecting Wings", "err", err)
		} else if d.Facts != nil {
			d.Facts.Update(func(f *agentv1.NodeFacts) { f.Wings = info })
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(10 * time.Minute):
		}
	}
}
