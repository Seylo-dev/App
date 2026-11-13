package health

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"google.golang.org/protobuf/types/known/durationpb"

	agentv1 "github.com/seylo-dev/app/go/gen/pb/seylo/agent/v1"
)

func hostPort(t *testing.T, addr string) (string, uint32) {
	t.Helper()
	h, p, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	n, _ := strconv.Atoi(p)
	return h, uint32(n)
}

func tcpPorts(p uint32) []*agentv1.PortSpec {
	return []*agentv1.PortSpec{{ContainerPort: p, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_TCP}}
}

func TestDefaultChecks(t *testing.T) {
	p := NewProber(nil)
	ctx := context.Background()
	if r := p.Probe(ctx, Target{}, nil, nil); !r.Healthy {
		t.Fatal("a service without ports and checks is healthy once running")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, ln.Addr().String())
	if r := p.Probe(ctx, Target{Address: host}, nil, tcpPorts(port)); !r.Healthy {
		t.Fatalf("tcp default: %+v", r)
	}
	_ = ln.Close()
	r := p.Probe(ctx, Target{Address: host}, nil, tcpPorts(port))
	if r.Healthy || !strings.Contains(r.Output, "tcp check") {
		t.Fatalf("closed port: %+v", r)
	}
	// UDP ports are skipped by the default check.
	udp := []*agentv1.PortSpec{{ContainerPort: 53, Protocol: agentv1.PortProtocol_PORT_PROTOCOL_UDP}}
	if r := p.Probe(ctx, Target{Address: host}, nil, udp); !r.Healthy {
		t.Fatal("udp-only service should count as healthy")
	}
}

func TestHTTPProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/ok":
			if r.Host != "app.test" {
				w.WriteHeader(400)
				return
			}
			w.WriteHeader(204)
		case "/redirect":
			http.Redirect(w, r, "/elsewhere", http.StatusFound)
		default:
			w.WriteHeader(503)
		}
	}))
	defer srv.Close()
	host, port := hostPort(t, srv.Listener.Addr().String())
	p := NewProber(nil)
	check := func(path string, want uint32) *agentv1.HealthCheck {
		return &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Http{Http: &agentv1.HttpProbe{Port: port, Path: path, Host: "app.test", ExpectedStatus: want}}}
	}
	ctx := context.Background()
	tg := Target{Address: host}
	if r := p.Probe(ctx, tg, check("/ok", 0), nil); !r.Healthy {
		t.Fatalf("/ok: %+v", r)
	}
	if r := p.Probe(ctx, tg, check("/redirect", 0), nil); !r.Healthy {
		t.Fatalf("3xx should pass: %+v", r)
	}
	if r := p.Probe(ctx, tg, check("/redirect", 200), nil); r.Healthy {
		t.Fatal("expected_status 200 must reject 302")
	}
	if r := p.Probe(ctx, tg, check("/down", 0), nil); r.Healthy || !strings.Contains(r.Output, "503") {
		t.Fatalf("/down: %+v", r)
	}
}

func TestCommandProbe(t *testing.T) {
	var got []string
	p := NewProber(ExecFunc(func(ctx context.Context, id string, cmd []string, max int) (int, []byte, error) {
		got = cmd
		if id != "c1" {
			return -1, nil, errors.New("wrong container")
		}
		if cmd[0] == "fail" {
			return 2, []byte("nope"), nil
		}
		return 0, nil, nil
	}))
	ctx := context.Background()
	cmd := func(c ...string) *agentv1.HealthCheck {
		return &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Command{Command: &agentv1.CommandProbe{Command: c}}}
	}
	if r := p.Probe(ctx, Target{ContainerID: "c1"}, cmd("true"), nil); !r.Healthy || got[0] != "true" {
		t.Fatalf("true: %+v", r)
	}
	if r := p.Probe(ctx, Target{ContainerID: "c1"}, cmd("fail"), nil); r.Healthy || !strings.Contains(r.Output, "exited 2: nope") {
		t.Fatalf("fail: %+v", r)
	}
	if r := NewProber(nil).Probe(ctx, Target{}, cmd("x"), nil); r.Healthy {
		t.Fatal("command probe without exec must fail")
	}
}

