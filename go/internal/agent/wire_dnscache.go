package agent

// DNS cache wiring: the node's DNS cache for containers (dnscache), on
// when NodeSettings.dns_cache says so. Provided right after the runtime,
// so reconcile and jobrun read d.DNSCache when they create containers.

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
	"github.com/seylo-dev/app/go/internal/dnscache"
	"github.com/seylo-dev/app/go/internal/docker"
	"github.com/seylo-dev/app/go/internal/nodecheck"
	"github.com/seylo-dev/app/go/internal/registry"
	"github.com/seylo-dev/app/go/internal/rpc"
)

// DNSCache is the node's DNS cache as the other areas use it: the DNS a
// container created now gets.
type DNSCache interface {
	ContainerDNS() docker.ContainerDNS
}

// prepareTimeout bounds bringing the cache up before the agent starts any
// container.
const prepareTimeout = 10 * time.Second

// bridgeLister lists Docker's bridge subnets (docker.Moby).
type bridgeLister interface {
	BridgeSubnets(ctx context.Context) ([]netip.Prefix, error)
}

// provideDNSCache: set d.DNSCache.
func provideDNSCache(d *Deps) error {
	log := d.Logger
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	log = log.With("component", "dns-cache")
	addr := dnscache.DefaultAddress
	if d.Config.DNSCacheAddress != "" {
		a, err := dnsCacheAddress(d.Config.DNSCacheAddress)
		if err != nil {
			return fmt.Errorf("dns_cache_address: %w", err)
		}
		addr = a
	}
	env := nodecheck.Env{DataDir: d.Layout.Root()}
	dockerDNS := nodecheck.DockerDNSSetting(env)
	opts := dnscache.ManagerOptions{
		Address: addr,
		Link:    dnscache.Link{Run: combinedOutput, LookPath: func(name string) bool { _, err := exec.LookPath(name); return err == nil }},
		Sources: func(ctx context.Context) dnscache.Sources {
			return dnscache.Sources{
				Docker:     dockerDNS(ctx),
				ResolvConf: readText("/etc/resolv.conf"),
				Resolved:   readText("/run/systemd/resolve/resolv.conf"),
			}
		},
		Probe:     nodecheck.ProbeDNSCache(env),
		HostNames: func() []string { return dnsCacheTestNames(d) },
		Alert: func(ctx context.Context, raised bool, message string) {
			dnsCacheAlert(ctx, d, log, raised, message)
		},
		Marker:    filepath.Join(d.Layout.NetworkDir(), "dns-cache-in-use"),
		PortTaken: filepath.Join(d.Layout.NetworkDir(), "dns-cache-port-taken"),
		Holder: func(ctx context.Context, port int) string {
			out, err := combinedOutput(ctx, "ss", "-H", "-lunp", fmt.Sprintf("sport = :%d", port))
			if err != nil {
				return ""
			}
			return dnscache.WildcardHolder(out, port)
		},
		Logger: log,
	}
	if d.Docker != nil {
		opts.Containers = func(ctx context.Context) ([]dnscache.Container, error) { return dnsCacheContainers(ctx, d.Docker) }
		if b, ok := d.Docker.(bridgeLister); ok {
			opts.Subnets = b.BridgeSubnets
		}
	}
	d.DNSCache = dnscache.NewManager(opts)
	return nil
}

// wireDNSCache brings the cache up before any container starts when it is
// on (or containers from before use it), follows NodeSettings.dns_cache,
// runs the cache as a component and registers GetDnsCacheStatus.
func wireDNSCache(reg *Registry, d *Deps) error {
	m, ok := d.DNSCache.(*dnscache.Manager)
	if !ok {
		// Tests replaced it; nothing of ours to run.
		return nil
	}
	// Components start after wiring, reconcile's included: the address
	// and listener come first.
	ctx, cancel := context.WithTimeout(context.Background(), prepareTimeout)
	m.Prepare(ctx, feedSettings(d).GetDnsCache().GetEnabled())
	cancel()
	if d.Feed != nil {
		d.Feed.Subscribe(func(s *agentv1.DesiredState) {
			m.SetEnabled(s.GetSettings().GetDnsCache().GetEnabled())
		})
	}
	d.Components.Add("dns-cache", m.Run)
	rpc.HandleUnary(reg, "GetDnsCacheStatus", func(ctx context.Context, _ *agentv1.GetDnsCacheStatusRequest) (*agentv1.GetDnsCacheStatusResponse, error) {
		return m.Status(ctx), nil
	})
	return nil
}

