package health

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"syscall"
	"time"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

// Target is the instance a probe runs against.
type Target struct {
	ContainerID string
	// Address is the container's IP on the project network.
	Address string
}

// Result is the outcome of one probe.
type Result struct {
	Healthy bool
	// Output explains a failure (HTTP status, command output, dial error),
	// truncated to 4 KiB.
	Output string
	// Starting: no verdict yet (Docker's check of the image's HEALTHCHECK
	// is still starting). A Watch keeps its state.
	Starting bool
	// Final: the failure is Docker's verdict, the image's retries already
	// counted. A Watch takes it at once.
	Final bool
	// refused: a TCP check's connection was refused (nothing listens on
	// the port).
	refused bool
}

// Prober runs health checks.
type Prober interface {
	// Probe runs the check once. A nil check means the default TCP check on
	// the first TCP port of ports, or healthy when there are none. So does
	// an image check (HealthCheck.image): its verdict is Docker's, which
	// reconcile reads from the container itself (FromDocker); a prober only
	// gets it where the address matters (a container moving to another
	// project's network).
	Probe(ctx context.Context, target Target, check *agentv1.HealthCheck, ports []*agentv1.PortSpec) Result
	// WaitHealthy probes until a probe passes, or ctx ends (the caller sets
	// the deploy health timeout on ctx). The error carries the last
	// failure's output; it is a *NotListeningError when the default check
	// was refused on every try until ctx's deadline.
	WaitHealthy(ctx context.Context, target Target, check *agentv1.HealthCheck, ports []*agentv1.PortSpec) error
}

// Execer runs a command in a container; docker.Engine implements it.
type Execer interface {
	ExecRunner(ctx context.Context, containerID string, cmd []string, maxOutput int) (exitCode int, output []byte, err error)
}

// ExecFunc adapts a function to Execer.
type ExecFunc func(ctx context.Context, containerID string, cmd []string, maxOutput int) (int, []byte, error)

// ExecRunner calls f.
func (f ExecFunc) ExecRunner(ctx context.Context, containerID string, cmd []string, maxOutput int) (int, []byte, error) {
	return f(ctx, containerID, cmd, maxOutput)
}

// Defaults from the HealthCheck message.
const (
	DefaultInterval  = 10 * time.Second
	DefaultTimeout   = 5 * time.Second
	DefaultThreshold = 3
	maxOutput        = 4 << 10
)

// ErrNeverHealthy is returned by WaitHealthy when ctx ended first.
var ErrNeverHealthy = errors.New("health check never passed")

// NotListeningError is WaitHealthy's error (it wraps ErrNeverHealthy) when
// the default check, TCP on the first port of a service without a health
// check of its own, had its connection refused on every try until ctx's
// deadline: nothing in the container listens on Port. A background worker
// with the port new app services get (80) fails its deploy this way.
type NotListeningError struct {
	Port uint32
	// Last is the last refused probe's output.
	Last string
}

func (e *NotListeningError) Error() string { return ErrNeverHealthy.Error() + ": " + e.Last }

func (e *NotListeningError) Unwrap() error { return ErrNeverHealthy }

// NewProber returns a Prober. exec may be nil when command probes are not
// needed (they then fail with a clear message).
func NewProber(exec Execer) *Probes {
	return &Probes{exec: exec, PollEvery: time.Second}
}

// Probes is the Prober implementation.
type Probes struct {
	exec Execer
	// PollEvery bounds the wait between probes in WaitHealthy, so a deploy
	// notices health within a second even with a long interval.
	PollEvery time.Duration
	// dial opens TCP checks' connections; nil is a net.Dialer (tests set a
	// fake).
	dial func(ctx context.Context, network, address string) (net.Conn, error)
}

var _ Prober = (*Probes)(nil)

// Timeout returns the per-probe timeout of check.
func Timeout(check *agentv1.HealthCheck) time.Duration {
	if d := check.GetTimeout().AsDuration(); d > 0 {
		return d
	}
	return DefaultTimeout
}

// Interval returns the probe interval of check.
func Interval(check *agentv1.HealthCheck) time.Duration {
	if d := check.GetInterval().AsDuration(); d > 0 {
		return d
	}
	return DefaultInterval
}

// Threshold returns the consecutive failures that make an instance unhealthy.
func Threshold(check *agentv1.HealthCheck) int {
	if n := check.GetFailureThreshold(); n > 0 {
		return int(n)
	}
	return DefaultThreshold
}

// FirstTCPPort returns the first TCP container port, or 0.
func FirstTCPPort(ports []*agentv1.PortSpec) uint32 {
	for _, p := range ports {
		if p.GetProtocol() != agentv1.PortProtocol_PORT_PROTOCOL_UDP && p.GetContainerPort() > 0 {
			return p.GetContainerPort()
		}
	}
	return 0
}

