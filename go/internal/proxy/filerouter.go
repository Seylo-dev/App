package proxy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
)

// FileConfig configures a FileRouter.
type FileConfig struct {
	// Dir is the Traefik dynamic folder on the host: the agent's own
	// traefik/dynamic, or the Wings fork's dynamic folder.
	Dir string
	// AcmeFile is Traefik's acme.json on the host, for route status and
	// database certificates. Empty disables both.
	AcmeFile string
	// LBEntryPoint adds routers for load-balanced traffic from other nodes
	// (only the agent's own Traefik has that entry point).
	LBEntryPoint bool
	// LBDir, next to the Wings fork, is the dynamic folder of the separate
	// LB Traefik (seylo-traefik-lb): the fork's Traefik has no LB entry
	// point, so the LB routers of every service go there in their own file.
	LBDir string
	// NodeAddresses returns this node's public addresses, for the DNS
	// check in Status. Nil skips the check.
	NodeAddresses func() []string
	// LookupHost resolves a host name for the DNS check (net.DefaultResolver
	// when nil).
	LookupHost func(ctx context.Context, host string) ([]string, error)
	// Containers are the Traefik containers reading Dir: the agent's own
	// seylo-traefik, or the Wings fork's. Reconcile connects them to the
	// project network of every routed service (ProxyContainers).
	Containers []string
	// CertFailures holds ACME errors from Traefik's log
	// (WatchCertFailures); nil reports missing certificates as pending.
	CertFailures *CertFailures
	Logger       *slog.Logger
}

// FileRouter writes one seylo-<service>.yml per service into a Traefik
// dynamic folder. It keeps the last inputs of every service so it can
// re-render all files when node settings, the edge address or the probe
// address change.
type FileRouter struct {
	cfg    FileConfig
	log    *slog.Logger
	acme   *acmeStore
	secret string
	client *http.Client

	mu       sync.Mutex
	services map[string]applied
	// retries counts the certificate retries per service and route
	// (certretry.go); the count names the route's routers.
	retries  map[string]map[string]uint64
	settings *agentv1.NodeSettings
	// lbTLS is the rendered LBTLSFile (nil: none written).
	lbTLS       []byte
	edge        string
	probeAddr   string
	probeSource string

	dnsMu sync.Mutex
	dns   map[string]dnsEntry
}

type applied struct {
	spec      *agentv1.ServiceSpec
	upstreams []Upstream
	built     Built
	// lb is the LB Traefik's file (LBDir only).
	lb Built
}

type dnsEntry struct {
	addrs []string
	err   error
	at    time.Time
}

const dnsCacheTTL = time.Minute

// NewFileRouter returns a router writing into cfg.Dir. It does no I/O.
func NewFileRouter(cfg FileConfig) *FileRouter {
	log := cfg.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	var secret [24]byte
	_, _ = rand.Read(secret[:])
	return &FileRouter{
		cfg:      cfg,
		log:      log,
		acme:     &acmeStore{path: cfg.AcmeFile},
		secret:   hex.EncodeToString(secret[:]),
		client:   &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		services: map[string]applied{},
		retries:  map[string]map[string]uint64{},
		dns:      map[string]dnsEntry{},
	}
}

// Dir is the dynamic folder the router writes to.
func (r *FileRouter) Dir() string { return r.cfg.Dir }

func (r *FileRouter) input(spec *agentv1.ServiceSpec, upstreams []Upstream) BuildInput {
	return BuildInput{
		Service:      spec,
		Upstreams:    upstreams,
		Settings:     r.settings,
		Edge:         r.edge,
		ProbeSecret:  r.secret,
		ProbeSource:  r.probeSource,
		LBEntryPoint: r.cfg.LBEntryPoint,
		CertRetries:  r.retryNames(spec.GetId()),
	}
}