func TestWaitHealthy(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, ln.Addr().String())
	_ = ln.Close()
	p := NewProber(nil)
	p.PollEvery = 20 * time.Millisecond

	// Comes up after a moment.
	go func() {
		time.Sleep(100 * time.Millisecond)
		l, err := net.Listen("tcp", ln.Addr().String())
		if err == nil {
			t.Cleanup(func() { _ = l.Close() })
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := p.WaitHealthy(ctx, Target{Address: host}, nil, tcpPorts(port)); err != nil {
		t.Fatal(err)
	}

	// Never comes up.
	ctx2, cancel2 := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel2()
	err = p.WaitHealthy(ctx2, Target{Address: host}, nil, tcpPorts(1))
	if !errors.Is(err, ErrNeverHealthy) || !strings.Contains(err.Error(), "tcp check") {
		t.Fatalf("err = %v", err)
	}
}

func TestWatch(t *testing.T) {
	start := time.Unix(1000, 0)
	check := &agentv1.HealthCheck{FailureThreshold: 2, StartPeriod: durationpb.New(10 * time.Second)}
	w := NewWatch(check, start)
	fail := Result{Output: "down"}
	ok := Result{Healthy: true}
	if _, changed := w.Observe(fail, start.Add(time.Second)); changed || w.State() != agentv1.HealthState_HEALTH_STATE_STARTING {
		t.Fatal("failures in the start period must not count")
	}
	w.Observe(fail, start.Add(11*time.Second))
	if w.State() != agentv1.HealthState_HEALTH_STATE_STARTING {
		t.Fatal("one failure is below the threshold")
	}
	prev, changed := w.Observe(fail, start.Add(12*time.Second))
	if !changed || prev != agentv1.HealthState_HEALTH_STATE_STARTING || w.State() != agentv1.HealthState_HEALTH_STATE_UNHEALTHY {
		t.Fatalf("state %v", w.State())
	}
	if _, changed := w.Observe(ok, start.Add(13*time.Second)); !changed || w.State() != agentv1.HealthState_HEALTH_STATE_HEALTHY {
		t.Fatal("a pass makes it healthy")
	}
	w.Observe(fail, start.Add(14*time.Second))
	if w.State() != agentv1.HealthState_HEALTH_STATE_HEALTHY || w.LastOutput != "down" {
		t.Fatal("one failure after healthy keeps it healthy")
	}
}

// closedPort is a 127.0.0.1 port nothing listens on: a dial is refused.
func closedPort(t *testing.T) (string, uint32) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	host, port := hostPort(t, ln.Addr().String())
	_ = ln.Close()
	return host, port
}