// dnsCacheAddress checks config.yml's dns_cache_address.
func dnsCacheAddress(s string) (netip.Addr, error) {
	a, err := netip.ParseAddr(s)
	switch {
	case err != nil:
		return netip.Addr{}, fmt.Errorf("%q is not an IP address", s)
	case !a.Is4():
		return netip.Addr{}, fmt.Errorf("%s is not an IPv4 address (Seylo's networks are IPv4)", a)
	case a.IsLoopback() || a.IsUnspecified() || a.IsMulticast() || a == netip.AddrFrom4([4]byte{255, 255, 255, 255}):
		return netip.Addr{}, fmt.Errorf("%s cannot be the DNS cache's address: in a container it is not the host", a)
	}
	return a, nil
}

// dnsCacheContainers are our containers that can use the cache, running
// or not (an exited one with the cache starts again as the same
// container, so it keeps the address up); not dead ones, and not the
// panel, Traefik or the registry, which keep Docker's DNS.
func dnsCacheContainers(ctx context.Context, eng docker.Engine) ([]dnscache.Container, error) {
	list, err := eng.ListContainers(ctx, nil)
	if err != nil {
		return nil, err
	}
	var out []dnscache.Container
	for _, c := range list {
		if c.State == agentv1.InstanceState_INSTANCE_STATE_DEAD {
			continue
		}
		role := c.Labels[docker.LabelRole]
		if role == "traefik" || role == registry.RoleRegistry || docker.IsPanelService(c.Labels[docker.LabelService], c.Labels[docker.LabelProtected] == "true") {
			continue
		}
		kind := role
		if kind == "" {
			kind = "service"
		}
		out = append(out, dnscache.Container{
			Name: c.Name, ServiceID: c.Labels[docker.LabelService], Kind: kind,
			UsesCache: docker.UsesDNSCache(c.Labels), Running: c.State == agentv1.InstanceState_INSTANCE_STATE_RUNNING, Created: c.Created,
		})
	}
	return out, nil
}

// dnsCacheTestNames are the names the host-side test resolves: the
// panel's host when it is a name, then a public one.
func dnsCacheTestNames(d *Deps) []string {
	var names []string
	panelURL, _ := panelAddress(d)
	if u, err := url.Parse(panelURL); err == nil {
		if h := u.Hostname(); h != "" && net.ParseIP(h) == nil {
			names = append(names, h)
		}
	}
	return append(names, "github.com")
}

// dnsCacheAlert raises or resolves NODE_ALERT_KIND_DNS_CACHE.
func dnsCacheAlert(ctx context.Context, d *Deps, log *slog.Logger, raised bool, message string) {
	if d.Reports == nil {
		return
	}
	alert := &agentv1.NodeAlert{Kind: agentv1.NodeAlertKind_NODE_ALERT_KIND_DNS_CACHE, Severity: agentv1.AlertSeverity_ALERT_SEVERITY_WARNING, Message: message, Resolved: !raised}
	if !raised {
		alert.Severity = agentv1.AlertSeverity_ALERT_SEVERITY_INFO
	}
	if err := d.Reports.Event(context.WithoutCancel(ctx), &agentv1.Event{Payload: &agentv1.Event_NodeAlert{NodeAlert: alert}}); err != nil {
		log.Error("queueing the DNS cache alert", "err", err)
	}
}

// combinedOutput runs a command and returns what it printed (stdout and
// stderr), for ip and ss.
func combinedOutput(ctx context.Context, name string, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return string(out), err
}

func readText(path string) string {
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return ""
	}
	return string(b)
}