// Apply implements Router.
func (r *FileRouter) Apply(ctx context.Context, spec *agentv1.ServiceSpec, upstreams []Upstream) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	spec = proto.Clone(spec).(*agentv1.ServiceSpec)
	upstreams = slices.Clone(upstreams)
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := r.checkHostsLocked(spec); err != nil {
		return err
	}
	r.pruneRetriesLocked(spec.GetId(), spec)
	a, err := r.render(spec, upstreams)
	if err != nil {
		return err
	}
	if err := r.writeBoth(spec.GetId(), a); err != nil {
		return err
	}
	r.services[spec.GetId()] = a
	return nil
}

// ErrHostTaken means a host is exclusive to another service on this node
// (the panel's domain, a tool host, a database certificate host).
var ErrHostTaken = fmt.Errorf("%w: the host belongs to another service", ErrInvalidRoute)

// checkHostsLocked refuses a spec that serves a host exclusive to another
// applied service, or makes exclusive a host another service serves. The
// panel checks ownership first; this keeps a wrong desired state from
// giving such a host a second owner on the node. Callers hold r.mu.
func (r *FileRouter) checkHostsLocked(spec *agentv1.ServiceSpec) error {
	all, exclusive := Hosts(spec, r.settings)
	if len(all) == 0 {
		return nil
	}
	for id, a := range r.services {
		if id == spec.GetId() {
			continue
		}
		theirs, theirExclusive := Hosts(a.spec, r.settings)
		for _, h := range all {
			_, mine := slices.BinarySearch(exclusive, h)
			_, served := slices.BinarySearch(theirs, h)
			_, theirsOnly := slices.BinarySearch(theirExclusive, h)
			if (mine && served) || theirsOnly {
				return fmt.Errorf("%w: %s (service %s)", ErrHostTaken, h, id)
			}
		}
	}
	return nil
}

// render builds the route file (and the LB file in LBDir mode).
func (r *FileRouter) render(spec *agentv1.ServiceSpec, upstreams []Upstream) (applied, error) {
	a := applied{spec: spec, upstreams: upstreams}
	var err error
	if a.built, err = Build(r.input(spec, upstreams)); err != nil {
		return a, err
	}
	if r.cfg.LBDir != "" {
		in := r.input(spec, upstreams)
		in.LBOnly = true
		if a.lb, err = Build(in); err != nil {
			return a, err
		}
	}
	return a, nil
}

// writeBoth writes the route file and, in LBDir mode, the LB file.
// Callers hold r.mu.
func (r *FileRouter) writeBoth(serviceID string, a applied) error {
	if err := r.write(serviceID, a.built); err != nil {
		return err
	}
	if r.cfg.LBDir == "" {
		return nil
	}
	name := docker.RouteFile(serviceID)
	if a.lb.Data == nil {
		return removeFile(r.cfg.LBDir, name)
	}
	if err := os.MkdirAll(r.cfg.LBDir, 0o700); err != nil {
		return fmt.Errorf("creating LB route folder: %w", err)
	}
	return writeAtomic(r.cfg.LBDir, name, a.lb.Data)
}

// write puts or removes one file. Callers hold r.mu.
func (r *FileRouter) write(serviceID string, built Built) error {
	name := docker.RouteFile(serviceID)
	if built.Data == nil {
		return removeFile(r.cfg.Dir, name)
	}
	if err := os.MkdirAll(r.cfg.Dir, 0o700); err != nil {
		return fmt.Errorf("creating route folder: %w", err)
	}
	return writeAtomic(r.cfg.Dir, name, built.Data)
}

// Remove implements Router.
func (r *FileRouter) Remove(ctx context.Context, serviceID string) error {
	if err := checkID("service", serviceID); err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.services, serviceID)
	r.pruneRetriesLocked(serviceID, nil)
	if r.cfg.LBDir != "" {
		if err := removeFile(r.cfg.LBDir, docker.RouteFile(serviceID)); err != nil {
			return err
		}
	}
	return removeFile(r.cfg.Dir, docker.RouteFile(serviceID))
}

