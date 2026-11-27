package agent

// Visitor country wiring (geoip): while NodeSettings.country_header is on,
// the agent keeps a country database in <datadir>/geoip, the lookup
// server's systemd units, and tells the route files where the server is
// (proxy.CountryLookup) only while the server answers. Turned off, the
// route files stop asking first, and the units go a little later, once
// Traefik read the new files.

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/seylo-dev/app/go/gen/brand"
	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/geoip"
	"github.com/seylo-dev/app/go/internal/proxy"
	"github.com/seylo-dev/app/go/internal/systemd"
	"github.com/seylo-dev/app/go/internal/version"
)

// CountryHeaderCapability says the node's route files can carry the
// visitor's country (NodeSettings.country_header).
const CountryHeaderCapability = "routing.country-header.v1"

// Timing of the country lookup upkeep.
const (
	// geoipCheckEvery is how often the server is asked for its health.
	geoipCheckEvery = 10 * time.Second
	// geoipFailures health checks in a row that fail take the lookup out
	// of the route files, so requests stop waiting on a broken server.
	geoipFailures = 2
	// geoipRemoveAfter is how long the units stay after the header was
	// turned off: Traefik reads the files without the lookup first.
	geoipRemoveAfter = 30 * time.Second
	// geoipFirstCheck bounds the check before the first route files, so an
	// agent restart does not write files without the lookup for a moment.
	geoipFirstCheck = 1500 * time.Millisecond
	// geoipRetryWithout is how soon a failed first download is tried again.
	geoipRetryWithout = 15 * time.Minute
	// geoipReachEvery is how often Traefik's own path to the server is
	// checked again once the route files ask it (a firewall change, a new
	// Traefik).
	geoipReachEvery = 10 * time.Minute
)

// errProbeUnavailable: the check from Traefik's container could not run
// (no such container, no wget in its image); the agent's own check decides.
var errProbeUnavailable = errors.New("cannot check from Traefik's container")

// countryRouter is the part of the file router the lookup upkeep uses.
type countryRouter interface {
	SetCountry(proxy.CountryLookup)
}

type geoipParts struct {
	log    *slog.Logger
	fetch  *geoip.Fetcher
	units  geoip.Units
	router countryRouter
	// gateway is the edge network's gateway ("" until known).
	gateway func() string
	// bodyLimit says whether the Traefik reading the route files takes
	// forwardAuth's maxResponseBodySize.
	bodyLimit func(ctx context.Context) bool
	// reach checks the server's address from inside the Traefik container
	// that reads the route files: the agent's own check goes over the
	// host's loopback, which a firewall rule on the edge bridge does not
	// touch. errProbeUnavailable when it cannot run. Nil: not checked.
	reach func(ctx context.Context, listen string) error
	// openFirewall adds the host firewall rule Traefik needs (ufw when it is
	// active) and reports whether it added one. Nil: nothing to open.
	openFirewall func(ctx context.Context) (bool, error)
	binary       string
	port         int
	client       *http.Client
	// refreshEvery and removeAfter are the defaults outside tests.
	refreshEvery, removeAfter, checkEvery time.Duration

	mu       sync.Mutex
	settings *agentv1.CountryHeader
	wake     chan struct{}

	// limitAt and limit cache bodyLimit for a minute.
	limitAt time.Time
	limit   bool
	// lastProblem is the last problem logged, so a lasting one is logged
	// once.
	lastProblem string
	// asked is the address the route files ask now, unreachable why
	// Traefik cannot reach the server (both under mu).
	asked       string
	unreachable string
}

// report is the header's state for the health check.
func (g *geoipParts) report(ctx context.Context) *geoip.Report {
	g.mu.Lock()
	r := &geoip.Report{Enabled: g.settings.GetEnabled(), Asked: g.asked != "", Unreachable: g.unreachable}
	g.mu.Unlock()
	if !r.Enabled {
		return r
	}
	r.State, _ = g.fetch.State()
	if gw := g.gateway(); gw != "" {
		r.Listen = net.JoinHostPort(gw, strconv.Itoa(g.port))
		h, err := g.health(ctx, r.Listen)
		if err != nil {
			r.HealthErr = err.Error()
		}
		r.Health = h
	}
	return r
}

// problem logs msg and err once while they stay the same.
func (g *geoipParts) problem(msg string, err error) {
	text := msg + ": " + err.Error()
	if text == g.lastProblem {
		return
	}
	g.lastProblem = text
	g.log.Warn(msg, "err", err)
}