func (p *Probes) Probe(ctx context.Context, target Target, check *agentv1.HealthCheck, ports []*agentv1.PortSpec) Result {
	ctx, cancel := context.WithTimeout(ctx, Timeout(check))
	defer cancel()
	switch probe := check.GetProbe().(type) {
	case *agentv1.HealthCheck_Http:
		return p.http(ctx, target, probe.Http, ports)
	case *agentv1.HealthCheck_Command:
		return p.command(ctx, target, probe.Command)
	case *agentv1.HealthCheck_Tcp:
		port := probe.Tcp.GetPort()
		if port == 0 {
			port = FirstTCPPort(ports)
		}
		return p.tcp(ctx, target, port)
	default:
		port := FirstTCPPort(ports)
		if port == 0 {
			return Result{Healthy: true}
		}
		return p.tcp(ctx, target, port)
	}
}

// defaultPort is the port of the default check (no probe set: TCP on the
// first TCP port), 0 for a check of the service's own or one without
// ports.
func defaultPort(check *agentv1.HealthCheck, ports []*agentv1.PortSpec) uint32 {
	if check.GetProbe() != nil {
		return 0
	}
	return FirstTCPPort(ports)
}

func (p *Probes) tcp(ctx context.Context, target Target, port uint32) Result {
	if port == 0 {
		return Result{Output: "tcp check: no port to check"}
	}
	if target.Address == "" {
		return Result{Output: "tcp check: the container has no address yet"}
	}
	dial := p.dial
	if dial == nil {
		var d net.Dialer
		dial = d.DialContext
	}
	conn, err := dial(ctx, "tcp", net.JoinHostPort(target.Address, strconv.Itoa(int(port))))
	if err != nil {
		return Result{Output: truncate(fmt.Sprintf("tcp check on port %d: %v", port, err)), refused: errors.Is(err, syscall.ECONNREFUSED)}
	}
	_ = conn.Close()
	return Result{Healthy: true}
}

// httpClient never follows redirects: a 3xx already proves the app is up.
var httpClient = &http.Client{
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	Transport: &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
	},
}

func (p *Probes) http(ctx context.Context, target Target, h *agentv1.HttpProbe, ports []*agentv1.PortSpec) Result {
	port := h.GetPort()
	if port == 0 {
		port = FirstTCPPort(ports)
	}
	if port == 0 {
		return Result{Output: "http check: no port to check"}
	}
	if target.Address == "" {
		return Result{Output: "http check: the container has no address yet"}
	}
	path := h.GetPath()
	if path == "" || path[0] != '/' {
		path = "/" + path
	}
	url := "http://" + net.JoinHostPort(target.Address, strconv.Itoa(int(port))) + path
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Result{Output: truncate("http check: " + err.Error())}
	}
	if h.GetHost() != "" {
		req.Host = h.GetHost()
	}
	req.Header.Set("User-Agent", "seylo-health/1")
	resp, err := httpClient.Do(req)
	if err != nil {
		return Result{Output: truncate(fmt.Sprintf("http check GET %s: %v", path, err))}
	}
	_ = resp.Body.Close()
	ok := resp.StatusCode >= 200 && resp.StatusCode < 400
	if want := h.GetExpectedStatus(); want != 0 {
		ok = uint32(resp.StatusCode) == want
	}
	if !ok {
		return Result{Output: fmt.Sprintf("http check GET %s: status %d", path, resp.StatusCode)}
	}
	return Result{Healthy: true}
}

func (p *Probes) command(ctx context.Context, target Target, c *agentv1.CommandProbe) Result {
	if len(c.GetCommand()) == 0 {
		return Result{Output: "command check: empty command"}
	}
	if p.exec == nil {
		return Result{Output: "command check: exec is not available"}
	}
	code, out, err := p.exec.ExecRunner(ctx, target.ContainerID, c.GetCommand(), maxOutput)
	if err != nil {
		return Result{Output: truncate(fmt.Sprintf("command check: %v", err))}
	}
	if code != 0 {
		return Result{Output: truncate(fmt.Sprintf("command check exited %d: %s", code, out))}
	}
	return Result{Healthy: true}
}

func (p *Probes) WaitHealthy(ctx context.Context, target Target, check *agentv1.HealthCheck, ports []*agentv1.PortSpec) error {
	every := min(Interval(check), p.PollEvery)
	if every <= 0 {
		every = time.Second
	}
	last := ""
	// Whether the default check was refused on every try that ran to its
	// end (one that ctx's end cut short says nothing).
	port := defaultPort(check, ports)
	refusedAll, lastRefused := port != 0, ""
	for {
		r := p.Probe(ctx, target, check, ports)
		if r.Healthy {
			return nil
		}
		last = r.Output
		if ctx.Err() == nil {
			refusedAll = refusedAll && r.refused
			if r.refused {
				lastRefused = r.Output
			}
		}
		select {
		case <-ctx.Done():
			if refusedAll && lastRefused != "" && errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return &NotListeningError{Port: port, Last: lastRefused}
			}
			if last == "" {
				return ErrNeverHealthy
			}
			return fmt.Errorf("%w: %s", ErrNeverHealthy, last)
		case <-time.After(every):
		}
	}
}

func truncate(s string) string {
	if len(s) > maxOutput {
		return s[:maxOutput]
	}
	return s
}