// A background worker with the port new app services get: the default
// check (no health check of its own, TCP on the first port) is refused on
// every try until the health timeout. WaitHealthy says so with a
// *NotListeningError, which the deploy turns into its hint; any other way
// of failing keeps the plain error.
func TestWaitHealthyNotListening(t *testing.T) {
	ctx := func(d time.Duration) context.Context {
		c, cancel := context.WithTimeout(context.Background(), d)
		t.Cleanup(cancel)
		return c
	}
	p := NewProber(nil)
	p.PollEvery = 20 * time.Millisecond

	host, port := closedPort(t)
	tg := Target{Address: host}
	// Every try is refused at once, so the window only has to hold a few tries,
	// also on a loaded machine (150ms was too short for the first dial there).
	err := p.WaitHealthy(ctx(750*time.Millisecond), tg, nil, tcpPorts(port))
	var nl *NotListeningError
	if !errors.As(err, &nl) || nl.Port != port || !errors.Is(err, ErrNeverHealthy) ||
		!strings.Contains(err.Error(), "health check never passed: tcp check on port "+strconv.Itoa(int(port))+": dial tcp") ||
		!strings.HasSuffix(err.Error(), "connect: connection refused") {
		t.Fatalf("refused all along: %#v %v", err, err)
	}
	// A health check that sets only timings keeps the default probe.
	timings := &agentv1.HealthCheck{Timeout: durationpb.New(time.Second)}
	if err := p.WaitHealthy(ctx(750*time.Millisecond), tg, timings, tcpPorts(port)); !errors.As(err, &nl) {
		t.Fatalf("default probe with timings: %v", err)
	}

	// Refused at first, then the app listens: healthy, no error at all.
	go func() {
		time.Sleep(80 * time.Millisecond)
		if l, err := net.Listen("tcp", net.JoinHostPort(host, strconv.Itoa(int(port)))); err == nil {
			t.Cleanup(func() { _ = l.Close() })
		}
	}()
	if err := p.WaitHealthy(ctx(3*time.Second), tg, nil, tcpPorts(port)); err != nil {
		t.Fatalf("refused, then listening: %v", err)
	}

	host, port = closedPort(t)
	tg = Target{Address: host}
	plain := func(name string, err error) {
		t.Helper()
		if !errors.Is(err, ErrNeverHealthy) || errors.As(err, &nl) {
			t.Errorf("%s: %#v %v, want a plain ErrNeverHealthy", name, err, err)
		}
	}
	// A TCP check of the service's own: it chose the port.
	own := &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Tcp{Tcp: &agentv1.TcpProbe{}}}
	plain("own tcp check", p.WaitHealthy(ctx(150*time.Millisecond), tg, own, tcpPorts(port)))
	// HTTP and command checks.
	httpCheck := &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Http{Http: &agentv1.HttpProbe{Path: "/"}}}
	plain("http check", p.WaitHealthy(ctx(150*time.Millisecond), tg, httpCheck, tcpPorts(port)))
	cmd := &agentv1.HealthCheck{Probe: &agentv1.HealthCheck_Command{Command: &agentv1.CommandProbe{Command: []string{"true"}}}}
	plain("command check", p.WaitHealthy(ctx(150*time.Millisecond), Target{ContainerID: "c1"}, cmd, tcpPorts(port)))
	// Cancelled (a newer deploy, the agent stopping), not timed out.
	cctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	plain("cancelled", p.WaitHealthy(cctx, tg, nil, tcpPorts(port)))

	// Dials that time out (a firewall dropping packets, a wedged app): all
	// along, or after some refusals.
	timedOut := NewProber(nil)
	timedOut.PollEvery = 10 * time.Millisecond
	var calls, refuseFirst atomic.Int32
	timedOut.dial = func(ctx context.Context, network, _ string) (net.Conn, error) {
		if calls.Add(1) <= refuseFirst.Load() {
			return nil, &net.OpError{Op: "dial", Net: network, Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
		}
		<-ctx.Done()
		return nil, &net.OpError{Op: "dial", Net: network, Err: os.ErrDeadlineExceeded}
	}
	short := &agentv1.HealthCheck{Timeout: durationpb.New(20 * time.Millisecond)}
	plain("timeouts", timedOut.WaitHealthy(ctx(200*time.Millisecond), Target{Address: "10.0.0.9"}, short, tcpPorts(80)))
	calls.Store(0)
	refuseFirst.Store(3)
	plain("refused, then timeouts", timedOut.WaitHealthy(ctx(300*time.Millisecond), Target{Address: "10.0.0.9"}, short, tcpPorts(80)))
	if calls.Load() <= 3 {
		t.Fatalf("only %d dials", calls.Load())
	}
	// The fake's refusals alone read like the real ones.
	calls.Store(0)
	refuseFirst.Store(1 << 30)
	if err := timedOut.WaitHealthy(ctx(100*time.Millisecond), Target{Address: "10.0.0.9"}, short, tcpPorts(80)); !errors.As(err, &nl) || nl.Port != 80 {
		t.Fatalf("the fake refusing all along: %v", err)
	}
}