// lookup is the router's CountryLookup for a server at listen.
func (g *geoipParts) lookup(ctx context.Context, listen string) proxy.CountryLookup {
	if g.limitAt.IsZero() || time.Since(g.limitAt) > time.Minute {
		g.limit, g.limitAt = g.bodyLimit(ctx), time.Now()
	}
	return proxy.CountryLookup{Address: "http://" + listen + "/", MaxResponseBodySize: g.limit}
}

// wireGeoIP follows NodeSettings.country_header and runs the upkeep.
func wireGeoIP(reg *Registry, d *Deps) error {
	np, ok := d.Gate.(*networkParts)
	if !ok || np.docker == nil {
		// Tests replaced the network components, or there is no Docker:
		// no Traefik to give the header.
		return nil
	}
	log := d.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	log = log.With("component", "geoip")
	g := &geoipParts{
		log: log,
		fetch: &geoip.Fetcher{
			Dir:       filepath.Join(d.Layout.Root(), "geoip"),
			UserAgent: brand.DisplayName + "-agent/" + version.Version + " (+" + brand.DocsURL + ")",
			Logger:    log,
		},
		units:        geoip.Units{Dir: systemd.UnitDir, Run: systemd.ExecRunner},
		reach:        np.traefikReaches(d.Docker),
		openFirewall: allowGeoIPInUFW,
		router:       np.router,
		gateway:      np.getGateway,
		bodyLimit:    np.countryBodyLimit,
		binary:       agentBinary(),
		port:         geoip.DefaultPort,
		client:       &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}},
		refreshEvery: geoip.RefreshInterval,
		removeAfter:  geoipRemoveAfter,
		checkEvery:   geoipCheckEvery,
		wake:         make(chan struct{}, 1),
	}
	g.settings = feedSettings(d).GetCountryHeader()
	ctx, cancel := context.WithTimeout(context.Background(), geoipFirstCheck)
	g.prepare(ctx)
	cancel()
	if d.Feed != nil {
		d.Feed.Subscribe(func(s *agentv1.DesiredState) { g.setSettings(s.GetSettings().GetCountryHeader()) })
	}
	d.CountryHeader = g.report
	d.Components.Add("geoip", g.run)
	reg.Advertise(CountryHeaderCapability)
	return nil
}

// agentBinary is the binary the server unit starts: the installed one
// when it is there (an update replaces that file), else this process's.
func agentBinary() string {
	if _, err := os.Stat(systemd.DefaultBinary); err == nil {
		return systemd.DefaultBinary
	}
	exe, err := os.Executable()
	if err != nil {
		return systemd.DefaultBinary
	}
	return strings.TrimSuffix(exe, " (deleted)")
}

func (g *geoipParts) setSettings(s *agentv1.CountryHeader) {
	g.mu.Lock()
	g.settings = s
	g.mu.Unlock()
	select {
	case g.wake <- struct{}{}:
	default:
	}
}

func (g *geoipParts) current() *agentv1.CountryHeader {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.settings
}

var listenStream = regexp.MustCompile(`(?m)^ListenStream=(\S+)$`)

// prepare points the router at a server left running by the agent that
// ran before, before the first route files are written.
func (g *geoipParts) prepare(ctx context.Context) {
	if !g.current().GetEnabled() {
		return
	}
	data, err := os.ReadFile(filepath.Join(g.units.Dir, geoip.SocketUnit))
	if err != nil {
		return
	}
	m := listenStream.FindSubmatch(data)
	if m == nil {
		return
	}
	listen := string(m[1])
	if h, err := g.health(ctx, listen); err == nil && h.Protocol >= geoip.ServerProtocol {
		g.router.SetCountry(g.lookup(ctx, listen))
	}
}

// health asks the server at listen how it is.
func (g *geoipParts) health(ctx context.Context, listen string) (geoip.Health, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+listen+geoip.HealthPath, nil)
	if err != nil {
		return geoip.Health{}, err
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return geoip.Health{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return geoip.Health{}, fmt.Errorf("the lookup server answered %s", resp.Status)
	}
	var h geoip.Health
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 64<<10)).Decode(&h); err != nil {
		return geoip.Health{}, fmt.Errorf("the lookup server's health: %w", err)
	}
	return h, nil
}