// SetSettings re-renders every file when node settings that reach route
// files change (the global maintenance page, the wildcard domain of tool
// hosts, the LB entry point's mutual TLS).
func (r *FileRouter) SetSettings(settings *agentv1.NodeSettings) {
	r.mu.Lock()
	defer r.mu.Unlock()
	same := r.settings != nil && proto.Equal(settings.GetMaintenance(), r.settings.GetMaintenance()) &&
		settings.GetWildcardDomain() == r.settings.GetWildcardDomain() &&
		proto.Equal(lbTLSOf(settings), lbTLSOf(r.settings))
	settings = proto.Clone(settings).(*agentv1.NodeSettings)
	if same {
		r.settings = settings
		return
	}
	if lb := lbTLSOf(settings); lb != nil && !proto.Equal(lb, lbTLSOf(r.settings)) {
		if err := checkLBTLS(lb); err != nil {
			// Keep the routers on the LB TLS options without the file that
			// defines them: Traefik refuses that traffic rather than
			// taking it from anyone.
			r.log.Error("the panel's load balancer TLS settings are unusable; other nodes cannot balance to this one", "err", err)
		}
	}
	r.settings = settings
	// The TLS options exist before routers name them, and go only after
	// no router names them any more.
	if err := r.writeLBTLSLocked(); err != nil {
		r.log.Warn("writing the LB TLS file failed", "err", err)
	}
	r.rerenderLocked()
	if lbTLSOf(r.settings) == nil {
		if err := r.writeLBTLSLocked(); err != nil {
			r.log.Warn("removing the LB TLS file failed", "err", err)
		}
	}
}

// lbTLSDir is the folder of the Traefik that serves the LB entry point:
// the LB Traefik next to Wings, else our own Traefik; "" when this node
// has none.
func (r *FileRouter) lbTLSDir() string {
	switch {
	case r.cfg.LBDir != "":
		return r.cfg.LBDir
	case r.cfg.LBEntryPoint:
		return r.cfg.Dir
	}
	return ""
}

// writeLBTLSLocked puts or removes LBTLSFile to match the settings.
// Callers hold r.mu.
func (r *FileRouter) writeLBTLSLocked() error {
	dir := r.lbTLSDir()
	if dir == "" {
		return nil
	}
	lb := lbTLSOf(r.settings)
	if lb == nil {
		r.lbTLS = nil
		return removeFile(dir, LBTLSFile)
	}
	data, err := BuildLBTLS(lb)
	if err != nil {
		r.lbTLS = nil
		return removeFile(dir, LBTLSFile)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("creating route folder: %w", err)
	}
	if err := writeAtomic(dir, LBTLSFile, data); err != nil {
		return err
	}
	r.lbTLS = data
	return nil
}

// SetEdge sets the edge listener URL as Traefik reaches it and re-renders.
func (r *FileRouter) SetEdge(url string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.edge == url {
		return
	}
	r.edge = url
	r.rerenderLocked()
}

// SetProbe sets where Verify reaches Traefik's web entry point ("ip:80")
// and the client address Traefik sees for those requests (the probe
// router only accepts it; empty accepts any source with the secret).
func (r *FileRouter) SetProbe(addr, source string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.probeAddr = addr
	if r.probeSource == source {
		return
	}
	r.probeSource = source
	r.rerenderLocked()
}

func (r *FileRouter) rerenderLocked() {
	for id, a := range r.services {
		next, err := r.render(a.spec, a.upstreams)
		if err == nil {
			err = r.writeBoth(id, next)
		}
		if err != nil {
			r.log.Warn("re-rendering route file failed", "service_id", id, "err", err)
			continue
		}
		r.services[id] = next
	}
}