// run keeps the lookup in step with the settings until ctx ends.
func (g *geoipParts) run(ctx context.Context) error {
	var (
		ensured   string // listen address the units were last made for
		reachedAt time.Time
		failures  int
		offSince  time.Time
		refreshMu sync.Mutex
		nextFetch time.Time
		pointed   string
		restarted int
	)
	refresh := func(mm geoip.MaxMind) {
		if !refreshMu.TryLock() {
			return
		}
		go func() {
			defer refreshMu.Unlock()
			if _, err := g.fetch.Refresh(ctx, mm); err != nil && ctx.Err() == nil {
				// Not deduplicated: at most every refreshEvery.
				g.log.Warn("downloading the country database failed; the installed one stays (without one, apps get "+geoip.Unknown+")", "err", err)
			}
		}()
	}
	point := func(c proxy.CountryLookup) {
		if c.Address != pointed {
			if c.Address == "" {
				g.log.Info("route files no longer ask for the visitor's country")
			} else {
				g.log.Info("route files ask for the visitor's country", "address", c.Address)
			}
		}
		pointed = c.Address
		g.mu.Lock()
		g.asked = c.Address
		g.mu.Unlock()
		g.router.SetCountry(c)
	}
	t := time.NewTicker(g.checkEvery)
	defer t.Stop()
	for {
		s := g.current()
		switch {
		case !s.GetEnabled():
			if pointed != "" || offSince.IsZero() {
				point(proxy.CountryLookup{})
				offSince = time.Now()
			}
			ensured, failures, restarted = "", 0, 0
			if g.units.Installed() && time.Since(offSince) >= g.removeAfter {
				if err := g.units.Remove(ctx); err != nil {
					g.problem("removing the country lookup units", err)
				} else {
					g.log.Info("country lookup stopped")
				}
			}
		case g.gateway() == "":
			// The edge listener has not made the network yet.
		default:
			offSince = time.Time{}
			mm := geoip.MaxMind{AccountID: s.GetMaxmindAccountId(), LicenseKey: s.GetMaxmindLicenseKey()}
			if now := time.Now(); now.After(nextFetch) {
				// A few minutes apart on different nodes, so a fleet does
				// not ask DB-IP in the same second; sooner while there is
				// no database at all.
				every := g.refreshEvery + time.Duration(rand.Int64N(int64(10*time.Minute)))
				if _, err := os.Stat(g.fetch.Path()); err != nil {
					every = geoipRetryWithout
				}
				nextFetch = now.Add(every)
				refresh(mm)
			}
			listen := net.JoinHostPort(g.gateway(), strconv.Itoa(g.port))
			if ensured != listen {
				if _, err := g.units.Ensure(ctx, listen, g.binary, g.fetch.Path()); err != nil {
					g.problem("installing the country lookup units", err)
					point(proxy.CountryLookup{})
					break
				}
				ensured = listen
			}
			h, err := g.health(ctx, listen)
			switch {
			case err != nil:
				failures++
				if failures >= geoipFailures {
					g.problem("the country lookup server does not answer; requests go on without the header", err)
					point(proxy.CountryLookup{})
					// Rewrite the units and start the socket again.
					ensured = ""
				}
			case h.Protocol < geoip.ServerProtocol:
				// Started by an older agent: restart it with this binary.
				// The socket keeps the requests waiting meanwhile.
				if restarted < 3 {
					restarted++
					if err := g.units.RestartService(ctx); err != nil {
						g.log.Error("restarting the country lookup server", "err", err)
					}
				}
			default:
				failures, restarted = 0, 0
				if pointed == "" || time.Since(reachedAt) >= geoipReachEvery {
					if err := g.traefikReaches(ctx, listen); err != nil {
						g.problem("Traefik cannot reach the country lookup server; requests go on without the header", err)
						point(proxy.CountryLookup{})
						break
					}
					reachedAt = time.Now()
				}
				g.lastProblem = ""
				point(g.lookup(ctx, listen))
			}
		}
		select {
		case <-ctx.Done():
			return nil
		case <-g.wake:
		case <-t.C:
		}
	}
}

// traefikReaches checks the path from Traefik to the server, opening the
// host firewall once when it is closed. A check that cannot run leaves the
// decision to the agent's own one. It records why Traefik cannot reach it
// for the health check.
func (g *geoipParts) traefikReaches(ctx context.Context, listen string) error {
	if g.reach == nil {
		return nil
	}
	err := g.reach(ctx, listen)
	if err != nil && !errors.Is(err, errProbeUnavailable) && g.openFirewall != nil {
		opened, ferr := g.openFirewall(ctx)
		if ferr != nil {
			g.log.Warn("opening the firewall for the country lookup", "err", ferr)
		}
		if opened {
			g.log.Info("allowed the country lookup's port on the edge bridge in ufw", "port", g.port)
			err = g.reach(ctx, listen)
		}
	}
	if errors.Is(err, errProbeUnavailable) {
		g.log.Debug("the country lookup is checked from the host only", "err", err)
		err = nil
	}
	g.mu.Lock()
	g.unreachable = ""
	if err != nil {
		g.unreachable = err.Error()
	}
	g.mu.Unlock()
	return err
}

// traefikReaches returns the check from inside the Traefik container that
// reads the route files (ours, or the Wings fork's): busybox wget in the
// Traefik image asks the server's health.
func (p *networkParts) traefikReaches(eng docker.Engine) func(ctx context.Context, listen string) error {
	if eng == nil {
		return nil
	}
	return func(ctx context.Context, listen string) error {
		name := cmp.Or(p.traefik.Name, docker.TraefikContainer)
		if p.shared {
			name = p.wings.Proxy.Container
		}
		ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		res, err := eng.ExecRun(ctx, name, []string{"wget", "-q", "-T", "5", "-O", "/dev/null", "http://" + listen + geoip.HealthPath}, 2048)
		if err != nil {
			return fmt.Errorf("%w: %v", errProbeUnavailable, err)
		}
		switch res.ExitCode {
		case 0:
			return nil
		case 126, 127:
			return fmt.Errorf("%w: no wget in %s", errProbeUnavailable, name)
		}
		return fmt.Errorf("from %s, %s does not answer (%s): a firewall on the %s bridge?", name, listen, strings.TrimSpace(string(res.Output)), docker.EdgeNetwork)
	}
}

// allowGeoIPInUFW adds, when ufw is active, the rule the installer adds
// since 0.2.24: TCP to the lookup's port from the edge bridge only, like
// the edge listener's 5756. Nodes installed before need it from the agent.
func allowGeoIPInUFW(ctx context.Context) (bool, error) {
	if _, err := exec.LookPath("ufw"); err != nil {
		return false, nil
	}
	out, err := exec.CommandContext(ctx, "ufw", "status").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "Status: active") {
		return false, nil
	}
	bridge := docker.NetworkOptions(docker.EdgeNetwork)[docker.BridgeNameOption]
	out, err = exec.CommandContext(ctx, "ufw", "allow", "in", "on", bridge, "to", "any", "port", strconv.Itoa(geoip.DefaultPort),
		"proto", "tcp", "comment", brand.Slug+" geoip").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("ufw allow: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return true, nil
}

// countryBodyLimit says whether the Traefik that reads the route files
// takes forwardAuth's maxResponseBodySize (3.6.9 and later): our own
// always does; the Wings fork's is checked by its image tag, and an image
// we cannot read the version of gets none (an older Traefik would refuse
// the whole file).
func (p *networkParts) countryBodyLimit(ctx context.Context) bool {
	if !p.shared {
		return true
	}
	info, err := p.docker.InspectContainer(ctx, p.wings.Proxy.Container)
	if err != nil {
		return false
	}
	return traefikAtLeast(info.Image, 3, 6, 9)
}

// traefikAtLeast reads the version in an image reference such as
// "traefik:v3.7.15" or "docker.io/library/traefik:3.7" and compares it.
func traefikAtLeast(image string, major, minor, patch int) bool {
	ref, _, _ := strings.Cut(image, "@")
	i := strings.LastIndexByte(ref, ':')
	if i < 0 || strings.Contains(ref[i:], "/") {
		return false
	}
	tag := strings.TrimPrefix(ref[i+1:], "v")
	tag, _, _ = strings.Cut(tag, "-")
	parts := strings.Split(tag, ".")
	if len(parts) < 2 || len(parts) > 3 {
		return false
	}
	nums := []int{0, 0, 0}
	for k, s := range parts {
		n, err := strconv.Atoi(s)
		if err != nil {
			return false
		}
		nums[k] = n
	}
	if len(parts) == 2 {
		// "v3.7" follows the newest 3.7 patch.
		nums[2] = 1 << 30
	}
	want := []int{major, minor, patch}
	for k := range nums {
		if nums[k] != want[k] {
			return nums[k] > want[k]
		}
	}
	return true
}