// Reassert rewrites files that went missing or changed on disk, for
// example pruned by a Wings build that does not leave foreign route files
// alone. It returns how many it rewrote.
func (r *FileRouter) Reassert() (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	if r.lbTLS != nil {
		if dir := r.lbTLSDir(); dir != "" {
			current, err := os.ReadFile(filepath.Join(dir, LBTLSFile))
			if err != nil || string(current) != string(r.lbTLS) {
				if err := writeAtomic(dir, LBTLSFile, r.lbTLS); err != nil {
					return n, err
				}
				n++
			}
		}
	}
	for id, a := range r.services {
		if a.built.Data == nil {
			continue
		}
		current, err := os.ReadFile(filepath.Join(r.cfg.Dir, docker.RouteFile(id)))
		if err == nil && string(current) == string(a.built.Data) {
			continue
		}
		if err := r.write(id, a.built); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}

// Prune removes our route files (and leftover temp files) of services not
// in keep and not applied since start. Files of the Wings fork are never
// touched.
func (r *FileRouter) Prune(keep []string) ([]string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	var removed []string
	for _, dir := range []string{r.cfg.Dir, r.cfg.LBDir} {
		if dir == "" {
			continue
		}
		routes, temps, err := ownedFiles(dir)
		if err != nil {
			return removed, err
		}
		for _, t := range temps {
			if err := removeFile(dir, t); err != nil {
				return removed, err
			}
			removed = append(removed, t)
		}
		for id, name := range routes {
			if _, ok := r.services[id]; ok || slices.Contains(keep, id) {
				continue
			}
			if err := removeFile(dir, name); err != nil {
				return removed, err
			}
			removed = append(removed, name)
		}
	}
	return removed, nil
}

// Verify implements Router.
func (r *FileRouter) Verify(ctx context.Context, serviceID string) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, defaultVerifyTimeout)
		defer cancel()
	}
	last := "no answer yet"
	for {
		r.mu.Lock()
		a, ok := r.services[serviceID]
		addr := r.probeAddr
		r.mu.Unlock()
		if !ok || a.built.Data == nil {
			return nil
		}
		if addr == "" {
			last = ErrNoProbe.Error()
		} else if done, why := r.probe(ctx, addr, serviceID, a.built.Version); done {
			return nil
		} else {
			last = why
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: service %s: %s", ErrNotVerified, serviceID, last)
		case <-time.After(150 * time.Millisecond):
		}
	}
}

// probe sends one request through Traefik's probe router of version.
func (r *FileRouter) probe(ctx context.Context, addr, serviceID, version string) (bool, string) {
	url := fmt.Sprintf("http://%s%s/%s/%s", addr, ProbePath, serviceID, version)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, err.Error()
	}
	req.Header.Set(HeaderProbe, r.secret)
	resp, err := r.client.Do(req)
	if err != nil {
		return false, err.Error()
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	_ = resp.Body.Close()
	if got := resp.Header.Get(HeaderRoute); got != version {
		return false, fmt.Sprintf("traefik answered %d without route version %s (has %q)", resp.StatusCode, version, got)
	}
	switch resp.StatusCode {
	case http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
		return false, fmt.Sprintf("traefik serves the new routes but the upstream answered %d", resp.StatusCode)
	}
	return true, ""
}

// Status implements Router.
func (r *FileRouter) Status(ctx context.Context, serviceID string) ([]*agentv1.RouteStatus, error) {
	r.mu.Lock()
	a, ok := r.services[serviceID]
	r.mu.Unlock()
	if !ok {
		return nil, nil
	}
	var nodeAddrs []string
	if r.cfg.NodeAddresses != nil {
		nodeAddrs = r.cfg.NodeAddresses()
	}
	out := []*agentv1.RouteStatus{}
	for _, route := range a.spec.GetRouting().GetRoutes() {
		st := &agentv1.RouteStatus{RouteId: route.GetId(), State: agentv1.RouteState_ROUTE_STATE_ACTIVE}
		if host, found := r.dnsMismatch(ctx, route.GetHosts(), nodeAddrs); host != "" {
			st.State = agentv1.RouteState_ROUTE_STATE_DNS_MISMATCH
			st.Message = fmt.Sprintf("%s resolves to %s, not to this node", host, strings.Join(found, ", "))
			out = append(out, st)
			continue
		}
		switch route.GetHttps() {
		case agentv1.HttpsMode_HTTPS_MODE_ACME, agentv1.HttpsMode_HTTPS_MODE_UNSPECIFIED:
			if r.cfg.AcmeFile != "" {
				r.acmeStatus(st, route.GetHosts())
			}
		case agentv1.HttpsMode_HTTPS_MODE_CUSTOM_CERTIFICATE:
			if info, err := leafInfo([]byte(route.GetCertificate().GetCertPem())); err == nil {
				setCertInfo(st, info)
			}
		}
		out = append(out, st)
	}
	return out, nil
}

// acmeStatus fills a route's certificate state from acme.json and the
// failures in Traefik's log: FAILED when a host without a certificate has
// a recent ACME error, PENDING when it has none yet, ACTIVE with the
// earliest-expiring certificate's issuer and expiry when all hosts have one.
func (r *FileRouter) acmeStatus(st *agentv1.RouteStatus, hosts []string) {
	var first certInfo
	for _, host := range hosts {
		host = strings.ToLower(host)
		if !r.acme.has(host) {
			if msg, failed := r.cfg.CertFailures.Failure(host); failed {
				st.State = agentv1.RouteState_ROUTE_STATE_CERTIFICATE_FAILED
				st.Message = host + ": " + msg
				return
			}
			st.State = agentv1.RouteState_ROUTE_STATE_CERTIFICATE_PENDING
			st.Message = "waiting for the Let's Encrypt certificate of " + host
			continue
		}
		r.cfg.CertFailures.Forget(host)
		info, ok := r.acme.info(host)
		if ok && (first.notAfter.IsZero() || info.notAfter.Before(first.notAfter)) {
			first = info
		}
	}
	if st.State == agentv1.RouteState_ROUTE_STATE_ACTIVE && !first.notAfter.IsZero() {
		setCertInfo(st, first)
	}
}

func setCertInfo(st *agentv1.RouteStatus, info certInfo) {
	st.CertificateIssuer = info.issuer
	st.CertificateExpiresAt = timestamppb.New(info.notAfter)
}

// dnsMismatch returns the first host that resolves, but not to any of the
// node's addresses. Hosts that do not resolve at all are left to the
// certificate state (the panel's DNS check explains those), and so are
// hosts behind Cloudflare's proxy: they resolve to Cloudflare's addresses
// whatever their record there points at, so only the certificate tells
// (Let's Encrypt reached this node through the proxy), and a mismatch
// would hide it: the route would never report ACTIVE.
func (r *FileRouter) dnsMismatch(ctx context.Context, hosts, nodeAddrs []string) (string, []string) {
	if len(nodeAddrs) == 0 {
		return "", nil
	}
	for _, host := range hosts {
		addrs, err := r.lookup(ctx, host)
		if err != nil || len(addrs) == 0 {
			continue
		}
		match := false
		for _, a := range addrs {
			if slices.Contains(nodeAddrs, a) {
				match = true
				break
			}
		}
		if !match && !cloudflareProxied(addrs) {
			return host, addrs
		}
	}
	return "", nil
}

func (r *FileRouter) lookup(ctx context.Context, host string) ([]string, error) {
	r.dnsMu.Lock()
	e, ok := r.dns[host]
	r.dnsMu.Unlock()
	if ok && time.Since(e.at) < dnsCacheTTL {
		return e.addrs, e.err
	}
	lookup := r.cfg.LookupHost
	if lookup == nil {
		lookup = net.DefaultResolver.LookupHost
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	addrs, err := lookup(ctx, host)
	r.dnsMu.Lock()
	r.dns[host] = dnsEntry{addrs: addrs, err: err, at: time.Now()}
	r.dnsMu.Unlock()
	return addrs, err
}

// ProxyContainers returns the Traefik containers that read the route
// files, for reconcile to attach to project networks
// (reconcile.ProxyContainers).
func (r *FileRouter) ProxyContainers(context.Context) ([]string, error) {
	return slices.Clone(r.cfg.Containers), nil
}

// Services returns the ids of every service with applied routes.
func (r *FileRouter) Services() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]string, 0, len(r.services))
	for id := range r.services {
		out = append(out, id)
	}
	slices.Sort(out)
	return out
}

// Certificate implements Certificates from Traefik's acme.json.
func (r *FileRouter) Certificate(host string) ([]byte, []byte, error) {
	return r.acme.Certificate(strings.ToLower(host))
}

var (
	_ Router       = (*FileRouter)(nil)
	_ Certificates = (*FileRouter)(nil)
)
